//! Frames, registered under a name a statement can match on.
//!
//! ```js
//! await conn.register('people', table)
//! await conn.query('MATCH (p:people) WHERE p.age > 40 RETURN p.name AS name')
//! ```
//!
//! This is the replacement scan, and it copies nothing. What the engine
//! is told is where the caller's columns are, how wide their values are
//! and what they mean; a statement that matches the name builds vectors
//! that point straight at those buffers, so a frame of ten million rows
//! is registered in the time it takes to describe its columns and read
//! at the speed of the memory it already sits in.
//!
//! Because it is not a copy, a registered frame is a view and not a
//! snapshot: write into the array behind it and the next statement
//! answers what is there now. The exceptions are the two [`crate::frame`]
//! names, an Arrow column that arrived in several chunks and an object of
//! plain JavaScript arrays, and both of them are copied because there was
//! no one run of bytes to point at in the first place.
//!
//! A frame belongs to the connection it was registered on and goes when
//! that connection does. It is not written to the database, no other
//! program opening the same file sees it, and nothing writes to it: a
//! statement that tries to insert into or delete from one is refused
//! with the reason. `unregister` takes the name away entirely, and the
//! bytes go back to the caller when the last statement reading them has
//! finished with them.
//!
//! All three calls are asynchronous, because all three take the
//! connection's lock and a call that waits on the event loop is the
//! thing this client does not do. That includes `registered()`, which is
//! why it is a method and not a getter.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use zudb::ZuError;
use zudb::zu1::catalog::Catalog;

use crate::conn::{CLOSED, Failure, failed, with};
use crate::frame::Described;

/// What the three tasks share: the connection, and whether it is still
/// there to be had.
pub struct Held {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
}

impl Held {
    pub fn new(
        inner: Arc<Mutex<Option<zudb::Connection>>>,
        alive: Arc<AtomicBool>,
        in_txn: Arc<AtomicBool>,
    ) -> Held {
        Held {
            inner,
            alive,
            in_txn,
        }
    }

    fn run<T>(
        &self,
        run: impl FnOnce(&mut zudb::Connection) -> std::result::Result<T, Failure>,
    ) -> std::result::Result<T, Failure> {
        with(&self.inner, &self.alive, &self.in_txn, run)
    }
}

/// Registers a frame as a table called `name`.
pub struct RegisterTask {
    held: Held,
    name: String,
    /// The frame, read on the thread that owns the runtime because that
    /// is the only thread allowed to read a JavaScript value. `None`
    /// once the task has taken it, and `None` from the start when the
    /// call was refused before there was anything to read.
    described: Option<Described>,
    refused: Option<String>,
}

impl RegisterTask {
    pub fn new(
        held: Held,
        name: String,
        described: Option<Described>,
        refused: Option<String>,
    ) -> RegisterTask {
        RegisterTask {
            held,
            name,
            described,
            refused,
        }
    }

    fn run(&mut self) -> std::result::Result<i64, Failure> {
        if let Some(message) = self.refused.take() {
            return Err(Failure::Usage(message));
        }
        let described = self
            .described
            .take()
            .ok_or_else(|| Failure::Usage(TWICE.to_string()))?;
        let name = self.name.clone();
        let rows = described.rows as i64;
        self.held.run(move |engine| {
            // Refused here rather than at the statement that would have
            // hit it. The engine keeps frames in an id space of their
            // own and would take this name happily; what it could not do
            // is bind it, because a label in a statement is one thing and
            // the stored table would win. Better said at the call that
            // made the clash.
            if has_table(engine, &name)? {
                return Err(Failure::Usage(format!(
                    "'{name}' is already a table of this database, and registering over one \
                     would hide rows this frame knows nothing about"
                )));
            }
            // The walk `Frame::new` does over the unsigned, scaled and
            // string columns happens in here, on the threadpool thread,
            // which is the reason a frame of ten million rows does not
            // stall the event loop while its offsets are checked.
            described.register(engine, &name)?;
            Ok(rows)
        })
    }
}

impl<'task> ScopedTask<'task> for RegisterTask {
    type Output = std::result::Result<i64, Failure>;
    type JsValue = i64;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| failed(env, failure, None))
    }
}

/// What a task says when it is run a second time, which nothing this
/// client writes does: a task is built by one call and driven once.
const TWICE: &str = "this registration has already run, and a frame is registered once";

/// Takes a registered frame's name away and gives the bytes back.
pub struct UnregisterTask {
    held: Held,
    name: String,
    refused: Option<String>,
}

impl UnregisterTask {
    pub fn new(held: Held, name: String, refused: Option<String>) -> UnregisterTask {
        UnregisterTask {
            held,
            name,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for UnregisterTask {
    type Output = std::result::Result<(), Failure>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let name = self.name.clone();
        Ok(self
            .held
            .run(move |engine| match engine.unregister(&name)? {
                true => Ok(()),
                false => Err(Failure::Usage(format!(
                    "nothing is registered here as '{name}', and a name this connection did not \
                     register is a table of the database rather than a frame of the caller's"
                ))),
            }))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| failed(env, failure, None))
    }
}

/// The names frames are registered under on this connection, sorted.
pub struct RegisteredTask {
    held: Held,
    refused: Option<String>,
}

impl RegisteredTask {
    pub fn new(held: Held, refused: Option<String>) -> RegisteredTask {
        RegisteredTask { held, refused }
    }
}

impl<'task> ScopedTask<'task> for RegisteredTask {
    type Output = std::result::Result<Vec<String>, Failure>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        Ok(self.held.run(|engine| Ok(engine.registered())))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output.map_err(|failure| failed(env, failure, None))
    }
}

/// Whether the database already holds a table of this name.
///
/// Node tables and rel tables both, because a name is a label in a
/// statement either way and registering over either of them would be the
/// same mistake.
fn has_table(conn: &mut zudb::Connection, name: &str) -> std::result::Result<bool, ZuError> {
    let file = conn.session_mut().file_mut()?;
    let catalog = Catalog::load(file)?;
    Ok(catalog.node_by_name(name).is_some() || catalog.rel_by_name(name).is_some())
}

/// Refuses a name a statement could not carry.
///
/// A table name goes into a statement as itself, so a name that is not
/// an identifier is a name that would either fail to parse or parse as
/// something else, and the second of those is the one worth refusing
/// for.
pub fn identifier(name: &str, what: &str) -> std::result::Result<(), String> {
    let mut chars = name.chars();
    let starts = chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_');
    if !starts || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!(
            "'{name}' is not a name a statement can carry, and {what} is named by a letter or an \
             underscore followed by letters, digits or underscores"
        ));
    }
    Ok(())
}

/// What this client refuses a frame for, before the connection is even
/// asked for.
///
/// Read on the thread that owns the runtime, because reading the frame
/// is reading JavaScript values. What comes back is the description and
/// the sentence to refuse the call with, and never both.
pub fn read(env: &Env, name: &str, data: Unknown<'_>) -> std::result::Result<Described, String> {
    identifier(name, "a registered frame")?;
    let described = crate::frame::read(env, data)?;
    if described.columns.is_empty() {
        return Err(
            "this frame has no columns, and a table whose rows hold nothing is not a table"
                .to_string(),
        );
    }
    for column in &described.columns {
        identifier(&column.name, "a column of a registered frame")?;
    }
    Ok(described)
}

/// What a closed connection says, kept here so the three calls say it
/// once.
pub fn closed() -> String {
    CLOSED.to_string()
}
