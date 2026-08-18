//! A statement read a batch at a time, instead of all at once.
//!
//! A result that does not fit in memory is the reason this exists, and
//! a result the caller will not read all of is the reason it stops
//! properly. The engine's shape for both is a sink: it hands over a
//! batch of rows, the sink says whether it wants more, and a sink that
//! says no ends the scan at the boundary an interrupt is answered at.
//! That is a push, and JavaScript wants a pull, so the two are joined
//! by a channel of two batches and a thread of this statement's own.
//!
//! The thread rather than libuv's threadpool, because a stream lasts as
//! long as the reader takes and the threadpool has four threads in it
//! by default: a statement parked there waiting for a `for await` body
//! to come round again is a quarter of every other library's file reads
//! and DNS lookups gone. The channel is bounded because that is what
//! backpressure is. A reader that stops reading stops the scan two
//! batches later rather than buffering a database into memory behind
//! it.
//!
//! Nothing here waits on the thread that owns the runtime. The rows are
//! copied out of the batch on the statement's thread, turned into
//! JavaScript values on the runtime's thread, and every wait happens on
//! libuv's threadpool, where waiting is what the thread is for.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use napi_derive::napi;
use zudb::query::Value;
use zudb::{Batch, Flow, Streamed, ZuError};

use crate::cancel::{Guard, Watch};
use crate::conn::{CLOSED, Failure, beside, failed, notices};
use crate::value::{Names, to_js};

/// How many batches may sit between the statement and the reader.
///
/// Two, so that one is being turned into JavaScript values while the
/// next is being made, and no more, because everything past that is
/// memory spent to hide a reader slower than the scan. It is the whole
/// of the backpressure and it is deliberately small.
const QUEUE: usize = 2;

/// How long the statement's thread waits on a full queue before it
/// looks up to see whether anybody still wants the rows.
///
/// Room in the queue wakes it exactly, so this is not how a batch is
/// handed over: it is how a connection closed underneath a stream gets
/// noticed, which is the one thing that changes without anybody being
/// able to say so through the queue. Short enough that closing returns
/// promptly, long enough that it is never the reason for a wakeup.
const PAUSE: Duration = Duration::from_millis(25);

/// What a lock says when the thread that held it panicked.
const POISONED: &str = "the stream was left in an unknown state by a thread that panicked";

/// What every batch of one statement shares.
///
/// The column names and the table names are the statement's rather than
/// the batch's, so they are made once and each batch carries a share of
/// them instead of a copy.
pub struct Head {
    columns: Vec<String>,
    names: Arc<Names>,
}

/// What the thread running the statement sends back.
enum Chunk {
    /// Rows, copied out of the batch they were borrowed in.
    Rows {
        head: Arc<Head>,
        rows: Vec<Vec<Value>>,
    },
    /// The statement ended, and this is what it ended as. Always the
    /// last thing sent.
    Done(std::result::Result<Streamed, Failure>),
}

/// The queue between the statement and the reader, with both ends able
/// to walk away.
///
/// A bounded channel is what this is, and the standard library's own
/// would do but for one thing: a send that waits for room and gives up
/// on a timeout is not on the stable side of it, and giving up is how a
/// statement notices a connection closed underneath it. So the queue is
/// written out. A condition variable is what makes room and arrival
/// exact rather than polled: nothing here sleeps waiting for a batch or
/// for space, and the timeout is only the backstop for the one thing
/// that happens without a word being said.
struct Pipe {
    held: Mutex<Held>,
    /// One variable for both directions. There is one writer and, in
    /// any program worth calling correct, one reader, so waking both is
    /// waking at most one of each.
    moved: Condvar,
}

struct Held {
    queue: VecDeque<Chunk>,
    /// The reader is gone, so the statement stops.
    closed: bool,
    /// The statement is over, so a reader that finds nothing is at the
    /// end rather than early.
    done: bool,
}

impl Pipe {
    fn new() -> Pipe {
        Pipe {
            held: Mutex::new(Held {
                queue: VecDeque::with_capacity(QUEUE),
                closed: false,
                done: false,
            }),
            moved: Condvar::new(),
        }
    }

