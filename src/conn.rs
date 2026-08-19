//! The connection and what a statement gives back.
//!
//! Nothing here runs on the event loop. Every engine call is a task on
//! libuv's threadpool, which is what the `AsyncTask` type is, and the
//! JavaScript side gets a promise back before the statement has
//! started. A synchronous native call in a server is a production
//! incident (ADR 0002), so there is no synchronous variant of a
//! statement in this file and the ones that arrive later will say in
//! their own doc comments that they belong in a script.
//!
//! A connection is not thread-safe in the engine and every method
//! takes `&mut self` there, so the one held here sits behind a mutex.
//! That is not a way of making a connection concurrent: a statement
//! holds the mutex for as long as it runs, and two statements that
//! should overlap want two connections. It is there so that a program
//! which shares one by accident waits rather than corrupts.
//!
//! Waits, except behind a stream. A stream ends when its reader says
//! so, so a statement that queued behind a half-read one would be
//! waiting for the caller who is waiting for it, and a program that
//! stops is worse than a program that is told no. A stream takes the
//! connection out of the slot instead of locking it, and the next
//! statement finds the slot empty and says [`STREAMING`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask, ValueType};
use napi_derive::napi;
use zudb::query::{QueryResult, Value};
use zudb::{Config, Database, DiagnosticRecord, Interrupt, ZuError};

use crate::append::OpenTask;
use crate::cancel::Watch;
use crate::columns::ColumnsTask;
use crate::error::{aborted, raise, usage};
use crate::plan::{PlanTask, ProfileTask};
use crate::prepared::PrepareTask;
use crate::register::{self, RegisterTask, RegisteredTask, UnregisterTask};
use crate::stream::{self, Started, ZuCursor};
use crate::temporal;
use crate::txn::StartTask;
use crate::value::{Ints, Shape, Spelling, from_js, to_js};

/// What a connection can be opened with.
///
/// Every field is optional and every default is the engine's, because
/// a client that invents its own defaults is a client whose numbers
/// have to be found and changed twice.
#[napi(object)]
pub struct ConnectOptions {
    /// Opens without creating and refuses every statement that writes.
    /// A read-only connection never creates a database, so a mistyped
    /// path is an error here rather than an empty database.
    pub read_only: Option<bool>,
    /// How much memory the executor may hold, in bytes.
    pub memory_limit: Option<BigInt>,
    /// How many threads the executor may use.
    pub threads: Option<u32>,
    /// How INT64 comes back, for every statement on this connection.
    /// `bigint` unless it is said otherwise here, and a statement may
    /// say otherwise again for itself.
    #[napi(ts_type = "ZuBigIntMode")]
    pub big_int_mode: Option<String>,
    /// Gives back `Temporal` values rather than this client's four
    /// temporal classes, for every statement on this connection.
    ///
    /// Refused here, when the runtime has no `Temporal`, rather than at
    /// the first row that happens to hold a date: a program that asked
    /// for this and was quietly given something else would find out on
    /// the one code path its tests did not cover. Node 26 and the
    /// current browsers have `Temporal`, Node 24 has it behind
    /// `--harmony-temporal`, and a program that cannot be sure of its
    /// runtime uses `toTemporal()` on the value it wants instead.
    ///
    /// On the connection and not on a statement, because both spellings
    /// are exact and a program picks the one it wants to read for as
    /// long as it lives, where `bigIntMode` is a trade a single query
    /// makes.
    ///
    /// A time with an offset keeps its class either way, because
    /// `Temporal` has no type for one.
    pub temporal: Option<bool>,
}

/// One connection to one database.
///
/// Statements run on it in order, one at a time. It reads the database
/// as of when it was opened, which is why a program that wants to see
/// another writer's work takes a new connection rather than waiting on
/// this one.
#[napi]
pub struct Connection {
    /// `None` once closed, which is what makes a second `close()` do
    /// nothing and a statement after one an error rather than a crash.
    ///
    /// Counted rather than plain, because the threadpool thread a
    /// statement runs on takes a share of it: the task outlives the
    /// call that made it in the type system even though it never does
    /// in fact.
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    /// Whether the connection is still open, kept beside the lock
    /// rather than inside it, because asking a connection whether it is
    /// closed should not queue behind a ten second statement.
    alive: Arc<AtomicBool>,
    /// The word a statement running on this connection reads at every
    /// boundary, taken once when the connection was opened.
    ///
    /// Kept here rather than asked of the connection when a statement
    /// wants one, because asking means taking the lock and the caller
    /// asking is on the thread that must never wait: the handle belongs
    /// to the session and is the same one for the connection's whole
    /// life, so once is enough.
    interrupt: Interrupt,
    /// Whether an explicit transaction is running on this connection,
    /// kept beside the lock for the same reason [`Connection::alive`]
    /// is: asking should not queue behind the statement being asked
    /// about.
    ///
    /// Written by every statement that runs, out of the session itself,
    /// which is what makes it exact rather than a tally this client
    /// keeps. Nothing but a statement can start or end a transaction, so
    /// a caller who reads this between two of their own reads the truth,
    /// and a caller who reads it from underneath a statement in flight
    /// is asking a question that has no answer yet either way.
    in_txn: Arc<AtomicBool>,
    /// How this connection's statements spell the values they give
    /// back, unless one of them asks for something else.
    spelling: Spelling,
    path: String,
    read_only: bool,
    /// Whether the database behind it is in memory, which is the one
    /// thing [`Self::path`] cannot quite say: a file could be called
    /// `:memory:` on any filesystem that allows a colon.
    memory: bool,
}

/// The name a database in memory is asked for by, and answers to.
///
/// The spelling every embedded database has used for thirty years,
/// which is the reason it is this and not something better: a caller
/// who types it has already been taught what it means somewhere else.
pub(crate) const MEMORY: &str = ":memory:";

/// Opens the database at `path` and connects to it.
///
/// Creates one when the path holds nothing, which is what a first
/// program expects and what every embedded database does. A read-only
/// connection never creates anything.
///
/// With no path, with `null`, or with `':memory:'`, the database is in
/// memory and no file is made anywhere. It is the whole engine and not
/// a reduced one, so it takes writes and transactions and the appender
/// exactly as a database on disk does, and it is gone when the last
/// connection to it is. Options may stand where the path would in that
/// case, so `connect({ threads: 2 })` is a call and not a mistake.
#[napi(
    ts_args_type = "path?: string | ConnectOptions | undefined | null, options?: ConnectOptions | undefined | null",
    ts_return_type = "Promise<Connection>"
)]
pub fn connect(
    env: &Env,
    path: Option<Unknown<'_>>,
    options: Option<ConnectOptions>,
) -> AsyncTask<ConnectTask> {
    // Whether this runtime has `Temporal` is a question only the thread
    // that owns the runtime may ask, so it is asked here and carried to
    // the thread that opens the database, where the answer decides
    // whether there is anything to open.
    let has_temporal = temporal::present(env).unwrap_or(false);
    let (path, options, refused) = arguments(path, options);
    AsyncTask::new(ConnectTask {
        memory: path.is_none(),
        path: path.unwrap_or_else(|| MEMORY.to_string()),
        refused,
        options,
        has_temporal,
    })
}

