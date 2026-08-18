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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask, ValueType};
use napi_derive::napi;
use zudb::query::{QueryResult, Value};
use zudb::{Config, Database, DiagnosticRecord, Interrupt, ZuError};

use crate::cancel::Watch;
use crate::error::{aborted, raise, usage};
use crate::stream::{self, Started, ZuCursor};
use crate::value::{Names, from_js, to_js};

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
    path: String,
    read_only: bool,
}

/// Opens the database at `path` and connects to it.
///
/// Creates one when the path holds nothing, which is what a first
/// program expects and what every embedded database does. A read-only
/// connection never creates anything.
#[napi(ts_return_type = "Promise<Connection>")]
pub fn connect(path: String, options: Option<ConnectOptions>) -> AsyncTask<ConnectTask> {
    AsyncTask::new(ConnectTask { path, options })
}

pub struct ConnectTask {
    path: String,
    options: Option<ConnectOptions>,
}

impl<'task> ScopedTask<'task> for ConnectTask {
    type Output = std::result::Result<Opened, ZuError>;
    type JsValue = ClassInstance<'task, Connection>;

    fn compute(&mut self) -> Result<Self::Output> {
        let read_only = self
            .options
            .as_ref()
            .and_then(|options| options.read_only)
            .unwrap_or(false);
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
        Ok(open(PathBuf::from(&self.path), read_only, config))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let opened = output.map_err(|err| raise(env, err))?;
        let mut instance = Connection {
            interrupt: opened.conn.interrupt(),
            inner: Arc::new(Mutex::new(Some(opened.conn))),
            alive: Arc::new(AtomicBool::new(true)),
            path: opened.path,
            read_only: opened.read_only,
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance)?;
        Ok(instance)
    }
}

/// Puts `dispose` on the connection under `Symbol.asyncDispose`, which
/// is the key `await using` looks up and the one thing about this class
/// that cannot be spelled in the attribute that declares the rest of
/// it: a method's name there is a string, and this key is a symbol.
///
/// On the instance rather than on the prototype, because reaching the
/// prototype from here means calling `Object.getPrototypeOf` through
/// three more layers of FFI for a property that is looked up once per
/// connection either way.
fn wire_disposal(env: &Env, instance: &mut ClassInstance<'_, Connection>) -> Result<()> {
    // `Symbol` is a function, and the well-known symbols hang off it as
    // properties of that function.
    let symbols: Function<'_, (), Unknown<'_>> = env.get_global()?.get_named_property("Symbol")?;
    let key: Unknown<'_> = symbols.get_named_property("asyncDispose")?;
    // A runtime old enough to lack the symbol still has `dispose` and
    // `close`, so it loses the syntax rather than the capability.
    if key.get_type()? != ValueType::Symbol {
        return Ok(());
    }
    let dispose: Unknown<'_> = instance.get_named_property("dispose")?;
    instance.set_property(key, dispose)
}

pub struct Opened {
    conn: zudb::Connection,
    path: String,
    read_only: bool,
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
        path: stored,
        read_only,
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