    /// Hands a batch over, waiting for room. `false` means nobody is
    /// reading any more.
    ///
    /// `alive` is the connection, and it can go false while this waits,
    /// which is why the wait has a timeout at all: a close takes the
    /// same lock the statement holds, so a stream that waited forever
    /// for a reader that has gone would be a connection that could
    /// never be closed.
    fn send(&self, chunk: Chunk, alive: &AtomicBool) -> bool {
        let Ok(mut held) = self.held.lock() else {
            return false;
        };
        while held.queue.len() >= QUEUE && !held.closed {
            if !alive.load(Ordering::Acquire) {
                return false;
            }
            let Ok((next, _)) = self.moved.wait_timeout(held, PAUSE) else {
                return false;
            };
            held = next;
        }
        if held.closed {
            return false;
        }
        held.queue.push_back(chunk);
        drop(held);
        self.moved.notify_all();
        true
    }

    /// The next batch, waiting for one. `None` is the end.
    fn recv(&self) -> Option<Chunk> {
        let mut held = self.held.lock().ok()?;
        loop {
            if let Some(chunk) = held.queue.pop_front() {
                drop(held);
                self.moved.notify_all();
                return Some(chunk);
            }
            if held.done || held.closed {
                return None;
            }
            held = self.moved.wait(held).ok()?;
        }
    }

    /// The reader is gone. What is queued is dropped, because nobody
    /// will ever ask for it and it is a database's worth of rows.
    fn close(&self) {
        if let Ok(mut held) = self.held.lock() {
            held.closed = true;
            held.queue.clear();
        }
        self.moved.notify_all();
    }

    /// The statement is over and nothing else will be sent.
    fn finish(&self) {
        if let Ok(mut held) = self.held.lock() {
            held.done = true;
        }
        self.moved.notify_all();
    }
}

/// Everything the statement needs, held until the first read.
///
/// A stream starts when it is first read rather than when it is asked
/// for. A statement holds the connection for as long as it runs, and a
/// stream nobody has read yet holding it would make `conn.stream(...)`
/// on a line of its own stop every other statement on that connection
/// until the garbage collector noticed.
pub struct Started {
    pub inner: Arc<Mutex<Option<zudb::Connection>>>,
    pub alive: Arc<AtomicBool>,
    pub statement: String,
    pub params: Vec<(String, Value)>,
    pub batch_rows: Option<u32>,
    pub guard: Option<Guard>,
}

/// What a cursor and the thread feeding it share.
struct Live {
    /// Where batches are handed over.
    pipe: Pipe,
    /// Set by a reader that wants no more rows. The statement reads it
    /// between batches and stops the scan.
    stopped: AtomicBool,
    /// Taken by the first read, which is what starts the statement.
    start: Mutex<Option<Started>>,
    /// What the statement ended as, once it has. A failure is taken out
    /// to be thrown; a summary stays to be read.
    ended: Mutex<Option<std::result::Result<Streamed, Failure>>>,
    /// The signal watching this stream, kept here because taking it off
    /// again is something only the runtime's thread may do, and a read
    /// is the only thing here that happens on that thread.
    watch: Mutex<Option<Watch>>,
}

/// One statement, read a batch at a time.
///
/// This is the pull underneath the stream and not the shape a program
/// should be reaching for: `conn.stream(...)` gives back something that
/// is async-iterable, turns into the web's own `ReadableStream`, and
/// stops itself when the loop over it breaks.
#[napi]
pub struct ZuCursor {
    live: Arc<Live>,
}

/// Makes a cursor over a statement that has not started yet.
///
/// `refused` is the mistake this client caught before the engine saw
/// it. It is carried rather than thrown, so that a caller hears about
/// it where they hear about everything else a statement can do, which
/// is the first read.
pub(crate) fn open(started: Started, watch: Option<Watch>, refused: Option<String>) -> ZuCursor {
    let (start, ended) = match refused {
        Some(message) => (None, Some(Err(Failure::Usage(message)))),
        None => (Some(started), None),
    };
    let live = Live {
        pipe: Pipe::new(),
        stopped: AtomicBool::new(false),
        start: Mutex::new(start),
        ended: Mutex::new(ended),
        watch: Mutex::new(watch),
    };
    // A refused statement never runs and never sends, so the queue is
    // over before it began and the first read finds the end of a stream
    // that had nothing in it, and the reason why.
    if live.start.lock().is_ok_and(|start| start.is_none()) {
        live.pipe.finish();
    }
    ZuCursor {
        live: Arc::new(live),
    }
}

