//! A statement compiled once and run many times.
//!
//! ```js
//! await using find = await conn.prepare('MATCH (p:person) WHERE p.id = $id RETURN p.name AS name')
//! for (const id of ids) console.log(await find.query({ id }))
//! ```
//!
//! ## What this is for, since it is not what it is for in a driver
//!
//! A driver prepares to save a round trip: the text goes to the server
//! once and the values go every time. There is no server here and no
//! round trip to save, and the engine caches the plan for a statement by
//! its text, so the second `conn.query` of the same string is already
//! not compiling it a second time. A benchmark that expects preparing to
//! be faster than not preparing is going to be disappointed, and
//! `bench/prepared.mjs` prints the two side by side rather than
//! pretending otherwise.
//!
//! What it is for is the two things the plan cache cannot do. The
//! compile happens at the call that asked for it, so a statement with a
//! typo in it fails when the program starts rather than on the first
//! request that reached it, which is the difference between a deploy
//! that fails and a deploy that pages somebody. And the parameter names
//! come back, in the order the binder assigned them, so a program can
//! bind what the statement actually wants rather than what somebody
//! remembered writing.
//!
//! ## What is pinned
//!
//! The id maps back to the text of the statement rather than to a plan,
//! so a prepared statement that outlives a catalog change recompiles
//! instead of running a plan describing a table that has since changed
//! shape. That is the engine's decision and it is the right one: a
//! prepared statement in a long-lived process is exactly the thing most
//! likely to be holding a stale plan.
//!
//! A prepared statement belongs to the connection that made it and dies
//! with it. Closing one gives its id back to the session; leaving one
//! open leaks a string until the connection closes, which is why this
//! answers `Symbol.asyncDispose` and why `await using` is how the
//! examples spell it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use napi_derive::napi;
use zudb::Interrupt;

use crate::arrow::ArrowTask;
use crate::columns::ColumnsTask;
use crate::conn::{
    CLOSED, ExecTask, Failure, Handles, QueryTask, Source, batch, bind, failed, int_mode, watch,
    wire_disposal, with,
};
use crate::value::Spelling;

/// A statement the connection has compiled and pinned.
///
/// Take one with `Connection.prepare`, run it as often as you like, and
/// close it. It runs the same three ways a connection does, `query`,
/// `exec` and `columnar`, because a prepared statement is a statement
/// and the way a caller wants its answer is not a decision the prepare
/// should have made.
///
/// There is no `stream`. A stream is the engine's `run_streaming`, which
/// takes the text of a statement rather than a pinned id, so a streamed
/// prepared statement would be this client re-running the text behind
/// the caller's back and calling it prepared. `conn.stream(sql, params)`
/// is that, honestly spelled.
#[napi]
pub struct Prepared {
    /// The same handles every statement on this connection uses, rather
    /// than a reference to the JavaScript object, so a prepared
    /// statement whose `Connection` was collected still has somewhere to
    /// run.
    handles: Handles,
    /// The word this statement reads at every boundary, for a caller who
    /// passes a signal to one of the runs.
    interrupt: Interrupt,
    /// How this statement spells the values it gives back, taken from
    /// the connection when it was prepared. A single run may say
    /// otherwise about the integers, the same way a single query may.
    spelling: Spelling,
    statement: String,
    /// The names the binder assigned, in the order it assigned them.
    params: Vec<String>,
    /// The id the session pinned this under.
    id: u64,
    /// Whether it is still pinned, kept beside the connection's lock
    /// rather than inside it, so asking costs nothing and never queues
    /// behind the statement being asked about.
    open: Arc<AtomicBool>,
}

#[napi]
impl Prepared {
    /// The statement, as it was written.
    #[napi(getter)]
    pub fn statement(&self) -> String {
        self.statement.clone()
    }

    /// The names this statement wants, in the order the binder assigned
    /// them, and without the `$` they are written with.
    ///
    /// Empty for a statement that takes none. A name in here that the
    /// caller does not bind is a failure at the run rather than a null,
    /// which is the engine's rule and the one worth relying on.
    #[napi(getter)]
    pub fn params(&self) -> Vec<String> {
        self.params.clone()
    }

    /// Whether this prepared statement has been closed.
    #[napi(getter)]
    pub fn closed(&self) -> bool {
        !self.open.load(Ordering::Acquire)
    }