    /// Whether the connection is still open.
    #[napi(getter)]
    pub fn open(&self) -> bool {
        self.alive.load(Ordering::Acquire)
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
        statement: String,
        params: Option<Object<'_>>,
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
        statement: String,
        params: Option<Object<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ExecTask> {
        AsyncTask::new(ExecTask(self.task(env, statement, params, options)))
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
        statement: String,
        params: Option<Object<'_>>,
        options: Option<Object<'_>>,
    ) -> ZuCursor {
        // Read here rather than on the statement's thread, because
        // reading a JavaScript value is something only the thread that
        // owns the runtime may do. So is adding the listener the signal
        // is watched through.
        let bound = if self.alive.load(Ordering::Acquire) {
            batch_rows(options.as_ref()).and_then(|batch_rows| {
                Ok((
                    bind(env, params)?,
                    batch_rows,
                    watch(env, options, self.interrupt.clone())?,
                ))
            })
        } else {
            Err(CLOSED.to_string())
        };
        let (params, batch_rows, watch, refused) = match bound {
            Ok((params, batch_rows, watch)) => (params, batch_rows, watch, None),
            Err(message) => (Vec::new(), None, None, Some(message)),
        };
        stream::open(
            Started {
                inner: Arc::clone(&self.inner),
                alive: Arc::clone(&self.alive),
                statement,
                params,
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
        statement: String,
        params: Option<Object<'_>>,
        options: Option<Object<'_>>,
    ) -> QueryTask {
        // The parameters are read here rather than on the threadpool
        // thread, because reading a JavaScript value is something only
        // the thread that owns the runtime may do. So is adding the
        // listener the signal is watched through.
        let bound = if self.alive.load(Ordering::Acquire) {
            bind(env, params)
                .and_then(|params| Ok((params, watch(env, options, self.interrupt.clone())?)))
        } else {
            Err(CLOSED.to_string())
        };
        let (params, watch, refused) = match bound {
            Ok((params, watch)) => (params, watch, None),
            Err(message) => (Vec::new(), None, Some(message)),
        };
        QueryTask {
            inner: Arc::clone(&self.inner),
            statement,
            params,
            watch,
            refused,
        }
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

/// What a closed connection says, wherever it is noticed.
pub(crate) const CLOSED: &str =
    "the connection is closed, so there is nothing left to run a statement on";

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

/// Reads the parameter object into the values the engine binds.
///
/// Every failure comes back as the message to refuse the call with,
/// including a boundary failure, because a caller who cannot be given
/// the value they passed is being told the same thing either way and
/// would rather hear it as a rejection than as a throw.
pub(crate) fn bind(
    env: &Env,
    params: Option<Object<'_>>,
) -> std::result::Result<Vec<(String, Value)>, String> {
    let Some(params) = params else {
        return Ok(Vec::new());
    };
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

pub struct QueryTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    statement: String,
    params: Vec<(String, Value)>,
    /// The signal watching this statement, when the caller gave one.
    watch: Option<Watch>,
    /// Why this statement is not going to run, when it is not.
    refused: Option<String>,
}

impl QueryTask {
    /// Runs the statement, with the names of the tables it saw.
    ///
    /// The names are read while the lock is held, because a catalog
    /// borrowed from the connection cannot outlive it and a result that
    /// names its tables has to carry them.
    fn run(&mut self) -> std::result::Result<(QueryResult, Names), Failure> {
        if let Some(message) = self.refused.take() {
            return Err(Failure::Usage(message));
        }
        let mut held = match self.inner.lock() {
            Ok(held) => held,
            // A thread that panicked inside the engine left the
            // connection in a state nothing here can vouch for, so this
            // says so rather than carrying on with it.
            Err(_) => {
                return Err(Failure::Usage(
                    "the connection was left in an unknown state by a statement that panicked"
                        .to_string(),
                ));
            }
        };
        // Closed between the call and the thread picking it up, which is
        // a race the caller cannot see and this has to check anyway.
        let Some(conn) = held.as_mut() else {
            return Err(Failure::Usage(CLOSED.to_string()));
        };
        // From here the connection is this statement's, so this is where
        // a signal can start stopping it and where it stops being able
        // to. A signal that fired first ends the statement without the
        // engine ever seeing it, which is the whole point of asking.
        if let Some(watch) = &self.watch
            && !watch.enter()
        {
            watch.leave();
            return Err(Failure::Aborted);
        }
        let params: Vec<(&str, Value)> = self
            .params
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect();
        let names = Names::of(conn.session_mut().catalog());
        let result = conn.query_with(&self.statement, &params);
        if let Some(watch) = &self.watch {
            watch.leave();
            // An interrupt is the engine's answer to somebody having
            // asked, and the only somebody here is the caller's signal.
            // Reported as an abort rather than as the engine condition,
            // because a caller who wrote `catch` around a timeout wants
            // their own reason back and not a GQLSTATUS.
            if watch.asked() && matches!(result, Err(ZuError::Interrupted)) {
                return Err(Failure::Aborted);
            }
        }
        Ok((result?, names))
    }

    /// The exception this rejects the caller's promise with.
    fn failed(&self, env: &Env, failure: Failure) -> Error {
        failed(env, failure, self.watch.as_ref())
    }

    /// Takes the listener back off the signal, whatever happened.
    fn release(&mut self, env: &Env) -> Result<()> {
        match self.watch.take() {
            Some(watch) => watch.release(env),
            None => Ok(()),
        }
    }
}

impl<'task> ScopedTask<'task> for QueryTask {
    type Output = std::result::Result<(QueryResult, Names), Failure>;
    type JsValue = Array<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let (result, names) = output.map_err(|failure| self.failed(env, failure))?;
        rows(env, &result, &names)
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
fn rows<'env>(env: &'env Env, result: &QueryResult, names: &Names) -> Result<Array<'env>> {
    let mut array = env.create_array(result.rows.len() as u32)?;
    for (ix, row) in result.rows.iter().enumerate() {
        let mut object = Object::new(env)?;
        for (column, value) in result.columns.iter().zip(row) {
            object.set(column.as_str(), to_js(env, value, names)?)?;
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
pub struct ExecTask(QueryTask);

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