/// Which of the three shapes the call was written in.
///
/// A path and options, options alone, or neither. The first argument
/// is read here rather than declared, because a value that is a string
/// in one call and an object in the next is a value napi would refuse
/// before this client got to say anything about it.
///
/// The path comes back as `None` when the database is in memory, which
/// is the one thing the three shapes have to agree on.
fn arguments(
    first: Option<Unknown<'_>>,
    second: Option<ConnectOptions>,
) -> (Option<String>, Option<ConnectOptions>, Option<String>) {
    let Some(first) = first else {
        return (None, second, None);
    };
    let kind = match first.get_type() {
        Ok(kind) => kind,
        Err(err) => return (None, second, Some(err.reason)),
    };
    match kind {
        ValueType::Undefined | ValueType::Null => (None, second, None),
        ValueType::Object => match ConnectOptions::from_unknown(first) {
            Ok(options) => (None, Some(options), None),
            Err(err) => (None, second, Some(err.reason)),
        },
        _ => match text(&first, "path") {
            Ok(path) if path == MEMORY => (None, second, None),
            Ok(path) => (Some(path), second, None),
            Err(message) => (None, second, Some(message)),
        },
    }
}

pub struct ConnectTask {
    path: String,
    /// Whether the database is in memory, in which case [`Self::path`]
    /// is the name it is asked for by rather than a name to open.
    memory: bool,
    /// What this client refused the call with, before any of it ran.
    refused: Option<String>,
    options: Option<ConnectOptions>,
    has_temporal: bool,
}

impl<'task> ScopedTask<'task> for ConnectTask {
    type Output = std::result::Result<Opened, Failure>;
    type JsValue = ClassInstance<'task, Connection>;

    fn compute(&mut self) -> Result<Self::Output> {
        // Before anything else, because a path that is not a path names
        // no file to open and a message about the one it made instead
        // would be a message about this client's own confusion.
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let read_only = self
            .options
            .as_ref()
            .and_then(|options| options.read_only)
            .unwrap_or(false);
        // Before the open, because a mode nobody can spell is a mistake
        // in the calling program and a database created on the way to
        // finding it out is a file the caller did not ask for.
        let ints = match self
            .options
            .as_ref()
            .and_then(|options| options.big_int_mode.as_deref())
        {
            Some(mode) => match Ints::named(mode) {
                Ok(ints) => ints,
                Err(message) => return Ok(Err(Failure::Usage(message))),
            },
            None => Ints::default(),
        };
        // And for the same reason: a program that asked for `Temporal`
        // on a runtime without one is a program that is not going to
        // work, and hearing so from the connect is hearing it before
        // anything has been written.
        let wants_temporal = self
            .options
            .as_ref()
            .and_then(|options| options.temporal)
            .unwrap_or(false);
        if wants_temporal && !self.has_temporal {
            return Ok(Err(Failure::Usage(temporal::MISSING.to_string())));
        }
        let spelling = Spelling {
            ints,
            temporal: wants_temporal,
        };
        let mut config = Config::new().read_only(read_only);
        if let Some(options) = &self.options {
            if let Some(limit) = &options.memory_limit {
                let (_, bytes, _) = limit.get_u64();
                config = config.memory_limit(bytes as usize);
            }
            if let Some(threads) = options.threads {
                config = config.threads(threads as usize);
            }
        }
        let opened = match self.memory {
            true => memory(config),
            false => open(PathBuf::from(&self.path), read_only, config),
        };
        Ok(opened
            .map(|opened| Opened {
                spelling,
                read_only,
                ..opened
            })
            .map_err(Failure::Engine))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let opened = output.map_err(|failure| failed(env, failure, None))?;
        let mut instance = Connection {
            interrupt: opened.conn.interrupt(),
            inner: Arc::new(Mutex::new(Some(opened.conn))),
            alive: Arc::new(AtomicBool::new(true)),
            in_txn: Arc::new(AtomicBool::new(false)),
            spelling: opened.spelling,
            path: opened.path,
            read_only: opened.read_only,
            memory: opened.memory,
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance, "dispose")?;
        Ok(instance)
    }
}

/// Puts a method on an instance under `Symbol.asyncDispose`, which is
/// the key `await using` looks up and the one thing about these classes
/// that cannot be spelled in the attribute that declares the rest of
/// them: a method's name there is a string, and this key is a symbol.
///
/// On the instance rather than on the prototype, because reaching the
/// prototype from here means calling `Object.getPrototypeOf` through
/// three more layers of FFI for a property that is looked up once per
/// object either way.
pub(crate) fn wire_disposal<T: MaybeTypeTag>(
    env: &Env,
    instance: &mut ClassInstance<'_, T>,
    method: &str,
) -> Result<()> {
    // `Symbol` is a function, and the well-known symbols hang off it as
    // properties of that function.
    let symbols: Function<'_, (), Unknown<'_>> = env.get_global()?.get_named_property("Symbol")?;
    let key: Unknown<'_> = symbols.get_named_property("asyncDispose")?;
    // A runtime old enough to lack the symbol still has `dispose` and
    // `close`, so it loses the syntax rather than the capability.
    if key.get_type()? != ValueType::Symbol {
        return Ok(());
    }
    let dispose: Unknown<'_> = instance.get_named_property(method)?;
    instance.set_property(key, dispose)
}

pub struct Opened {
    conn: zudb::Connection,
    spelling: Spelling,
    path: String,
    read_only: bool,
    memory: bool,
}

/// Opens a database in memory, then connects.
///
/// The path is the name it was asked for by rather than the one the
/// engine spells it with: the engine mints a unique name per database
/// so two of them never share a writer, and that counter is its
/// business and not a caller's.
fn memory(config: Config) -> std::result::Result<Opened, ZuError> {
    let database = Database::memory_with(config)?;
    let conn = database.connect()?;
    Ok(Opened {
        conn,
        spelling: Spelling::default(),
        path: MEMORY.to_string(),
        read_only: false,
        memory: true,
    })
}

/// Forking a second connection off the database one already holds.
///
/// It takes the connection's lock like any statement, because the fork
/// reads the schema through the write side, and it is a task like any
/// statement for the same reason: a schema load on the runtime's
/// thread is the loop stopped for the length of one.
pub struct DuplicateTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    spelling: Spelling,
    path: String,
    read_only: bool,
    memory: bool,
    /// Why this is not going to run, when it is not.
    refused: Option<String>,
}

impl<'task> ScopedTask<'task> for DuplicateTask {
    type Output = std::result::Result<zudb::Connection, Failure>;
    type JsValue = ClassInstance<'task, Connection>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        Ok(with(&self.inner, &self.alive, &self.in_txn, |conn| {
            conn.duplicate().map_err(Failure::from)
        }))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let made = output.map_err(|failure| failed(env, failure, None))?;
        let mut instance = Connection {
            interrupt: made.interrupt(),
            inner: Arc::new(Mutex::new(Some(made))),
            alive: Arc::new(AtomicBool::new(true)),
            // Its own, and false: a fork is outside whatever
            // transaction the connection it came from is in.
            in_txn: Arc::new(AtomicBool::new(false)),
            spelling: self.spelling,
            path: self.path.clone(),
            read_only: self.read_only,
            memory: self.memory,
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance, "dispose")?;
        Ok(instance)
    }
}

