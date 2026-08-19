//! Appending rows to a table that already exists.
//!
//! `INSERT` is the wrong shape for loading data. Every row is parsed,
//! bound, planned and committed, and the commit is the expensive part,
//! so a million rows is a million commits and the load is dominated by
//! durability work nobody asked for. An appender is the right shape:
//! rows go into per-column buffers in memory, and a flush turns the
//! whole buffer into one commit.
//!
//! ```js
//! await using rows = await conn.appender('person')
//! for (const [id, name] of people) rows.appendRow([id, name])
//! await rows.flush()
//! ```
//!
//! A row is every column of the table, in the order the table declares
//! them, and a column is a position rather than a name: naming the
//! columns per row would cost a lookup per value on the one path where
//! per-value cost is the whole story, and a loader knows its own column
//! order.
//!
//! ## The one synchronous call in this client
//!
//! `appendRow` is not a promise. Everything else here is, because
//! everything else reaches the database and a native call that reaches
//! a database on the event loop is a production incident. An append
//! reaches nothing: it converts the values in front of it and pushes
//! them onto a vector, which is bounded by the width of one row and
//! cannot wait on a file, a lock the engine holds, or another thread.
//! Making it a promise would put a microtask between the loop and a
//! memcpy, and a million-row load would allocate a million promises to
//! describe work that had already finished.
//!
//! So it is synchronous, and being synchronous it throws rather than
//! rejecting. The exception is the same `ZuUsageError` every other
//! refusal here is, so `isZuError(caught)` recognizes it in a `catch`
//! either way, and everything that touches the file, which is `flush`,
//! `close` and the disposal, is a promise like the rest of the client.
//!
//! ## Why the buffers are here and not in the engine
//!
//! The engine's appender borrows the connection for as long as it
//! lives, which is a promise a JavaScript object cannot make, so this
//! one buffers here and opens an engine appender for the length of a
//! flush. That is a catalog read per flush, against a commit and a fold
//! that cost time proportional to the table, so it is not where a load
//! spends its time. What it buys is an appender that can be held in a
//! variable, passed to a function and closed by an `await using`.
//!
//! Rows an appender writes are not part of an open transaction. It
//! writes through the file rather than through the session, so a
//! `ROLLBACK` after a flush does not take them back. That is the
//! engine's shape today rather than a decision made here, and it is the
//! reason a load and a transaction are two different things to reach
//! for.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use napi_derive::napi;
use zudb::Field;
use zudb::zu1::catalog::Catalog;

use crate::buffer::{Column, Mismatch, named};
use crate::conn::{CLOSED, Failure, POISONED, failed, wire_disposal, with};
use crate::error::usage;

/// Rows on their way into a table, buffered until they are flushed.
///
/// Take one with `Connection.appender`, append rows to it, and close
/// it. What is buffered is columnar and typed from the table's own
/// columns, read when the appender opened, so a value that does not
/// belong in a column is refused by the call that appended it rather
/// than at the flush that would have carried it, and the message names
/// the column it did not fit.
#[napi]
pub struct Appender {
    /// The same three handles every statement on this connection uses,
    /// rather than a reference to the JavaScript object, so an appender
    /// whose `Connection` was collected still has somewhere to write.
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    table: String,
    state: Arc<State>,
    /// Whether a flush is in flight.
    ///
    /// It is set on the thread that owns the runtime, before the task
    /// is handed back, and cleared on that same thread when the task
    /// ends. So a call that finds it false knows no flush can start
    /// before its own turn is over, which is what lets an append take
    /// the buffers' lock without ever waiting for one: the only other
    /// holder of that lock is a flush, and there is none.
    busy: Arc<AtomicBool>,
}