#[napi]
impl ZuCursor {
    /// The next batch of rows, or `null` once the statement has ended.
    ///
    /// An array of row objects with the column names beside it, which
    /// is the value `query` gives for a whole result and for the same
    /// reason: what a caller does with rows is iterate them.
    #[napi(ts_return_type = "Promise<ZuBatch | null>")]
    pub fn next(&self) -> AsyncTask<NextTask> {
        AsyncTask::new(NextTask {
            live: Arc::clone(&self.live),
        })
    }

    /// Stops the statement and waits for it to let go of the
    /// connection.
    ///
    /// Waits, because a stream abandoned while the next statement on
    /// the same connection is already being asked for would make that
    /// statement queue behind a scan nobody is reading. Stopping is not
    /// a failure: the rows already handed over stand, and the summary
    /// says the statement was stopped.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn cancel(&self) -> AsyncTask<CancelTask> {
        // Before the task rather than inside it, so that the statement
        // sees the word at the next batch instead of at the next free
        // thread on the threadpool.
        self.live.stopped.store(true, Ordering::Release);
        AsyncTask::new(CancelTask {
            live: Arc::clone(&self.live),
        })
    }

    /// What the statement did, once it has ended, and `null` until
    /// then.
    ///
    /// The column names are here as well as beside every batch, because
    /// a statement that gave back no rows gave back no batches either
    /// and its projection is still worth knowing.
    #[napi(getter, ts_return_type = "ZuSummary | null")]
    pub fn summary<'env>(&self, env: &'env Env) -> Result<Option<Object<'env>>> {
        let ended = self
            .live
            .ended
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?;
        let Some(Ok(streamed)) = ended.as_ref() else {
            return Ok(None);
        };
        let mut summary = Object::new(env)?;
        summary.set(
            "columns",
            Array::from_ref_vec_string(env, &streamed.columns)?,
        )?;
        // A count of what this client handed over, not an INT64 out of
        // the database, which is why it is a `number` and everything
        // that came out of a row is a `bigint`.
        summary.set("rows", streamed.rows as f64)?;
        summary.set("stopped", streamed.stopped)?;
        summary.set("streamed", streamed.streamed)?;
        summary.set("notices", notices(env, &streamed.notices)?)?;
        Ok(Some(summary))
    }
}

/// One read: the next batch, whatever it takes to get one.
pub struct NextTask {
    live: Arc<Live>,
}

/// What a read found.
pub enum Pulled {
    /// A batch, with what it takes to read it.
    Rows(Arc<Head>, Vec<Vec<Value>>),
    /// The statement has ended. Why is in `ended`.
    End,
}

impl NextTask {
    /// Starts the statement if this is the first read, then waits for a
    /// batch.
    fn pull(&self) -> Result<Pulled> {
        self.begin()?;
        match self.live.pipe.recv() {
            Some(Chunk::Rows { head, rows }) => Ok(Pulled::Rows(head, rows)),
            Some(Chunk::Done(ended)) => {
                self.ended(ended)?;
                Ok(Pulled::End)
            }
            // The queue is over, which happens only after the statement
            // has said what it ended as. So this is a read past the end
            // rather than a result that went missing.
            None => Ok(Pulled::End),
        }
    }

    /// Runs the statement on a thread of its own, once.
    ///
    /// Nothing to start is a stream that already started, or one
    /// somebody cancelled before it ever did, and both of those are a
    /// stream to read rather than one to run.
    fn begin(&self) -> Result<()> {
        let Some(started) = self
            .live
            .start
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?
            .take()
        else {
            return Ok(());
        };
        let live = Arc::clone(&self.live);
        std::thread::Builder::new()
            .name("zu-stream".to_string())
            .spawn(move || started.run(&live))
            .map_err(|err| {
                // The thread is the statement, so a machine that cannot
                // give one out has a stream that never runs. Said as a
                // failure of this read, which is the call that asked.
                self.live.pipe.finish();
                Error::from_reason(format!("the stream could not be given a thread: {err}"))
            })?;
        Ok(())
    }