/// Opens or creates, then connects.
///
/// A read-only open of a path that holds nothing fails as an open
/// rather than creating an empty database and then refusing every
/// statement against it, which would be the same typo reported three
/// calls later and less clearly.
fn open(path: PathBuf, read_only: bool, config: Config) -> std::result::Result<Opened, ZuError> {
    let database = if read_only || path.exists() {
        Database::open_with(&path, config)?
    } else {
        Database::create_with(&path, config)?
    };
    let stored = database.path().to_string_lossy().into_owned();
    let conn = database.connect()?;
    Ok(Opened {
        conn,
        spelling: Spelling::default(),
        path: stored,
        read_only,
        memory: false,
    })
}

#[napi]
impl Connection {
    /// Where the database this is connected to lives.
    #[napi(getter)]
    pub fn path(&self) -> String {
        self.path.clone()
    }

    /// Whether this connection refuses every statement that writes.
    #[napi(getter)]
    pub fn read_only(&self) -> bool {
        self.read_only
    }

    /// Whether the database behind it is in memory rather than on
    /// disk, in which case nothing survives the last connection to it.
    #[napi(getter)]
    pub fn memory(&self) -> bool {
        self.memory
    }

    /// Whether the connection is still open.
    #[napi(getter)]
    pub fn open(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Whether an explicit transaction is running on this connection.
    ///
    /// True inside a `transaction()` and true after a `START
    /// TRANSACTION` written by hand, because it is asked of the session
    /// rather than counted here. A statement written on its own runs in
    /// a transaction of its own and this stays false for it: what it
    /// answers is whether a span is open, not whether anything is
    /// atomic.
    #[napi(getter)]
    pub fn in_transaction(&self) -> bool {
        self.in_txn.load(Ordering::Acquire)
    }

    /// How many rows the statement running on this connection has read
    /// out of storage, for showing a person that something is
    /// happening.
    ///
    /// Rows read rather than rows answered, because the statement
    /// somebody is waiting on is exactly the one that reads a hundred
    /// million rows to answer one. It starts at zero at each statement
    /// and holds its last value once one ends.
    ///
    /// This is the one thing on a connection that is worth reading
    /// while a statement runs, and it is answered the way
    /// [`Connection::open`] is: an atomic beside the lock rather than a
    /// question through it. So the loop's thread gets its answer while
    /// the threadpool thread is still scanning, and `progress()` is the
    /// timer written around it.
    ///
    /// A number rather than a bigint, like every other count this
    /// client makes rather than reads out of a column: a statement that
    /// had read 2^53 rows would have been running for weeks.
    #[napi(getter)]
    pub fn rows_read(&self) -> f64 {
        self.interrupt.rows() as f64
    }

    /// Starts a transaction and hands it back.
    ///
    /// It starts here rather than at the first statement inside it, so a
    /// transaction that cannot start says so at the line that asked. A
    /// connection is inside one transaction at a time and asking for a
    /// second while one is open is refused by the engine rather than
    /// nested, because a transaction inside a transaction is a promise
    /// this database does not make.
    ///
    /// ```js
    /// await using tx = await conn.transaction()
    /// await conn.exec('INSERT (a:account {uid: 1, balance: 100})')
    /// await conn.exec('INSERT (b:account {uid: 2, balance: 0})')
    /// await tx.commit()
    /// ```
    ///
    /// The `await using` is the rollback nobody remembers to write. It
    /// undoes the transaction unless the block committed it, which is
    /// the opposite of what Python's `with` block does here and is the
    /// only honest reading in JavaScript: a disposal is not told whether
    /// the scope it is leaving threw, so a disposal that committed would
    /// commit half of the work of a block that failed.
    #[napi(
        ts_args_type = "options?: ZuTransactionOptions | null",
        ts_return_type = "Promise<Transaction>"
    )]
    pub fn transaction(&self, options: Option<Object<'_>>) -> AsyncTask<StartTask> {
        let read_only = match flag(options.as_ref(), "readOnly") {
            Ok(read_only) => read_only.unwrap_or(false),
            Err(message) => return AsyncTask::new(self.start(false, Some(message))),
        };
        let refused = match self.alive.load(Ordering::Acquire) {
            true => None,
            false => Some(CLOSED.to_string()),
        };
        AsyncTask::new(self.start(read_only, refused))
    }

    /// Opens an appender on `table` and hands it back.
    ///
    /// The bulk-load path. A load written as statements pays a commit
    /// per row, and an appender pays one per flush, which is the whole
    /// difference between loading a million rows in an afternoon and
    /// loading them in a minute.
    ///
    /// ```js
    /// await using rows = await conn.appender('person')
    /// for (const [id, name] of people) rows.appendRow([id, name])
    /// await rows.flush()
    /// ```
    ///
    /// The table has to exist, and its columns are read here, so a
    /// table nothing declares and a column of a type the ingest cannot
    /// carry are both refused at this call rather than at the flush a
    /// million rows later.
    #[napi(ts_args_type = "table: string", ts_return_type = "Promise<Appender>")]
    pub fn appender(&self, table: Unknown<'_>) -> AsyncTask<OpenTask> {
        let named = match self.alive.load(Ordering::Acquire) {
            true => text(&table, "table"),
            false => Err(CLOSED.to_string()),
        };
        AsyncTask::new(OpenTask::new(
            Arc::clone(&self.inner),
            Arc::clone(&self.alive),
            Arc::clone(&self.in_txn),
            named.as_deref().unwrap_or_default().to_string(),
            named.err(),
        ))
    }

    /// Registers columns the caller already holds as a table called
    /// `name`, and answers how many rows it has.
    ///
    /// The zero-copy way in. Nothing is read into the database: the
    /// engine is told where the caller's buffers are, and a statement
    /// that matches the name scans them where they lie, so registering
    /// ten million rows costs a description of their columns rather than
    /// ten million writes.
    ///
    /// ```js
    /// await conn.register('people', arrow.tableFromArrays({ id, name }))
    /// const rows = await conn.query('MATCH (p:people) RETURN p.name AS name')
    /// ```
    ///
    /// An Arrow table or record batch, which is what `apache-arrow` and
    /// everything built on it hands out, or an object of column name to
    /// values. The values of that object are typed arrays where the
    /// caller has them, which is the zero-copy shape, and plain arrays
    /// where they do not, which is read into buffers of this client's
    /// own because an array holds values of the runtime rather than
    /// numbers.
    ///
    /// A frame is a view and not a snapshot: write into the array behind
    /// it and the next statement answers what is there now. It belongs
    /// to this connection, is never written to the database, and no
    /// other program opening the same file sees it. Nothing writes to
    /// one either, so a statement that inserts into a registered name is
    /// refused with the reason.
    #[napi(
        ts_args_type = "name: string, data: ZuFrame",
        ts_return_type = "Promise<number>"
    )]
    pub fn register(
        &self,
        env: &Env,
        name: Unknown<'_>,
        data: Unknown<'_>,
    ) -> AsyncTask<RegisterTask> {
        // The frame is read here, on the thread that owns the runtime,
        // because reading a JavaScript value is something no other
        // thread may do. What travels is the description and the
        // references keeping the buffers alive.
        let read = match self.alive.load(Ordering::Acquire) {
            true => text(&name, "name")
                .and_then(|name| register::read(env, &name, data).map(|frame| (name, frame))),
            false => Err(register::closed()),
        };
        let (name, described, refused) = match read {
            Ok((name, described)) => (name, Some(described), None),
            Err(message) => (String::new(), None, Some(message)),
        };
        AsyncTask::new(RegisterTask::new(self.frames(), name, described, refused))
    }

    /// Takes a registered frame's name away and gives the bytes back.
    ///
    /// The bytes go when the last statement reading them lets go, which
    /// is usually now and is never before: a frame a running statement
    /// is still scanning is held until it ends.
    #[napi(ts_args_type = "name: string", ts_return_type = "Promise<void>")]
    pub fn unregister(&self, name: Unknown<'_>) -> AsyncTask<UnregisterTask> {
        let named = match self.alive.load(Ordering::Acquire) {
            true => text(&name, "name"),
            false => Err(register::closed()),
        };
        AsyncTask::new(UnregisterTask::new(
            self.frames(),
            named.as_deref().unwrap_or_default().to_string(),
            named.err(),
        ))
    }

    /// The names frames are registered under on this connection, sorted.
    ///
    /// A method rather than a getter, and asynchronous like everything
    /// else here, because reading them takes the connection's lock and
    /// nothing on this class waits on the event loop.
    #[napi(ts_return_type = "Promise<string[]>")]
    pub fn registered(&self) -> AsyncTask<RegisteredTask> {
        let refused = match self.alive.load(Ordering::Acquire) {
            true => None,
            false => Some(register::closed()),
        };
        AsyncTask::new(RegisteredTask::new(self.frames(), refused))
    }

    /// The three handles a frame call runs against.
    fn frames(&self) -> register::Held {
        register::Held::new(
            Arc::clone(&self.inner),
            Arc::clone(&self.alive),
            Arc::clone(&self.in_txn),
        )
    }

    /// The task that starts one, whether or not it is going to work.
    fn start(&self, read_only: bool, refused: Option<String>) -> StartTask {
        StartTask::new(
            Arc::clone(&self.inner),
            Arc::clone(&self.alive),
            Arc::clone(&self.in_txn),
            read_only,
            refused,
        )
    }

    /// Runs one statement and gives back its rows.
    ///
    /// The parameters are named, never positional, because zuQL names
    /// them: `$id` in the statement is `id` in the object. A name the
    /// statement does not use is an error from the engine rather than a
    /// value quietly ignored.
    #[napi(
        ts_generic_types = "Row = Record<string, ZuValue>",
        ts_args_type = "statement: string, params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<ZuRows<Row>>"
    )]
    pub fn query(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<QueryTask> {
        AsyncTask::new(self.task(env, statement, params, options))
    }

    /// Runs one statement for its effect and gives back nothing.
    ///
    /// The same call as [`Connection::query`] with the rows dropped,
    /// which is what a schema statement or a write wants: a result nobody
    /// reads still costs a row object per row on the way out.
    #[napi(
        ts_args_type = "statement: string, params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<void>"
    )]
    pub fn exec(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ExecTask> {
        AsyncTask::new(ExecTask(self.task(env, statement, params, options)))
    }

    /// Runs one statement and gives back its columns rather than its
    /// rows.
    ///
    /// The same statement as [`Connection::query`], read down instead
    /// of across: what comes back is one buffer a column, in the layout
    /// Arrow already uses, and no object a row. That is the way out for
    /// anything that is going to be counted, plotted or handed to a
    /// dataframe, and it is the way out that does not build a million
    /// JavaScript values on the way.
    #[napi(
        ts_args_type = "statement: string, params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<ZuColumnar>"
    )]
    pub fn columnar(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ColumnsTask> {
        AsyncTask::new(ColumnsTask(self.task(env, statement, params, options)))
    }

    /// Compiles a statement, pins it, and hands back something that
    /// runs it.
    ///
    /// ```js
    /// await using find = await conn.prepare('MATCH (p:person) WHERE p.id = $id RETURN p.name AS name')
    /// for (const id of ids) console.log(await find.query({ id }))
    /// ```
    ///
    /// What this buys is not what it buys in a driver. A driver prepares
    /// to save a round trip and this database has none, and the plan for
    /// a statement is cached by its text either way, so a loop that
    /// writes the same query twice is not compiling it twice whether or
    /// not anybody prepared it. What preparing buys here is the compile
    /// happening at the line that asked for it, so a statement that does
    /// not compile is a failure at startup rather than on the first
    /// request that used it, and the parameter names coming back, so a
    /// program can bind by what the statement actually wants rather than
    /// by what somebody remembered writing.
    ///
    /// The id maps back to the text rather than to a plan, so a prepared
    /// statement crossing a catalog change recompiles instead of running
    /// a plan for a table that has since changed shape.
    #[napi(
        ts_args_type = "statement: string",
        ts_return_type = "Promise<Prepared>"
    )]
    pub fn prepare(&self, statement: Unknown<'_>) -> AsyncTask<PrepareTask> {
        let named = match self.alive.load(Ordering::Acquire) {
            true => text(&statement, "statement"),
            false => Err(CLOSED.to_string()),
        };
        AsyncTask::new(PrepareTask::new(
            self.handles(),
            self.interrupt.clone(),
            self.spelling,
            named.as_deref().unwrap_or_default().to_string(),
            named.err(),
        ))
    }

    /// The plan this connection would run for a statement, without
    /// running it.
    ///
    /// ```js
    /// const plan = await conn.explain('MATCH (p:person) WHERE p.id = $id RETURN p.name AS name')
    /// console.log(plan.text)
    /// ```
    ///
    /// A tree and a rendering of it, because the two questions a plan
    /// gets asked want different things: a person reading it wants the
    /// listing, and a program asking whether the scan reached an index
    /// or which tables were touched wants operators it can walk. They
    /// are one plan printed two ways rather than two answers that can
    /// drift, since `text` is what the engine renders from the same
    /// tree.
    ///
    /// No parameters, because a plan does not depend on the values bound
    /// to it: it depends on the names, and those are in `params`. A
    /// statement that does not compile fails here, which is most of why
    /// this is worth calling.
    #[napi(ts_args_type = "statement: string", ts_return_type = "Promise<ZuPlan>")]
    pub fn explain(&self, statement: Unknown<'_>) -> AsyncTask<PlanTask> {
        let named = match self.alive.load(Ordering::Acquire) {
            true => text(&statement, "statement"),
            false => Err(CLOSED.to_string()),
        };
        AsyncTask::new(PlanTask::new(
            self.handles(),
            named.as_deref().unwrap_or_default().to_string(),
            named.err(),
        ))
    }

    /// Runs a statement with the counters on and gives back what they
    /// saw, rather than the rows.
    ///
    /// ```js
    /// const run = await conn.profile('MATCH (p:person)-[:knows]->(q) RETURN q.name AS name')
    /// console.log(run.text)
    /// ```
    ///
    /// This is the call for a statement that is slower than its plan
    /// says it should be. Every operator carries what it really
    /// produced beside what the optimizer expected, and `qerror` is the
    /// ratio between them, so the operator whose estimate was wrong is
    /// the one to look at and `nanos` says whether being wrong cost
    /// anything.
    ///
    /// It costs the execution, since the way to find out what a
    /// statement does is to do it. A statement that writes is refused,
    /// because profiling it would apply the write.
    #[napi(
        ts_args_type = "statement: string, params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<ZuProfile>"
    )]
    pub fn profile(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ProfileTask> {
        // Read here rather than on the threadpool thread, for the reason
        // every other statement's are: reading a JavaScript value is
        // something only the thread that owns the runtime may do, and so
        // is adding the listener the signal is watched through.
        let bound = if self.alive.load(Ordering::Acquire) {
            text(&statement, "statement").and_then(|statement| {
                Ok((
                    statement,
                    bind(env, params)?,
                    watch(env, options, self.interrupt.clone())?,
                ))
            })
        } else {
            Err(CLOSED.to_string())
        };
        let (statement, params, watch, refused) = match bound {
            Ok((statement, params, watch)) => (statement, params, watch, None),
            Err(message) => (String::new(), Vec::new(), None, Some(message)),
        };
        AsyncTask::new(ProfileTask::new(
            self.handles(),
            statement,
            params,
            watch,
            refused,
        ))
    }

    /// Another connection to the same database, made from this one.
    ///
    /// This is how a pool is written. `connect()` opens the file again
    /// and looks the database up by path; this forks off the one this
    /// connection already holds, which costs a schema load and no
    /// lookup, and works on a database in memory, where there is no
    /// path to open a second time.
    ///
    /// ```js
    /// await using other = await conn.duplicate()
    /// const rows = await other.query('MATCH (p:person) RETURN p.name AS name')
    /// ```
    ///
    /// The two are connections in every sense rather than two names
    /// for one. Each has its own prepared statements, its own caches
    /// and its own transaction, so a task taking one from a pool is not
    /// in whatever transaction the last borrower left open, and closing
    /// one does not close the other. What they share is the write side:
    /// they queue behind each other to write and each sees what the
    /// other has committed, which is what two connections to one file
    /// have always done.
    ///
    /// Other clients call this `cursor()`, after the way every
    /// embedded database has spelled it for thirty years. That name is
    /// taken here by [`Connection::cursor`], which is a cursor over the
    /// rows of one statement and a different thing entirely, so this
    /// one says what it does.
    ///
    /// The switches this connection was opened with come across,
    /// including how it spells the values it gives back, because a pool
    /// handing out connections that answered differently from the one it
    /// was seeded with would be a trap nobody would look for.
    #[napi(ts_return_type = "Promise<Connection>")]
    pub fn duplicate(&self) -> AsyncTask<DuplicateTask> {
        let refused = match self.alive.load(Ordering::Acquire) {
            true => None,
            false => Some(CLOSED.to_string()),
        };
        AsyncTask::new(DuplicateTask {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
            spelling: self.spelling,
            path: self.path.clone(),
            read_only: self.read_only,
            memory: self.memory,
            refused,
        })
    }

    /// Runs one statement and gives back a cursor over its rows.
    ///
    /// The pull underneath `stream`, which is what a program uses. The
    /// statement does not start here: it starts on the first read, so
    /// that a cursor made and not read is not a scan holding the
    /// connection against every statement after it.
    #[napi(
        ts_args_type = "statement: string, params?: Record<string, ZuParam> | null, options?: ZuStreamOptions | null",
        ts_return_type = "ZuCursor"
    )]
    pub fn cursor(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> ZuCursor {
        // Read here rather than on the statement's thread, because
        // reading a JavaScript value is something only the thread that
        // owns the runtime may do. So is adding the listener the signal
        // is watched through.
        let bound = if self.alive.load(Ordering::Acquire) {
            text(&statement, "statement").and_then(|statement| {
                let spelling = self.spell(options.as_ref())?;
                let batch_rows = batch_rows(options.as_ref())?;
                Ok((
                    statement,
                    bind(env, params)?,
                    spelling,
                    batch_rows,
                    watch(env, options, self.interrupt.clone())?,
                ))
            })
        } else {
            Err(CLOSED.to_string())
        };
        let (statement, params, spelling, batch_rows, watch, refused) = match bound {
            Ok((statement, params, spelling, batch_rows, watch)) => {
                (statement, params, spelling, batch_rows, watch, None)
            }
            Err(message) => (
                String::new(),
                Vec::new(),
                self.spelling,
                None,
                None,
                Some(message),
            ),
        };
        stream::open(
            Started {
                inner: Arc::clone(&self.inner),
                alive: Arc::clone(&self.alive),
                in_txn: Arc::clone(&self.in_txn),
                statement,
                params,
                spelling,
                batch_rows,
                guard: watch.as_ref().map(Watch::guard),
            },
            watch,
            refused,
        )
    }

    /// The task one statement runs as, whether or not it is going to
    /// work.
    ///
    /// A statement this client refuses is refused inside the task and
    /// not here, so that every call gives back a promise and a caller
    /// who wrote `await` or `.catch` has somewhere to catch it. A native
    /// method that throws for a closed connection and rejects for a
    /// failed statement is a method every caller has to wrap twice.
    fn task(
        &self,
        env: &Env,
        statement: Unknown<'_>,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> QueryTask {
        // The parameters are read here rather than on the threadpool
        // thread, because reading a JavaScript value is something only
        // the thread that owns the runtime may do. So is adding the
        // listener the signal is watched through.
        let bound = if self.alive.load(Ordering::Acquire) {
            text(&statement, "statement").and_then(|statement| {
                let spelling = self.spell(options.as_ref())?;
                Ok((
                    statement,
                    bind(env, params)?,
                    spelling,
                    watch(env, options, self.interrupt.clone())?,
                ))
            })
        } else {
            Err(CLOSED.to_string())
        };
        let (statement, params, spelling, watch, refused) = match bound {
            Ok((statement, params, spelling, watch)) => (statement, params, spelling, watch, None),
            Err(message) => (
                String::new(),
                Vec::new(),
                self.spelling,
                None,
                Some(message),
            ),
        };
        QueryTask::new(
            self.handles(),
            Source::Text(statement),
            params,
            spelling,
            watch,
            refused,
        )
    }

    /// The three handles a call on this connection runs against.
    pub(crate) fn handles(&self) -> Handles {
        Handles {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
        }
    }

    /// How this statement spells the values it gives back, which is the
    /// connection's own unless the statement said otherwise.
    ///
    /// Only the integers can be said otherwise. `Temporal` is a decision
    /// about how a whole program reads dates and both spellings are
    /// exact, where the integer modes are a trade one query makes and
    /// the next one does not.
    fn spell(&self, options: Option<&Object<'_>>) -> std::result::Result<Spelling, String> {
        Ok(Spelling {
            ints: int_mode(options, self.spelling.ints)?,
            ..self.spelling
        })
    }

    /// Closes the connection and releases the database.
    ///
    /// Closing twice does nothing the second time, which is what makes
    /// `await using` safe to combine with an explicit close in a branch
    /// that ran first.
    #[napi]
    pub fn close(&self) {
        if self.alive.swap(false, Ordering::AcqRel) {
            // A statement that is running holds the lock, so this waits
            // for it. That is the right order: a connection dropped out
            // from under a running statement is the one thing this
            // cannot allow.
            if let Ok(mut held) = self.inner.lock() {
                held.take();
            }
        }
    }

    /// The disposal `await using` calls, which is the intended way to
    /// scope a connection. `close` stays public for callers who cannot
    /// use it.
    ///
    /// It is also reachable as `Symbol.asyncDispose`, which is what
    /// `await using` actually looks for and which [`wire_disposal`] puts
    /// on every connection as it is made.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn dispose(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
        })
    }
}

