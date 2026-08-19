//! Several statements as one unit of work.
//!
//! A statement written on its own already runs in a transaction of its
//! own, so this is not what makes a write atomic. What it holds is the
//! span: two statements are one unit, and the file keeps the state they
//! started from until one word or the other ends them.
//!
//! ```js
//! await using tx = await conn.transaction()
//! await conn.exec('INSERT (a:account {uid: 1, balance: 100})')
//! await conn.exec('INSERT (b:account {uid: 2, balance: 0})')
//! await tx.commit()
//! ```
//!
//! The `await using` is the whole reason this is a class rather than a
//! pair of methods, and what it adds is the rollback nobody remembers to
//! write: a transaction that leaves its scope without having been
//! committed is undone, whether it was a `throw`, a `return` out of the
//! middle, or a branch that forgot.
//!
//! That is the opposite of what the Python client's `with` block does,
//! and the difference is in the language rather than in the database. A
//! Python context manager is handed the exception that is unwinding
//! through it, so it can commit when the block ended well and roll back
//! when it did not. A JavaScript disposal is told nothing at all. So a
//! disposal that committed would commit half the work of a block that
//! failed, which is the one thing a transaction exists to prevent, and
//! the commit has to be the word the caller writes.
//!
//! The three statements underneath are `START TRANSACTION`, `COMMIT` and
//! `ROLLBACK`, and a caller who would rather write them can, on this
//! connection, today. What this adds is the undo, and a name for the
//! state, so a program can ask whether it is inside one rather than
//! remembering.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use napi_derive::napi;

use crate::conn::{Failure, failed, wire_disposal, with};

/// A transaction that has been started and not yet ended.
///
/// Take one with `Connection.transaction`. It starts when it is taken,
/// so a transaction that cannot start says so at the line that asked,
/// and the statements that run inside it are the ones written on the
/// connection it came from.
#[napi]
pub struct Transaction {
    /// The same connection the statements inside the transaction run on,
    /// held by the same two handles every other statement uses rather
    /// than by a reference to the JavaScript object, so that a
    /// transaction whose `Connection` was collected still has something
    /// to commit.
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    read_only: bool,
    /// Whether a `COMMIT` or a `ROLLBACK` has already run here. Shared
    /// with the tasks, because the word that ends a transaction is a
    /// statement and every statement here happens off the event loop.
    done: Arc<AtomicBool>,
}

#[napi]
impl Transaction {
    /// Whether this transaction was started `READ ONLY`, which the
    /// engine refuses a write inside of at the statement that writes.
    #[napi(getter)]
    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Whether this transaction has already been committed or rolled
    /// back.
    #[napi(getter)]
    pub fn done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    /// Ends the transaction and keeps what it wrote.
    ///
    /// Doing it twice is refused rather than ignored. A second commit is
    /// a program that has lost track of where its transaction ends, and
    /// the statements between the two are in neither of them.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn commit(&self) -> AsyncTask<EndTask> {
        self.end(Word::Commit)
    }

    /// Ends the transaction and throws away what it wrote.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn rollback(&self) -> AsyncTask<EndTask> {
        self.end(Word::Rollback)
    }

    /// The undo `await using` calls, which is the intended way to scope
    /// a transaction.
    ///
    /// It rolls back, and it does nothing at all when the transaction
    /// has already ended, which is what makes a committed block and a
    /// failed one both leave through here without saying anything.
    ///
    /// It is also reachable as `Symbol.asyncDispose`, which is what
    /// `await using` actually looks for and which [`wire_disposal`] puts
    /// on every transaction as it is made.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn dispose(&self) -> AsyncTask<EndTask> {
        self.end(Word::Dispose)
    }

    fn end(&self, word: Word) -> AsyncTask<EndTask> {
        AsyncTask::new(EndTask {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
            done: Arc::clone(&self.done),
            word,
        })
    }
}

/// What a transaction is being ended with.
enum Word {
    Commit,
    Rollback,
    /// A rollback that has nothing to say about a transaction which has
    /// already ended, because leaving the scope of a committed
    /// transaction is the ordinary way one ends.
    Dispose,
}

impl Word {
    fn statement(&self) -> &'static str {
        match self {
            Word::Commit => "COMMIT",
            Word::Rollback | Word::Dispose => "ROLLBACK",
        }
    }
}

/// Starting one, which is the statement that starts one.
pub struct StartTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    read_only: bool,
    /// Why this is not going to run, when it is not.
    refused: Option<String>,
}

impl StartTask {
    pub(crate) fn new(
        inner: Arc<Mutex<Option<zudb::Connection>>>,
        alive: Arc<AtomicBool>,
        in_txn: Arc<AtomicBool>,
        read_only: bool,
        refused: Option<String>,
    ) -> StartTask {
        StartTask {
            inner,
            alive,
            in_txn,
            read_only,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for StartTask {
    type Output = std::result::Result<(), Failure>;
    type JsValue = ClassInstance<'task, Transaction>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        // `READ ONLY` is the engine's own spelling and it is enforced at
        // the statement that writes rather than here, which is why this
        // is two statements and not two code paths.
        let statement = match self.read_only {
            true => "START TRANSACTION READ ONLY",
            false => "START TRANSACTION",
        };
        Ok(with(&self.inner, &self.alive, &self.in_txn, |conn| {
            conn.query(statement).map(|_| ()).map_err(Failure::from)
        }))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| failed(env, failure, None))?;
        let mut instance = Transaction {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
            read_only: self.read_only,
            done: Arc::new(AtomicBool::new(false)),
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance, "dispose")?;
        Ok(instance)
    }
}

/// Ending one, with whichever of the two words was asked for.
pub struct EndTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    word: Word,
}

impl<'task> ScopedTask<'task> for EndTask {
    type Output = std::result::Result<(), Failure>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        // Claimed before the statement runs rather than after it, so
        // that two commits issued together cannot both find the
        // transaction open and both run. The claim is given back below
        // when the statement did not go through.
        if self
            .done
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(match self.word {
                Word::Dispose => Ok(()),
                _ => Err(Failure::Usage(ENDED.to_string())),
            });
        }
        // A connection closed while a transaction was open took the
        // transaction with it, unwritten, so leaving the scope of one
        // has nothing left to undo. Only for a disposal: a caller who
        // wrote `rollback()` by hand is asking a question and is owed
        // the answer that the connection is gone.
        if matches!(self.word, Word::Dispose) && !self.alive.load(Ordering::Acquire) {
            return Ok(Ok(()));
        }
        let statement = self.word.statement();
        let answered = with(&self.inner, &self.alive, &self.in_txn, |conn| {
            conn.query(statement).map(|_| ()).map_err(Failure::from)
        });
        if answered.is_err() {
            // Given back, so a commit the engine refused leaves a
            // transaction the caller can still roll back rather than one
            // that is neither open nor ended.
            self.done.store(false, Ordering::Release);
        }
        Ok(answered)
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| failed(env, failure, None))
    }
}

/// What a second `commit()` or `rollback()` says.
const ENDED: &str = "this transaction has already ended, and the statements after it \
     belong to no transaction of yours";
