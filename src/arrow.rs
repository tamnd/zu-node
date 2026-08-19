//! A result as Arrow, in the bytes Arrow ships between processes.
//!
//! ```js
//! import { tableFromIPC } from 'apache-arrow'
//! const read = await conn.arrow('MATCH (p:person) RETURN p.name AS name, p.age AS age')
//! const table = tableFromIPC(read.ipc)
//! ```
//!
//! [`columnar`] hands over the buffers themselves and leaves the reader
//! to put a type around them, which is the fastest way out and the one
//! that costs a caller ten lines of Arrow before they have a table. This
//! is the other way: the same buffers, with the schema written beside
//! them, in the format every Arrow implementation already reads. What
//! comes back is bytes, so `apache-arrow` reads it, DuckDB-Wasm reads
//! it, a `fetch` response body carries it, and a worker gets it as a
//! transferable rather than as a structured clone.
//!
//! The translation is not written here. `zu-arrow` in the engine tree is
//! the one answer about what a zu column becomes in Arrow, shared with
//! the Python client, because a second copy of it would be a second set
//! of rules about what a year-month duration is. This module is the
//! runtime's half: read the option, run the statement, hand the bytes to
//! V8 without copying them again.
//!
//! Why bytes and not the C Data Interface, which is what the Python
//! client takes and is a pointer rather than a serialization: nothing in
//! a JavaScript runtime can dereference a pointer. An addon can, and
//! this one does on the way in, but the value that reaches JavaScript
//! has to be something V8 holds, and the only thing V8 holds that Arrow
//! also speaks is a buffer of IPC bytes. The framing is the cost: a
//! schema message, then a header a batch, which is kilobytes against a
//! result of any size and the price of a format with readers.
//!
//! [`columnar`]: crate::columns
use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use zudb::DiagnosticRecord;

use crate::conn::{Failure, QueryTask, notices};

/// One statement, read as Arrow.
pub struct ArrowTask {
    pub(crate) task: QueryTask,
    /// How many rows go in a record batch, or why the caller's answer to
    /// that could not be read.
    pub(crate) batch: std::result::Result<usize, String>,
}

/// A whole result, as the bytes and what came with them.
pub struct Read {
    ipc: Vec<u8>,
    rows: usize,
    gqlstatus: &'static str,
    notices: Vec<DiagnosticRecord>,
}

impl ArrowTask {
    fn run(&mut self) -> std::result::Result<Read, Failure> {
        // Before the statement, because a batch size nobody could read
        // is a call that was wrong when it was written and not an answer
        // worth running a scan for.
        let batch = self
            .batch
            .as_ref()
            .map_err(|message| Failure::Usage(message.clone()))?;
        let batch = *batch;
        let (result, shape) = self.task.run()?;
        // The names are the ones the statement's own catalog gave, so a
        // node column names its table rather than its id.
        let ipc = zu_arrow::ipc(&result, shape.names(), batch)
            .map_err(|err| Failure::Usage(err.to_string()))?;
        Ok(Read {
            ipc,
            // Answered off the columns the sink filled, which is a read
            // of a length and not a pass that builds rows nobody wants.
            rows: result.rows.len(),
            gqlstatus: result.status().code(),
            notices: result.notices,
        })
    }
}

impl<'task> ScopedTask<'task> for ArrowTask {
    type Output = std::result::Result<Read, Failure>;
    type JsValue = Object<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let read = output.map_err(|failure| self.task.failed(env, failure))?;
        let mut object = Object::new(env)?;
        // The `Vec` is moved and not read: the pointer V8 is handed is
        // the pointer the writer filled, and the allocation is freed when
        // the typed array is collected.
        object.set("ipc", Uint8Array::new(read.ipc))?;
        object.set("rows", read.rows as f64)?;
        object.set("gqlstatus", read.gqlstatus)?;
        object.set("notices", notices(env, &read.notices)?)?;
        Ok(object)
    }

    fn finally(mut self, env: Env) -> Result<()> {
        self.task.release(&env)
    }
}