/// What is buffered, and how much of it has gone in.
///
/// The three counts sit outside the lock rather than inside it, for the
/// reason `open` and `inTransaction` do on a connection: asking how many
/// rows are buffered should not queue behind the commit that is writing
/// them, and a getter that could wait is a getter that can stop the
/// event loop.
struct State {
    /// One buffer per column of the table, in the order the table
    /// declares them, built when the appender opened. A flush empties
    /// these and keeps them, since the next batch is the same shape as
    /// the last.
    cols: Mutex<Vec<Buffer>>,
    /// Rows buffered and not yet written, kept beside the columns so
    /// that a table with no columns can still answer for itself.
    buffered: AtomicU64,
    /// Rows this appender has committed, across every flush.
    committed: AtomicU64,
    open: AtomicBool,
}

/// One column of the table, and what has been buffered for it.
pub struct Buffer {
    name: String,
    values: Column,
    /// The node table whose rows this column names, for the two columns
    /// of a rel table and for nothing else: a row of one is an offset
    /// into the table the edge runs from and an offset into the table
    /// it runs to. A negative offset is no row of anything and is
    /// refused where it was appended; whether the row is there at all
    /// is a question only the flush can answer, since the table may be
    /// being appended to at the same time.
    ends: Option<u32>,
}

#[napi]
impl Appender {
    /// The table these rows are going into.
    #[napi(getter)]
    pub fn table(&self) -> String {
        self.table.clone()
    }

    /// Rows buffered and not yet written.
    #[napi(getter)]
    pub fn buffered(&self) -> f64 {
        self.state.buffered.load(Ordering::Acquire) as f64
    }

    /// Rows this appender has committed, across every flush.
    #[napi(getter)]
    pub fn committed(&self) -> f64 {
        self.state.committed.load(Ordering::Acquire) as f64
    }