    fn ended(&self, ended: std::result::Result<Streamed, Failure>) -> Result<()> {
        let mut slot = self
            .live
            .ended
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?;
        if slot.is_none() {
            *slot = Some(ended);
        }
        Ok(())
    }

    /// The end of the stream, as the caller sees it: nothing, or the
    /// failure that ended it.
    fn ending<'env>(&self, env: &'env Env) -> Result<Option<Array<'env>>> {
        let mut ended = self
            .live
            .ended
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?;
        if !matches!(ended.as_ref(), Some(Err(_))) {
            return Ok(None);
        }
        // Taken out, because a failure is thrown once and a second read
        // past the end is an end rather than the same exception again.
        let Some(Err(failure)) = ended.take() else {
            return Ok(None);
        };
        let watch = self
            .live
            .watch
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?;
        Err(failed(env, failure, watch.as_ref()))
    }

    /// Takes the listener back off the signal, once the statement it
    /// was watching has ended.
    ///
    /// Only then, because a stream outlives every one of its reads and
    /// the read that ends it is the last of many.
    fn release(&self, env: &Env) -> Result<()> {
        let ended = self
            .live
            .ended
            .lock()
            .map_err(|_| Error::from_reason(POISONED))?
            .is_some();
        match ended {
            true => release(&self.live, env),
            false => Ok(()),
        }
    }
}

/// Takes the listener off the signal and lets both references go.
///
/// On the thread that owns the runtime, which is where a task's
/// `finally` runs and the only place a reference may be touched. A
/// signal outlives the stream it stopped, often by a whole request, and
/// a listener left on one is a stream's worth of memory that never goes
/// away.
fn release(live: &Live, env: &Env) -> Result<()> {
    let watch = live
        .watch
        .lock()
        .map_err(|_| Error::from_reason(POISONED))?
        .take();
    match watch {
        Some(watch) => watch.release(env),
        None => Ok(()),
    }
}

impl<'task> ScopedTask<'task> for NextTask {
    type Output = Pulled;
    type JsValue = Option<Array<'task>>;

    fn compute(&mut self) -> Result<Self::Output> {
        self.pull()
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        match output {
            Pulled::Rows(head, rows) => batch(env, &head, &rows).map(Some),
            Pulled::End => self.ending(env),
        }
    }

    fn finally(self, env: Env) -> Result<()> {
        self.release(&env)
    }
}

/// One batch, as an array of row objects with the column names beside
/// them.
///
/// The names are not enumerable, exactly as they are not on a whole
/// result, so a batch spreads, stringifies and compares as the plain
/// array of rows it is.
fn batch<'env>(env: &'env Env, head: &Head, rows: &[Vec<Value>]) -> Result<Array<'env>> {
    let mut array = env.create_array(rows.len() as u32)?;
    for (ix, row) in rows.iter().enumerate() {
        let mut object = Object::new(env)?;
        for (column, value) in head.columns.iter().zip(row) {
            object.set(column.as_str(), to_js(env, value, &head.names)?)?;
        }
        array.set(ix as u32, object)?;
    }
    let mut object = array.coerce_to_object()?;
    object.define_properties(&[beside(
        env,
        "columns",
        Array::from_ref_vec_string(env, &head.columns)?,
    )?])?;
    Ok(array)
}

/// Stopping: say so, then read what is left until the statement ends.
///
/// The reading is the point. The thread hands a batch over and waits
/// for room, so a stream that was stopped and then abandoned would
/// leave a thread holding the connection until it next looked up.
/// Draining means that when this resolves, the statement is over and
/// the connection is free.
pub struct CancelTask {
    live: Arc<Live>,
}