/// What a statement was told when it could not run.
///
/// The two are told apart because a caller does something different
/// with each: a condition the engine raised has a GQLSTATUS and may be
/// worth retrying, and a mistake this client caught is a bug in the
/// calling program that no retry fixes.
pub enum Failure {
    /// The engine raised a condition.
    Engine(ZuError),
    /// This client refused the call before the engine saw it.
    Usage(String),
    /// The caller's signal fired, before the statement or during it.
    Aborted,
}

/// The exception a failed statement rejects the caller's promise with.
///
/// An abort rejects with the signal's own reason, which is what `fetch`
/// does: a caller who wrote `AbortSignal.timeout(50)` gets back the
/// `TimeoutError` that signal carries, and one who wrote
/// `controller.abort(new MyError())` gets their own object rather than
/// a description of it.
pub(crate) fn failed(env: &Env, failure: Failure, watch: Option<&Watch>) -> Error {
    match failure {
        Failure::Engine(err) => raise(env, err),
        Failure::Usage(message) => usage(env, message),
        Failure::Aborted => watch
            .and_then(|watch| watch.reason(env))
            .map_or_else(|| aborted(env, ABORTED), Error::from),
    }
}

impl From<ZuError> for Failure {
    fn from(err: ZuError) -> Self {
        Failure::Engine(err)
    }
}