    /// Whether this appender has been closed.
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        !self.state.open.load(Ordering::Acquire)
    }

    /// Appends one row, which is one value per column of the table, in
    /// the order the table declares them.
    ///
    /// Synchronous, and the only synchronous call in this client: the
    /// values go into memory and nothing else happens, so this is a
    /// conversion and a push per column. Being synchronous it throws
    /// rather than rejecting, with the same `ZuUsageError` every other
    /// refusal here carries.
    ///
    /// A row of the wrong width, or with a value that does not fit the
    /// column, is refused with nothing of it kept, so the appender is
    /// still usable once the caller has fixed the row.
    #[napi(ts_args_type = "row: readonly ZuAppendValue[]")]
    pub fn append_row(&self, env: &Env, row: Unknown<'_>) -> Result<()> {
        let mut cols = self.writable(env)?;
        self.state
            .append(env, &mut cols, &self.table, row)
            .map_err(|why| raised(env, why, ""))
    }

    /// Appends every row of an array of rows.
    ///
    /// The same thing in a loop, and worth a call of its own because it
    /// is one check and one lock for the batch rather than one per row.
    /// A row that is refused stops the call where it was refused and the
    /// rows before it stay buffered: nothing here is a transaction until
    /// the flush, and throwing away work the caller can keep would not
    /// make it one. What it answers is how many rows went in, which is
    /// where a caller who caught the refusal starts again.
    #[napi(ts_args_type = "rows: readonly (readonly ZuAppendValue[])[]")]
    pub fn append_rows(&self, env: &Env, rows: Unknown<'_>) -> Result<f64> {
        let mut cols = self.writable(env)?;
        if !rows.is_array()? {
            return Err(usage(
                env,
                format!(
                    "the rows are {}, and rows are an array of arrays, one value per column",
                    named(&rows)
                ),
            ));
        }
        let rows = Object::from_unknown(rows)?;
        let len = rows.get_array_length()?;
        for ix in 0..len {
            let row: Unknown<'_> = rows.get_element(ix)?;
            if let Err(why) = self.state.append(env, &mut cols, &self.table, row) {
                // The index is what a caller needs and the only thing
                // this call knows that the row itself does not, since
                // the row that failed is somewhere inside an array they
                // handed over whole.
                return Err(raised(env, why, &format!("row {ix} of these: ")));
            }
        }
        Ok(len as f64)
    }

    /// Writes every buffered row and makes it readable, and answers how
    /// many rows this appender has committed in all.
    ///
    /// One commit, whatever the buffer holds: the values are sealed into
    /// the file, one frame naming them is synced to the log, and the
    /// fold that follows puts them where every query looks. On return
    /// the buffer is empty and the rows are there. A flush with nothing
    /// buffered touches no file, so a loader can flush on a timer
    /// without writing empty commits.
    ///
    /// A flush that fails keeps its rows, so that what did not go in is
    /// still there to be looked at and tried again.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn flush(&self) -> AsyncTask<FlushTask> {
        self.write(false)
    }

    /// Flushes what is left and answers how many rows this appender
    /// committed in all.
    ///
    /// Closing twice is not an error and writes nothing the second
    /// time, because an `await using` that closed early would otherwise
    /// fail on the way out.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn close(&self) -> AsyncTask<FlushTask> {
        self.write(true)
    }

    /// The close `await using` calls, which is the intended way to
    /// scope an appender.
    ///
    /// It flushes, whether the block ended well or badly, which is the
    /// opposite of what the disposal of a transaction here does and is
    /// the same answer the Python client gives. The two differ because
    /// the question differs: a transaction that leaves its scope
    /// unfinished is a unit of work nobody completed, and a buffer that
    /// leaves its scope unwritten is a loader that read a million rows
    /// and threw them away. A caller who wants the rows gone writes
    /// `discard()` and gets exactly that.
    ///
    /// It is also reachable as `Symbol.asyncDispose`, which is what
    /// `await using` actually looks for and which [`wire_disposal`] puts
    /// on every appender as it is made.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn dispose(&self) -> AsyncTask<FlushTask> {
        self.write(true)
    }

    /// Throws away what is buffered and answers how many rows that was.
    ///
    /// The way out of a load that went wrong halfway. A caller who has
    /// noticed that the rows are wrong wants them gone, and closing
    /// would write them. Rows an earlier flush committed are committed,
    /// and this does not reach them.
    #[napi]
    pub fn discard(&self, env: &Env) -> Result<f64> {
        let mut cols = self.writable(env)?;
        Ok(self.state.empty(&mut cols) as f64)
    }

    /// The task a flush runs as, whether or not it is going to work.
    fn write(&self, closing: bool) -> AsyncTask<FlushTask> {
        AsyncTask::new(self.flushing(closing))
    }

    /// The flush itself, built where the claim on the appender is taken.
    fn flushing(&self, closing: bool) -> FlushTask {
        // Claimed here, on the thread that owns the runtime, so that a
        // second flush issued before the first has answered is refused
        // rather than queued behind it on a threadpool thread. Two
        // commits of the same buffer would be two writes whose order
        // nobody chose, and a caller who wanted them overlapped wanted
        // two appenders.
        let refused = match self.busy.swap(true, Ordering::AcqRel) {
            true => Some(BUSY.to_string()),
            false => None,
        };
        FlushTask {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
            state: Arc::clone(&self.state),
            // Given back only by the task that took it, so the one that
            // was refused does not release the one that is running.
            busy: match refused {
                Some(_) => None,
                None => Some(Arc::clone(&self.busy)),
            },
            table: self.table.clone(),
            closing,
            refused,
        }
    }

    /// The buffers, for a call that writes to them.
    ///
    /// The lock is never waited for. A flush is the only other thing
    /// that takes it, a flush is in flight exactly while `busy` is set,
    /// and `busy` is set and cleared on this thread, so a call that gets
    /// past the first line has the lock to itself. That is the whole
    /// reason for refusing rather than queueing: an append that waited
    /// for a flush would be an event loop waiting for a write to disk.
    ///
    /// The connection is checked as well as the appender, because a row
    /// appended through a closed connection has nowhere to go and the
    /// buffer is the only thing that would take it. Left to the flush,
    /// the same call would be refused or not depending on whether the
    /// batch happened to fill, which is a rule nobody can hold in their
    /// head. It is refused here instead, at the call that made the
    /// mistake, whatever the buffer is holding.
    fn writable(&self, env: &Env) -> Result<MutexGuard<'_, Vec<Buffer>>> {
        if self.busy.load(Ordering::Acquire) {
            return Err(usage(env, BUSY));
        }
        if !self.state.open.load(Ordering::Acquire) {
            return Err(usage(env, FINISHED));
        }
        if !self.alive.load(Ordering::Acquire) {
            return Err(usage(env, CLOSED));
        }
        self.state.cols.lock().map_err(|_| usage(env, POISONED))
    }
}