    /// Runs it and gives back its rows.
    #[napi(
        ts_generic_types = "Row = Record<string, ZuValue>",
        ts_args_type = "params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<ZuRows<Row>>"
    )]
    pub fn query(
        &self,
        env: &Env,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<QueryTask> {
        AsyncTask::new(self.task(env, params, options))
    }

    /// Runs it for its effect and gives back nothing.
    #[napi(
        ts_args_type = "params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<void>"
    )]
    pub fn exec(
        &self,
        env: &Env,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ExecTask> {
        AsyncTask::new(ExecTask(self.task(env, params, options)))
    }

    /// Runs it and gives back its columns rather than its rows.
    #[napi(
        ts_args_type = "params?: Record<string, ZuParam> | null, options?: ZuStatementOptions | null",
        ts_return_type = "Promise<ZuColumnar>"
    )]
    pub fn columnar(
        &self,
        env: &Env,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ColumnsTask> {
        AsyncTask::new(ColumnsTask(self.task(env, params, options)))
    }

    /// Runs it and gives back the bytes of an Arrow IPC stream.
    #[napi(
        ts_args_type = "params?: Record<string, ZuParam> | null, options?: ZuArrowOptions | null",
        ts_return_type = "Promise<ZuArrow>"
    )]
    pub fn arrow(
        &self,
        env: &Env,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> AsyncTask<ArrowTask> {
        let batch = batch(options.as_ref());
        AsyncTask::new(ArrowTask {
            task: self.task(env, params, options),
            batch,
        })
    }

    /// Gives the id back to the session.
    ///
    /// Closing twice does nothing the second time, and closing one whose
    /// connection has already gone does nothing at all, because the
    /// session that was holding it went with it. Both of those are what
    /// makes an explicit close safe to write inside a block that an
    /// `await using` is also going to leave.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn close(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask {
            handles: self.handles.clone(),
            id: self.id,
            open: Arc::clone(&self.open),
        })
    }

    /// The close `await using` calls, which is the intended way to scope
    /// a prepared statement.
    ///
    /// It is also reachable as `Symbol.asyncDispose`, which is what
    /// `await using` actually looks for and which [`wire_disposal`] puts
    /// on every prepared statement as it is made.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn dispose(&self) -> AsyncTask<CloseTask> {
        self.close()
    }

    /// The task one run of this statement is, whether or not it is going
    /// to work.
    ///
    /// The same [`QueryTask`] a `conn.query` builds, carrying an id
    /// instead of a string, which is what lets a prepared statement have
    /// all three shapes of answer without any of the three being written
    /// twice.
    fn task(
        &self,
        env: &Env,
        params: Option<Unknown<'_>>,
        options: Option<Object<'_>>,
    ) -> QueryTask {
        // The parameters are read here, on the thread that owns the
        // runtime, because reading a JavaScript value is something no
        // other thread may do. So is adding the listener the signal is
        // watched through.
        let bound = if !self.open.load(Ordering::Acquire) {
            Err(FINISHED.to_string())
        } else if !self.handles.alive.load(Ordering::Acquire) {
            Err(CLOSED.to_string())
        } else {
            int_mode(options.as_ref(), self.spelling.ints).and_then(|ints| {
                Ok((
                    bind(env, params)?,
                    Spelling {
                        ints,
                        ..self.spelling
                    },
                    watch(env, options, self.interrupt.clone())?,
                ))
            })
        };
        let (params, spelling, watch, refused) = match bound {
            Ok((params, spelling, watch)) => (params, spelling, watch, None),
            Err(message) => (Vec::new(), self.spelling, None, Some(message)),
        };
        QueryTask::new(
            self.handles.clone(),
            Source::Prepared(self.id),
            params,
            spelling,
            watch,
            refused,
        )
    }
}

/// Compiling one, which is the call that finds out whether the statement
/// is a statement at all.
pub struct PrepareTask {
    handles: Handles,
    interrupt: Interrupt,
    spelling: Spelling,
    statement: String,
    /// Why this is not going to run, when it is not.
    refused: Option<String>,
}

impl PrepareTask {
    pub(crate) fn new(
        handles: Handles,
        interrupt: Interrupt,
        spelling: Spelling,
        statement: String,
        refused: Option<String>,
    ) -> PrepareTask {
        PrepareTask {
            handles,
            interrupt,
            spelling,
            statement,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for PrepareTask {
    type Output = std::result::Result<(u64, Vec<String>), Failure>;
    type JsValue = ClassInstance<'task, Prepared>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let statement = self.statement.clone();
        let handles = &self.handles;
        Ok(with(
            &handles.inner,
            &handles.alive,
            &handles.in_txn,
            |conn| Ok(conn.prepare(&statement)?),
        ))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let (id, params) = output.map_err(|failure| failed(env, failure, None))?;
        let mut instance = Prepared {
            handles: self.handles.clone(),
            interrupt: self.interrupt.clone(),
            spelling: self.spelling,
            statement: self.statement.clone(),
            params,
            id,
            open: Arc::new(AtomicBool::new(true)),
        }
        .into_instance(env)?;
        wire_disposal(env, &mut instance, "dispose")?;
        Ok(instance)
    }
}

/// Giving one back, off the event loop because it takes the connection's
/// lock and a statement may be holding it.
pub struct CloseTask {
    handles: Handles,
    id: u64,
    open: Arc<AtomicBool>,
}

impl<'task> ScopedTask<'task> for CloseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        if !self.open.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let handles = &self.handles;
        // A connection that has already closed took the session and the
        // statement with it, so there is nothing to give back and
        // nothing to complain about. Every other reason the connection
        // cannot be had, a poisoned lock or a stream still reading, is
        // the same: the id outlives none of them.
        let _ = with(&handles.inner, &handles.alive, &handles.in_txn, |conn| {
            conn.close_prepared(self.id);
            Ok(())
        });
        Ok(())
    }

    fn resolve(&mut self, _env: &'task Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

/// What a prepared statement that has already been closed says.
const FINISHED: &str = "this prepared statement is closed, and a closed one has given its \
     statement back to the connection";