/// Takes the connection for the length of one statement, and says why
/// it could not be had when it could not.
///
/// Every statement that runs on the threadpool goes through here, which
/// is what makes the three things it decides be decided once: what an
/// empty slot means, what a poisoned lock means, and whether the
/// connection is inside a transaction now that the statement has run.
/// That last one is written here rather than by each caller because a
/// caller that forgot would leave `inTransaction` describing some
/// earlier statement.
pub(crate) fn with<T>(
    inner: &Mutex<Option<zudb::Connection>>,
    alive: &AtomicBool,
    in_txn: &AtomicBool,
    run: impl FnOnce(&mut zudb::Connection) -> std::result::Result<T, Failure>,
) -> std::result::Result<T, Failure> {
    // A thread that panicked inside the engine left the connection in a
    // state nothing here can vouch for, so this says so rather than
    // carrying on with it.
    let mut held = inner
        .lock()
        .map_err(|_| Failure::Usage(POISONED.to_string()))?;
    // Closed between the call and the thread picking it up, which is a
    // race the caller cannot see and this has to check anyway. Or lent
    // to a stream that has not finished, which is the same empty slot
    // and a different thing to say about it.
    let Some(conn) = held.as_mut() else {
        return Err(Failure::Usage(
            match alive.load(Ordering::Acquire) {
                true => STREAMING,
                false => CLOSED,
            }
            .to_string(),
        ));
    };
    let answered = run(&mut *conn);
    in_txn.store(conn.session_mut().in_transaction(), Ordering::Release);
    answered
}