impl State {
    /// One row into the buffers, or nothing at all.
    fn append(
        &self,
        env: &Env,
        cols: &mut [Buffer],
        table: &str,
        row: Unknown<'_>,
    ) -> std::result::Result<(), Refused> {
        // One call rather than a type and then a kind, because an array
        // is an object and asking twice is a boundary crossing per row on
        // the one path where crossings are the cost.
        if !row.is_array()? {
            return Err(Refused::Row(format!(
                "this row is {}, and a row is an array of one value per column of '{table}': {}",
                named(&row),
                names(cols)
            )));
        }
        let row = Object::from_unknown(row)?;
        let len = row.get_array_length()?;
        let width = cols.len() as u32;
        if len != width {
            return Err(Refused::Row(format!(
                "this row carries {len} value{} and '{table}' takes {width}: {}",
                match len {
                    1 => "",
                    _ => "s",
                },
                names(cols)
            )));
        }
        for at in 0..len {
            let value: Unknown<'_> = row.get_element(at)?;
            if let Err(why) = cols[at as usize].take(env, &value, table, at) {
                return Err(refuse(cols, at, why));
            }
        }
        self.buffered.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    /// The write itself, off the event loop.
    fn write(
        &self,
        cols: &mut [Buffer],
        inner: &Mutex<Option<zudb::Connection>>,
        alive: &AtomicBool,
        in_txn: &AtomicBool,
        table: &str,
    ) -> std::result::Result<u64, Failure> {
        let rows = self.buffered.load(Ordering::Acquire);
        if rows == 0 {
            return Ok(self.committed.load(Ordering::Acquire));
        }
        with(inner, alive, in_txn, |conn| {
            self.reachable(cols, conn, rows)?;
            let mut appender = conn.appender(table)?;
            // One vector, refilled per row rather than allocated per
            // row, which over a million rows is one allocation rather
            // than a million. The fields borrow the buffers, which is
            // what keeps a string column to one copy on the way in and
            // one on the way out rather than three.
            let mut row: Vec<Field<'_>> = Vec::with_capacity(cols.len());
            for at in 0..rows as usize {
                row.clear();
                row.extend(cols.iter().map(|column| column.values.field(at)));
                appender.append_row(&row[..]).map_err(|err| {
                    // The engine reports the value and the column;
                    // which row of the batch it was is the part only
                    // this side knows, and it is the part that says
                    // where to look.
                    Failure::Usage(format!("row {at} of this batch: {err}"))
                })?;
            }
            appender.close()?;
            Ok(())
        })?;
        self.empty(cols);
        Ok(self.committed.fetch_add(rows, Ordering::AcqRel) + rows)
    }

    /// Every edge joins two rows that are there, checked against the row
    /// counts as they stand at the flush.
    ///
    /// This is the flush's own check and not the engine's, because the
    /// engine's comes too late: an edge to a row that is not there is
    /// refused when the write is folded into the graph, which is after
    /// the write is durable, and the frame it leaves behind is refused
    /// again by every writer that opens the database afterwards. Caught
    /// here, the batch is refused and the file is untouched.
    ///
    /// The counts are read at the flush and not when the appender
    /// opened, because the rows a later edge names may be written by an
    /// earlier flush of another appender on the same connection, and an
    /// edge to a row that arrived in the meantime is a good edge.
    fn reachable(
        &self,
        cols: &[Buffer],
        conn: &mut zudb::Connection,
        rows: u64,
    ) -> std::result::Result<(), Failure> {
        if cols.iter().all(|column| column.ends.is_none()) {
            return Ok(());
        }
        let catalog = catalog(conn)?;
        for column in cols {
            let Some(end) = column.ends else { continue };
            let Some(node) = catalog.node_by_id(end) else {
                continue;
            };
            for at in 0..rows as usize {
                let Field::Int(offset) = column.values.field(at) else {
                    continue;
                };
                if offset as u64 >= node.node_count {
                    return Err(Failure::Usage(format!(
                        "row {at} of this batch joins row {offset} of '{}', which has {} rows \
                         in it, so the rows an edge joins have to be written before the edge is",
                        node.name, node.node_count
                    )));
                }
            }
        }
        Ok(())
    }

    /// Empties the buffers and answers how many rows were dropped, which
    /// is what `discard` reports and what a flush has already written.
    fn empty(&self, cols: &mut [Buffer]) -> u64 {
        cols.iter_mut().for_each(|column| column.values.clear());
        self.buffered.swap(0, Ordering::AcqRel)
    }
}

/// The columns of the table, named, for a message about a row that is the
/// wrong shape. A caller who miscounted wants to see what the count was
/// supposed to be made of.
fn names(cols: &[Buffer]) -> String {
    cols.iter()
        .map(|column| column.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Takes back the values a refused row managed to write, so that a
/// refused row is a row that never happened rather than half of one
/// nobody can find. A ragged buffer would be refused by the ingest at the
/// flush, a long way from the row that caused it.
fn refuse(cols: &mut [Buffer], written: u32, err: Refused) -> Refused {
    for column in cols.iter_mut().take(written as usize) {
        column.values.pop();
    }
    err
}

impl Buffer {
    /// One value into this column, or the reason it does not go there.
    ///
    /// The column's own name is in the message, and its position too,
    /// because a row is written by position and read by name and a
    /// caller who has them the wrong way round needs both to see it.
    fn take(
        &mut self,
        env: &Env,
        value: &Unknown<'_>,
        table: &str,
        at: u32,
    ) -> std::result::Result<(), Refused> {
        self.values.push(env, *value).map_err(|why| match why {
            Mismatch::Wanted(holds) => Refused::Row(format!(
                "value {at} of this row is {} and column '{}' of '{table}' holds {holds}",
                named(value),
                self.name
            )),
            Mismatch::Says(reason) => Refused::Row(format!(
                "value {at} of this row does not go in column '{}' of '{table}': {reason}",
                self.name
            )),
            Mismatch::Boundary(err) => Refused::Boundary(err),
        })?;
        // Checked after the value is read rather than before, because
        // what makes an offset negative is the number it turned into and
        // a `bigint` and a `number` are two different ways of arriving at
        // the same one. Taken back here, so the column is as it was.
        if self.ends.is_some()
            && let Column::Int(offsets) = &self.values
            && let Some(&offset) = offsets.last()
            && offset < 0
        {
            self.values.pop();
            return Err(Refused::Row(format!(
                "value {at} of this row is {offset}, and column '{}' of '{table}' holds row \
                 offsets, which count from zero",
                self.name
            )));
        }
        Ok(())
    }
}

/// A row that did not go in, and why.
///
/// Words rather than an exception, because the call that made the row is
/// not always the call that reports it: `appendRows` knows which row of
/// the batch it was and the row itself does not, and a sentence can have
/// that put in front of it where an exception that has already been built
/// cannot.
enum Refused {
    Row(String),
    /// The boundary itself failed, which is already an exception and is
    /// not this side's to word.
    Boundary(Error),
}

impl From<Error> for Refused {
    fn from(err: Error) -> Refused {
        Refused::Boundary(err)
    }
}

/// The exception for a refused row, with a sentence in front of it for a
/// refusal being reported from further out than it was made.
fn raised(env: &Env, why: Refused, opening: &str) -> Error {
    match why {
        Refused::Row(reason) => usage(env, format!("{opening}{reason}")),
        Refused::Boundary(err) => err,
    }
}

/// Opening one, which is the call that reads the table's shape.
pub struct OpenTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    table: String,
    /// Why this is not going to run, when it is not.
    refused: Option<String>,
}

impl OpenTask {
    pub(crate) fn new(
        inner: Arc<Mutex<Option<zudb::Connection>>>,
        alive: Arc<AtomicBool>,
        in_txn: Arc<AtomicBool>,
        table: String,
        refused: Option<String>,
    ) -> OpenTask {
        OpenTask {
            inner,
            alive,
            in_txn,
            table,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for OpenTask {
    type Output = std::result::Result<Vec<Buffer>, Failure>;
    type JsValue = ClassInstance<'task, Appender>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let table = self.table.clone();
        Ok(with(&self.inner, &self.alive, &self.in_txn, |conn| {
            let cols = shape(conn, &table)?;
            // Opened and dropped, purely to find out whether it can be
            // opened at all: a column that holds a null, a table a keyed
            // rel table is built over, and a read-only connection are all
            // refused here rather than at the first flush. A caller about
            // to buffer a million rows wants to hear about them now.
            //
            // After the shape rather than before it, because a table that
            // is not there is the common mistake and the words for it
            // belong to the client that knows it is opening an appender.
            conn.appender(&table).map(drop)?;
            Ok(cols)
        }))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let cols = output.map_err(|failure| failed(env, failure, None))?;
        let mut instance = Appender {
            inner: Arc::clone(&self.inner),
            alive: Arc::clone(&self.alive),
            in_txn: Arc::clone(&self.in_txn),
            table: self.table.clone(),
            state: Arc::new(State {
                cols: Mutex::new(cols),
                buffered: AtomicU64::new(0),
                committed: AtomicU64::new(0),
                open: AtomicBool::new(true),
            }),
            busy: Arc::new(AtomicBool::new(false)),
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance, "dispose")?;
        Ok(instance)
    }
}

/// Writing a batch, which is the one commit a load is made of.
pub struct FlushTask {
    inner: Arc<Mutex<Option<zudb::Connection>>>,
    alive: Arc<AtomicBool>,
    in_txn: Arc<AtomicBool>,
    state: Arc<State>,
    /// The claim on the appender, held by the task that took it and
    /// given back when it ends.
    busy: Option<Arc<AtomicBool>>,
    table: String,
    /// Whether this flush is also the last one.
    closing: bool,
    refused: Option<String>,
}

impl<'task> ScopedTask<'task> for FlushTask {
    type Output = std::result::Result<u64, Failure>;
    type JsValue = f64;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let Ok(mut cols) = self.state.cols.lock() else {
            return Ok(Err(Failure::Usage(POISONED.to_string())));
        };
        if !self.state.open.load(Ordering::Acquire) {
            // A close of a closed appender writes nothing and says
            // nothing, which is what makes an early close and an `await
            // using` work together. A flush is a caller asking for a
            // write and is owed the answer that there is nowhere to
            // write it.
            return Ok(match self.closing {
                true => Ok(self.state.committed.load(Ordering::Acquire)),
                false => Err(Failure::Usage(FINISHED.to_string())),
            });
        }
        let written = self.state.write(
            &mut cols,
            &self.inner,
            &self.alive,
            &self.in_txn,
            &self.table,
        );
        // Left open when the write failed, because the rows are still
        // buffered and an appender that could not be written to is one a
        // caller may want to try again, whereas a closed one has nowhere
        // to put them.
        if self.closing && written.is_ok() {
            self.state.open.store(false, Ordering::Release);
        }
        Ok(written)
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        output
            .map(|committed| committed as f64)
            .map_err(|failure| failed(env, failure, None))
    }

    fn finally(self, _env: Env) -> Result<()> {
        if let Some(busy) = &self.busy {
            busy.store(false, Ordering::Release);
        }
        Ok(())
    }
}

/// The catalog as the file has it, which is not always the one the
/// session is holding.
///
/// A session reloads its catalog when a statement runs, and an appender
/// is not a statement: a flush commits its rows and folds them in
/// without the session hearing about it, so the row counts the session
/// remembers are the counts from the last statement. Loading it costs a
/// read of a block chain, once per appender opened and once per flush of
/// a rel table, which is nothing beside the commit either of them is
/// about to do.
fn catalog(conn: &mut zudb::Connection) -> std::result::Result<Catalog, Failure> {
    let file = conn.session_mut().file_mut()?;
    Ok(Catalog::load(file)?)
}

/// The columns of the table an appender was opened on, in the order it
/// declares them.
///
/// A node table's columns are the ones the property store holds, with
/// the types it holds them as, which is what the engine's appender
/// checks a row against. A rel table has no property columns: a row of
/// one is the two ends of an edge, as offsets into the tables it runs
/// between, so those are the two columns and they are named for what
/// they are.
///
/// Read here rather than left to the flush so that a value that does not
/// belong in a column is refused by the call that appended it. A row is
/// refused a million rows before the flush that would have carried it,
/// and the message names the column rather than guessing at it from the
/// values that came before.
fn shape(conn: &mut zudb::Connection, table: &str) -> std::result::Result<Vec<Buffer>, Failure> {
    let catalog = catalog(conn)?;
    if let Some(rel) = catalog.rel_by_name(table) {
        let ends = [rel.from, rel.to];
        let named = |id: u32, fallback: &str| {
            catalog
                .node_tables()
                .iter()
                .find(|node| node.id == id)
                .map_or_else(|| fallback.to_string(), |node| node.name.clone())
        };
        // Named for the tables the edge runs between, since that is what
        // a row of a rel table is and there is nothing else to call the
        // two columns.
        return Ok(vec![
            Buffer {
                name: format!("from {}", named(ends[0], "the source table")),
                values: Column::Int(Vec::new()),
                ends: Some(ends[0]),
            },
            Buffer {
                name: format!("to {}", named(ends[1], "the destination table")),
                values: Column::Int(Vec::new()),
                ends: Some(ends[1]),
            },
        ]);
    }
    let id = catalog
        .node_by_name(table)
        .map(|node| node.id)
        .ok_or_else(|| {
            Failure::Usage(format!(
                "there is no table '{table}' in this database, and an appender writes into a \
                 table that is already there"
            ))
        })?;
    let file = conn.session_mut().file_mut()?;
    let directory = zudb::zu1::props::load_props(file, id)?.ok_or_else(|| {
        Failure::Usage(format!(
            "'{table}' stores no properties, so it has no columns to append to"
        ))
    })?;
    directory
        .columns
        .iter()
        .map(|column| {
            Ok(Buffer {
                name: column.name.clone(),
                values: Column::for_type(&column.ty).ok_or_else(|| {
                    Failure::Usage(format!(
                        "column '{}' of '{table}' holds {}, which this client cannot yet \
                         append to",
                        column.name, column.ty
                    ))
                })?,
                ends: None,
            })
        })
        .collect()
}

/// What an appender that has already been closed says.
const FINISHED: &str = "this appender is closed, and a closed appender has already written \
     everything it was given";

/// What an appender says while a flush of its own is still running.
///
/// A flush holds the buffers for as long as the commit takes, and the
/// commit is off the event loop where waiting is allowed. Waiting for it
/// here is not: an append that blocked on a flush would stop the loop
/// for the length of a write to disk. So it is refused, the same way a
/// statement behind a half-read stream is, and awaiting the flush is the
/// answer to both.
const BUSY: &str = "a flush of this appender has not finished, and its rows are not yours to \
     add to until it has: await the flush";