impl<'task> ScopedTask<'task> for CancelTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        // A stream nobody read has no thread to stop and no statement
        // to end, so taking the start away ends it here: there is
        // nothing left for a later read to begin, and the queue is over
        // before anything was put in it.
        let never = self
            .live
            .start
            .lock()
            .is_ok_and(|mut start| start.take().is_some());
        if never {
            self.live.pipe.finish();
            return Ok(());
        }
        // Everything already handed over, read and dropped, until the
        // statement says it is over. Which it does: a stopped scan ends
        // at the next batch, and the end is the last thing sent.
        while let Some(chunk) = self.live.pipe.recv() {
            let Chunk::Done(ended) = chunk else {
                continue;
            };
            if let Ok(mut slot) = self.live.ended.lock()
                && slot.is_none()
            {
                // A stream stopped after it had already failed keeps
                // the failure, because that is what a read waiting
                // behind this one is owed.
                *slot = Some(ended);
            }
            break;
        }
        Ok(())
    }

    fn resolve(&mut self, _env: &'task Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }

    /// Nothing can happen to a cancelled stream afterwards, so the
    /// signal is let go of here whether the statement had started or
    /// not.
    fn finally(self, env: Env) -> Result<()> {
        release(&self.live, &env)
    }
}

/// A cursor nobody holds any more is a reader that has gone.
///
/// The garbage collector is what says so, which is late, but late is
/// not never and the alternative is a statement scanning a database
/// into a queue that will never be read. Everything else about ending a
/// stream is deliberate: this is the backstop under a program that
/// forgot.
impl Drop for ZuCursor {
    fn drop(&mut self) {
        self.live.stopped.store(true, Ordering::Release);
        self.live.pipe.close();
    }
}

impl Started {
    /// The statement, on the thread that owns it for its whole life.
    fn run(self, live: &Live) {
        let ended = self.stream(live);
        // The last thing put in the queue, and then the queue is over,
        // which is what a read past the end finds.
        live.pipe.send(Chunk::Done(ended), &self.alive);
        live.pipe.finish();
    }

    /// Takes the connection, runs the statement, and hands every batch
    /// over.
    fn stream(&self, live: &Live) -> std::result::Result<Streamed, Failure> {
        let mut held = self
            .inner
            .lock()
            .map_err(|_| Failure::Usage(POISONED.to_string()))?;
        let Some(conn) = held.as_mut() else {
            return Err(Failure::Usage(CLOSED.to_string()));
        };
        // From here the connection is this statement's, so this is
        // where a signal can start stopping it. A signal that fired
        // first ends the statement without the engine ever seeing it.
        if let Some(guard) = &self.guard
            && !guard.enter()
        {
            guard.leave();
            return Err(Failure::Aborted);
        }
        let names = Arc::new(Names::of(conn.session_mut().catalog()));
        let params: Vec<(&str, Value)> = self
            .params
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect();

        let mut head: Option<Arc<Head>> = None;
        let mut sink = |batch: Batch<'_>| {
            // The columns are the same for every batch of one
            // statement, and the first batch is where they are known.
            let head = Arc::clone(head.get_or_insert_with(|| {
                Arc::new(Head {
                    columns: batch.columns().to_vec(),
                    names: Arc::clone(&names),
                })
            }));
            Ok(self.hand(live, head, batch.rows().to_vec()))
        };
        let result = match self.batch_rows {
            Some(rows) => {
                conn.query_stream_batched(&self.statement, &params, rows as usize, &mut sink)
            }
            None => conn.query_stream(&self.statement, &params, &mut sink),
        };

        if let Some(guard) = &self.guard {
            guard.leave();
            // An interrupt is the engine's answer to somebody having
            // asked, and the only somebody here is the caller's signal.
            if guard.asked() && matches!(result, Err(ZuError::Interrupted)) {
                return Err(Failure::Aborted);
            }
        }
        Ok(result?)
    }

    /// Hands one batch over, waiting for room, and says whether the
    /// scan should carry on.
    ///
    /// Three things end a stream from this side: a reader that asked it
    /// to stop, a connection closed underneath it, and a reader that
    /// let go of the cursor entirely, which closes the queue.
    fn hand(&self, live: &Live, head: Arc<Head>, rows: Vec<Vec<Value>>) -> Flow {
        if live.stopped.load(Ordering::Acquire) {
            return Flow::Stop;
        }
        match live.pipe.send(Chunk::Rows { head, rows }, &self.alive) {
            true => Flow::More,
            false => Flow::Stop,
        }
    }
}