/// A statement is about to run, and the counter it reports its rows
/// through starts again at zero.
///
/// Called where the connection becomes one statement's, which is the
/// only moment the count can be reset without racing the statement
/// reading it: the lock is held here and the reader is a getter that
/// takes no lock at all. Held rather than cleared afterwards, so that
/// `rowsRead` after a statement is what that statement cost.
///
/// The word an interrupt is raised through is put down by the same
/// call, which is the reason this happens before the signal is entered
/// rather than after: a signal that fired while nothing was running
/// raised nothing to put down, and one that fires from here on is
/// answered by the watch instead.
pub(crate) fn began(conn: &mut zudb::Connection) {
    conn.interrupt().clear();
}

/// What a closed connection says, wherever it is noticed.
pub(crate) const CLOSED: &str =
    "the connection is closed, so there is nothing left to run a statement on";

/// What a connection says when the thread that last held it panicked.
pub(crate) const POISONED: &str =
    "the connection was left in an unknown state by a statement that panicked";

/// What a connection a stream is still reading says to the next
/// statement.
///
/// A connection runs one statement at a time, and a stream is a
/// statement that ends when its reader says so. So a second statement
/// issued while a stream is outstanding cannot be made to wait: the
/// thing it would wait for is the caller, who is waiting for it. That is
/// a program that stops, which is the worst answer a database can give,
/// and this is the sentence that replaces it.
pub(crate) const STREAMING: &str = "a stream on this connection has not finished, and a connection runs one statement at a time: \
     read the stream to the end, cancel it, or open a second connection";

/// What an abort says when the signal that fired named no reason of its
/// own, which is a signal built by hand rather than by a runtime.
const ABORTED: &str = "the statement was stopped by the signal it was given";

/// Reads `options.signal` and starts watching it.
///
/// Absent options and an absent signal are the same thing and are the
/// common case, so both cost one property read and no listener. A
/// `signal` that is not an `AbortSignal` is refused here rather than
/// where the listener fails to be added, because the caller's mistake is
/// the value they passed.
pub(crate) fn watch(
    env: &Env,
    options: Option<Object<'_>>,
    interrupt: Interrupt,
) -> std::result::Result<Option<Watch>, String> {
    let Some(options) = options else {
        return Ok(None);
    };
    let signal: Unknown<'_> = options
        .get_named_property("signal")
        .map_err(|err| err.reason)?;
    match signal.get_type().map_err(|err| err.reason)? {
        ValueType::Undefined | ValueType::Null => Ok(None),
        ValueType::Object => {
            let signal = signal.coerce_to_object().map_err(|err| err.reason)?;
            if signal
                .get_named_property::<Unknown<'_>>("aborted")
                .and_then(|aborted| aborted.get_type())
                .map_err(|err| err.reason)?
                != ValueType::Boolean
            {
                return Err("signal is an object that is not an AbortSignal".to_string());
            }
            Watch::new(env, signal, interrupt)
                .map(Some)
                .map_err(|err| err.reason)
        }
        other => Err(format!("signal is a {other}, which is not an AbortSignal")),
    }
}

/// Reads `options.batchRows`, which is how many rows a caller wants in
/// a batch.
///
/// Absent means the engine's own vector, which is the unit it already
/// works in and the one that costs nothing to hand over. A caller names
/// a size when the rows are going somewhere with a size of its own, an
/// HTTP chunk or a write of a fixed length, and a size of zero is a
/// stream that could never hand anything over rather than a default.
fn batch_rows(options: Option<&Object<'_>>) -> std::result::Result<Option<u32>, String> {
    let Some(options) = options else {
        return Ok(None);
    };
    let rows: Option<f64> = options
        .get_named_property::<Unknown<'_>>("batchRows")
        .map_err(|err| err.reason)
        .and_then(|rows| match rows.get_type().map_err(|err| err.reason)? {
            ValueType::Undefined | ValueType::Null => Ok(None),
            ValueType::Number => rows
                .coerce_to_number()
                .and_then(|rows| rows.get_double())
                .map(Some)
                .map_err(|_| "batchRows is a number that cannot be read".to_string()),
            other => Err(format!("batchRows is a {other}, which is not a number")),
        })?;
    // Read as a double and checked here rather than converted, because
    // JavaScript's own narrowing to an unsigned integer turns -1 into
    // four billion and 1.5 into 1, and a batch size nobody asked for is
    // worse than a call that says no.
    match rows {
        None => Ok(None),
        Some(rows) if rows.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(&rows) => {
            Ok(Some(rows as u32))
        }
        Some(rows) => Err(format!(
            "batchRows is {rows}, and a batch holds a whole number of rows, one at the least"
        )),
    }
}

/// Reads an option that has to be a boolean, and says what arrived
/// instead.
///
/// Absent and `null` are the same as unwritten, which is what makes
/// `{ readOnly: wanted }` work for a caller whose `wanted` came out of
/// a config file. Anything else is refused rather than made truthy: a
/// `readOnly: 'false'` that opened a writing transaction would be a
/// string nobody meant read as the opposite of itself.
fn flag(options: Option<&Object<'_>>, name: &str) -> std::result::Result<Option<bool>, String> {
    let Some(options) = options else {
        return Ok(None);
    };
    let value: Unknown<'_> = options.get_named_property(name).map_err(|err| err.reason)?;
    match value.get_type().map_err(|err| err.reason)? {
        ValueType::Undefined | ValueType::Null => Ok(None),
        ValueType::Boolean => bool::from_unknown(value)
            .map(Some)
            .map_err(|err| err.reason),
        other => Err(format!(
            "{name} is {}, and it is either true or false",
            worded(other)
        )),
    }
}

/// Reads `options.bigIntMode`, which is how this statement spells the
/// INT64s it gives back.
///
/// Absent means the connection's own, which is `bigint` unless the
/// program said otherwise when it connected. A statement may say
/// otherwise again, because the reason to ask for numbers is usually
/// one query whose rows are about to be serialized rather than a whole
/// program's worth of them.
pub(crate) fn int_mode(
    options: Option<&Object<'_>>,
    connection: Ints,
) -> std::result::Result<Ints, String> {
    let Some(options) = options else {
        return Ok(connection);
    };
    let mode: Unknown<'_> = options
        .get_named_property("bigIntMode")
        .map_err(|err| err.reason)?;
    match mode.get_type().map_err(|err| err.reason)? {
        ValueType::Undefined | ValueType::Null => Ok(connection),
        ValueType::String => Ints::named(&String::from_unknown(mode).map_err(|err| err.reason)?),
        other => Err(format!(
            "bigIntMode is a {other}, and a mode is named by a string"
        )),
    }
}

/// Reads an argument that has to be a string, and says what arrived
/// instead.
///
/// napi refuses the wrong type on its own, and what it refuses with is
/// `Failed to convert JavaScript value \`Number 42 \` into rust type
/// \`String\``, thrown out of the call with a `code` of `StringExpected`
/// rather than handed to the promise the caller is awaiting. Both
/// halves of that are wrong for this client: the message describes this
/// crate's insides to somebody who mistyped a variable, and a throw
/// from a method whose every other failure is a rejection is a method
/// callers have to wrap twice. So the argument arrives unread and this
/// is what reads it.
pub(crate) fn text(value: &Unknown<'_>, what: &str) -> std::result::Result<String, String> {
    match value.get_type().map_err(|err| err.reason)? {
        ValueType::String => String::from_unknown(*value).map_err(|err| err.reason),
        other => Err(format!(
            "the {what} is {}, and a {what} is a string",
            worded(other)
        )),
    }
}

/// What arrived, in the words a person writing JavaScript uses for it.
///
/// `a Undefined` is what the type's own name gives, and the two values
/// that need this are exactly the two a mistake produces most: a
/// variable that was never set and a lookup that found nothing.
fn worded(kind: ValueType) -> String {
    match kind {
        ValueType::Undefined => "undefined".to_string(),
        ValueType::Null => "null".to_string(),
        other => format!("a {other}"),
    }
}

/// Reads the parameter object into the values the engine binds.
///
/// Every failure comes back as the message to refuse the call with,
/// including a boundary failure, because a caller who cannot be given
/// the value they passed is being told the same thing either way and
/// would rather hear it as a rejection than as a throw.
pub(crate) fn bind(
    env: &Env,
    params: Option<Unknown<'_>>,
) -> std::result::Result<Vec<(String, Value)>, String> {
    let Some(params) = params else {
        return Ok(Vec::new());
    };
    // An argument of the wrong shape is refused rather than read for
    // whatever keys it happens to have. An array read as an object
    // binds its parameters as `0` and `1`, a string binds one per
    // character, and both of those are a statement that runs with none
    // of the values the caller passed and answers nothing.
    match params.get_type().map_err(|err| err.reason)? {
        ValueType::Undefined | ValueType::Null => return Ok(Vec::new()),
        ValueType::Object => {}
        other => {
            return Err(format!(
                "the parameters are {}, and parameters are an object keyed by the names the \
                 statement uses, without the $",
                worded(other)
            ));
        }
    }
    let params = Object::from_unknown(params).map_err(|err| err.reason)?;
    if params.is_array().map_err(|err| err.reason)? {
        return Err(
            "the parameters are an array, and zu names its parameters rather than \
                    numbering them: pass an object keyed by the names the statement uses, without \
                    the $"
                .to_string(),
        );
    }
    let mut bound = Vec::new();
    for name in Object::keys(&params).map_err(|err| err.reason)? {
        let value: Unknown<'_> = params
            .get_named_property(name.as_str())
            .map_err(|err| err.reason)?;
        let value = from_js(env, &name, value).map_err(|err| err.reason)?;
        bound.push((name, value));
    }
    Ok(bound)
}

/// What a task runs: the text of a statement, or the id a prepared one
/// was pinned under.
///
/// One enum rather than two tasks, because everything after the call
/// that starts a statement is the same either way: the same lock, the
/// same signal, the same rows, the same columns. So `query`, `exec` and
/// `columnar` are written once and a prepared statement reaches all
/// three by handing them an id instead of a string.
pub(crate) enum Source {
    Text(String),
    Prepared(u64),
}

/// The three handles every call on a connection runs against.
///
/// They are counted rather than borrowed because the threadpool thread
/// a statement runs on takes a share of each: a prepared statement, an
/// appender and a task all outlive the call that made them in the type
/// system even though none of them does in fact.
#[derive(Clone)]
pub(crate) struct Handles {
    pub(crate) inner: Arc<Mutex<Option<zudb::Connection>>>,
    pub(crate) alive: Arc<AtomicBool>,
    pub(crate) in_txn: Arc<AtomicBool>,
}

pub struct QueryTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    /// Whether the connection is still open, which is what tells an
    /// empty slot that was closed from one a stream is holding.
    alive: Arc<AtomicBool>,
    /// Where this statement writes whether the connection is inside a
    /// transaction now that it has run.
    in_txn: Arc<AtomicBool>,
    source: Source,
    params: Vec<(String, Value)>,
    /// How this statement spells the values it gives back.
    spelling: Spelling,
    /// The signal watching this statement, when the caller gave one.
    watch: Option<Watch>,
    /// Why this statement is not going to run, when it is not.
    refused: Option<String>,
}

impl QueryTask {
    /// One statement, ready to run or ready to say why it will not.
    pub(crate) fn new(
        handles: Handles,
        source: Source,
        params: Vec<(String, Value)>,
        spelling: Spelling,
        watch: Option<Watch>,
        refused: Option<String>,
    ) -> QueryTask {
        QueryTask {
            inner: handles.inner,
            alive: handles.alive,
            in_txn: handles.in_txn,
            source,
            params,
            spelling,
            watch,
            refused,
        }
    }

    /// Runs the statement, with the names of the tables it saw.
    ///
    /// The names are read while the lock is held, because a catalog
    /// borrowed from the connection cannot outlive it and a result that
    /// names its tables has to carry them.
    pub(crate) fn run(&mut self) -> std::result::Result<(QueryResult, Shape), Failure> {
        if let Some(message) = self.refused.take() {
            return Err(Failure::Usage(message));
        }
        let (source, params, spelling, watch) =
            (&self.source, &self.params, self.spelling, &self.watch);
        with(&self.inner, &self.alive, &self.in_txn, move |conn| {
            // From here the connection is this statement's, so this is
            // where a signal can start stopping it and where it stops
            // being able to. A signal that fired first ends the
            // statement without the engine ever seeing it, which is the
            // whole point of asking.
            began(conn);
            if let Some(watch) = watch
                && !watch.enter()
            {
                watch.leave();
                return Err(Failure::Aborted);
            }
            let params: Vec<(&str, Value)> = params
                .iter()
                .map(|(name, value)| (name.as_str(), value.clone()))
                .collect();
            let shape = Shape::of(conn.session_mut().catalog(), spelling);
            let result = match source {
                Source::Text(statement) => conn.query_with(statement, &params),
                // The id maps back to the text the session pinned, so a
                // catalog change between the prepare and this recompiles
                // rather than running a plan that describes a table that
                // has since changed shape.
                Source::Prepared(id) => conn.execute_prepared(*id, &params),
            };
            if let Some(watch) = watch {
                watch.leave();
                // An interrupt is the engine's answer to somebody having
                // asked, and the only somebody here is the caller's
                // signal. Reported as an abort rather than as the engine
                // condition, because a caller who wrote `catch` around a
                // timeout wants their own reason back and not a
                // GQLSTATUS.
                if watch.asked() && matches!(result, Err(ZuError::Interrupted)) {
                    return Err(Failure::Aborted);
                }
            }
            Ok((result?, shape))
        })
    }

    /// The exception this rejects the caller's promise with.
    pub(crate) fn failed(&self, env: &Env, failure: Failure) -> Error {
        failed(env, failure, self.watch.as_ref())
    }

    /// Takes the listener back off the signal, whatever happened.
    pub(crate) fn release(&mut self, env: &Env) -> Result<()> {
        match self.watch.take() {
            Some(watch) => watch.release(env),
            None => Ok(()),
        }
    }
}

impl<'task> ScopedTask<'task> for QueryTask {
    type Output = std::result::Result<(QueryResult, Shape), Failure>;
    type JsValue = Array<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let (result, shape) = output.map_err(|failure| self.failed(env, failure))?;
        rows(env, &result, &shape)
    }

    fn finally(mut self, env: Env) -> Result<()> {
        self.release(&env)
    }
}

/// The rows, as an array of objects keyed by column name.
///
/// An array rather than a wrapper with a `rows` field inside it,
/// because iterating the answer is what a caller does with it and
/// `for (const row of await conn.query(...))` should be the whole
/// sentence. What a wrapper would have carried is carried as
/// properties of the array: `columns`, `gqlstatus` and `notices` are
/// there for the caller that wants them and out of the way of the one
/// that does not. Out of the way means not enumerable, so that the
/// array spreads, stringifies, deep-equals a plain array and answers
/// `Object.keys` as though they were not there at all.
fn rows<'env>(env: &'env Env, result: &QueryResult, shape: &Shape) -> Result<Array<'env>> {
    let mut array = env.create_array(result.rows.len() as u32)?;
    for (ix, row) in result.rows.iter().enumerate() {
        let mut object = Object::new(env)?;
        for (column, value) in result.columns.iter().zip(row) {
            object.set(column.as_str(), to_js(env, column, value, shape)?)?;
        }
        array.set(ix as u32, object)?;
    }
    let raised = notices(env, &result.notices)?;
    // The same value seen as an object, which is what an array is. The
    // three properties go on there rather than at an index, so the
    // array still has exactly as many elements as the statement had
    // rows.
    let mut object = array.coerce_to_object()?;
    object.define_properties(&[
        beside(
            env,
            "columns",
            Array::from_ref_vec_string(env, &result.columns)?,
        )?,
        beside(env, "gqlstatus", result.status().code())?,
        beside(env, "notices", raised)?,
    ])?;
    Ok(array)
}

/// What the engine wanted to say about a statement that ran anyway.
///
/// The same four fields wherever they are read from, because a notice
/// off a stream and a notice off a result are the same thing and a
/// caller logging them should not have to know which they have.
pub(crate) fn notices<'env>(env: &'env Env, raised: &[DiagnosticRecord]) -> Result<Array<'env>> {
    let mut array = env.create_array(raised.len() as u32)?;
    for (ix, notice) in raised.iter().enumerate() {
        let mut record = Object::new(env)?;
        record.set("code", notice.status.code())?;
        record.set("condition", notice.status.standard_text())?;
        record.set("message", notice.detail.as_str())?;
        record.set("docUrl", notice.doc_url())?;
        array.set(ix as u32, record)?;
    }
    Ok(array)
}

/// One property that rides beside the rows rather than among them.
///
/// Readable and replaceable like any other, but not enumerable, which
/// is the whole difference between a result that is an array and one
/// that merely looks like one.
pub(crate) fn beside<T: ToNapiValue>(env: &Env, name: &str, value: T) -> Result<Property> {
    Ok(Property::new()
        .with_utf8_name(name)?
        .with_napi_value(env, value)?
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable))
}

/// The same statement with the rows thrown away.
pub struct ExecTask(pub(crate) QueryTask);

impl<'task> ScopedTask<'task> for ExecTask {
    type Output = std::result::Result<(), Failure>;
    // Undefined rather than null, because a call that was never going to
    // answer anything has no answer, and `null` is a value a statement
    // can return.
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.0.run().map(|_| ()))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| self.0.failed(env, failure))
    }

    fn finally(mut self, env: Env) -> Result<()> {
        self.0.release(&env)
    }
}

/// Closing off the event loop, which is what `await using` gets.
///
/// A close waits for the statement that is running, and waiting is the
/// thing that must not happen on the event loop.
pub struct CloseTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
}

impl<'task> ScopedTask<'task> for CloseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        if self.alive.swap(false, Ordering::AcqRel)
            && let Ok(mut held) = self.inner.lock()
        {
            held.take();
        }
        Ok(())
    }

    fn resolve(&mut self, _env: &'task Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}
