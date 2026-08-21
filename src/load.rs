//! Building a database out of columns and an edge list.
//!
//! ```js
//! await load('social.zu1', { nodes: 'person', rels: 'knows', columns, edges })
//! ```
//!
//! A row at a time through `INSERT` is the wrong shape for loading data
//! and the wrong shape for making a graph: every row is parsed, bound and
//! committed, and a rel table cannot be made that way at all, because the
//! statement that would make one says which two tables it joins only for
//! the edge it is writing. This is the other shape, and it is the one the
//! C ABI's loader has: a table's columns whole, an edge list whole, one
//! file written once.
//!
//! What it writes is a node table with a row per element of every column,
//! a rel table holding the edges between those rows, and a primary-key
//! index over the rows so a lookup by key does not scan. Edges name rows
//! by position, counting from zero, because at load time a row has no
//! other name.
//!
//! It is a function rather than a method because there is no connection
//! yet: the file it writes is the file a program connects to afterwards.
//! The path must not exist, since a load builds a database rather than
//! adding to one, and a path that already holds one is a caller who meant
//! a different path.
//!
//! Everything the caller passed is read on the thread that owns the
//! runtime, because that is the only thread allowed to read a JavaScript
//! value, and everything after that runs on the threadpool: the edges are
//! sorted, the graph is built, and every column is encoded and written to
//! disk. So the event loop is free for the whole of the expensive part,
//! which on a load is all of it.

use std::path::PathBuf;

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask, ValueType};
use napi_derive::napi;
use zudb::zu1::file::Zu1File;
use zudb::zu1::graph::bulk_load_keyed;
use zudb::zu1::props::{PropValues, store_props};

use crate::buffer::{Column, Mismatch, named};
use crate::conn::{Failure, failed, text};
use crate::register::identifier;

/// Writes a new database at `path` and answers what went into it.
#[napi(
    ts_args_type = "path: string, options: ZuLoadOptions",
    ts_return_type = "Promise<ZuLoadStats>"
)]
pub fn load(env: &Env, path: Unknown<'_>, options: Unknown<'_>) -> AsyncTask<LoadTask> {
    match plan(env, path, options) {
        Ok(plan) => AsyncTask::new(LoadTask {
            plan: Some(plan),
            refused: None,
        }),
        Err(message) => AsyncTask::new(LoadTask {
            plan: None,
            refused: Some(message),
        }),
    }
}

/// Everything the load needs, read off the caller's objects and owned
/// here, so that the write below owes the runtime nothing.
pub struct Plan {
    path: PathBuf,
    nodes: String,
    rels: String,
    rows: u64,
    columns: Vec<(String, Column)>,
    pairs: Vec<(u32, u32)>,
}

/// What went in, which is what the caller gets back.
pub struct Stats {
    nodes: u64,
    rels: u64,
    columns: u64,
}

pub struct LoadTask {
    plan: Option<Plan>,
    /// What this client refused the call with, before any of it ran.
    refused: Option<String>,
}

/// What a task says when it is run a second time, which nothing this
/// client writes does: a task is built by one call and driven once.
const TWICE: &str = "this load has already run, and a database is written once";

impl LoadTask {
    fn run(&mut self) -> std::result::Result<Stats, Failure> {
        if let Some(message) = self.refused.take() {
            return Err(Failure::Usage(message));
        }
        let Plan {
            path,
            nodes,
            rels,
            rows,
            columns,
            mut pairs,
        } = self.plan.take().ok_or(Failure::Usage(TWICE.to_string()))?;
        let mut db = Zu1File::create(&path)?;
        // Sorted and deduplicated because the builder wants them that
        // way, and because an edge list a program produced by walking
        // something else is neither.
        pairs.sort_unstable();
        pairs.dedup();
        bulk_load_keyed(&mut db, &nodes, &rels, rows, &pairs, None)?;
        let written = columns.len() as u64;
        if !columns.is_empty() {
            // The store wants a slice of slices for a column of strings,
            // which a vector of strings is not, so the row borrows are
            // built first and handed over after.
            let runs: Vec<Vec<&[u8]>> = columns
                .iter()
                .map(|(_, column)| match column {
                    Column::Str(v) => v.iter().map(String::as_bytes).collect(),
                    Column::Bytes(v) => v.iter().map(Vec::as_slice).collect(),
                    _ => Vec::new(),
                })
                .collect();
            let props: Vec<(&str, PropValues<'_>)> = columns
                .iter()
                .zip(&runs)
                .map(|((name, column), runs)| {
                    let values = match column {
                        Column::Str(_) => PropValues::Str(runs),
                        Column::Bytes(_) => PropValues::Bytes(runs),
                        Column::Int(v) => PropValues::Int(words(v)),
                        Column::Float(v) => PropValues::Float(v),
                        Column::Bool(v) => PropValues::Bool(v),
                        Column::Date(v) => PropValues::Date(v),
                        Column::LocalTime(v) => PropValues::LocalTime(v),
                        Column::LocalDatetime(v) => PropValues::LocalDatetime(v),
                        Column::Duration(kind, v) => PropValues::Duration(*kind, v),
                    };
                    (name.as_str(), values)
                })
                .collect();
            store_props(&mut db, &nodes, &props)?;
        }
        Ok(Stats {
            nodes: rows,
            rels: pairs.len() as u64,
            columns: written,
        })
    }
}

/// A column of whole numbers as the words the store keeps them in.
///
/// The store's integer column is a run of 64 bit words and this client
/// buffers signed ones, which is the same run of bytes read with a
/// different sign: the two types have the same size and alignment and
/// every bit pattern is a value of both.
fn words(values: &[i64]) -> &[u64] {
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u64>(), values.len()) }
}

impl<'task> ScopedTask<'task> for LoadTask {
    type Output = std::result::Result<Stats, Failure>;
    type JsValue = Object<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let stats = output.map_err(|failure| failed(env, failure, None))?;
        // Numbers rather than bigints, because these are counts this
        // client made rather than INT64 columns a statement gave back,
        // and no load fits 2^53 rows in memory to be counted wrongly.
        let mut object = Object::new(env)?;
        object.set_named_property("nodes", stats.nodes as f64)?;
        object.set_named_property("rels", stats.rels as f64)?;
        object.set_named_property("columns", stats.columns as f64)?;
        Ok(object)
    }
}

/// The whole call, read into a [`Plan`], or the one sentence it was
/// refused with.
fn plan(env: &Env, path: Unknown<'_>, options: Unknown<'_>) -> std::result::Result<Plan, String> {
    read(env, path, options).map_err(|err| err.reason)
}

fn read(env: &Env, path: Unknown<'_>, options: Unknown<'_>) -> Result<Plan> {
    let path = text(&path, "path").map_err(|message| crate::error::usage(env, message))?;
    if options.get_type()? != ValueType::Object {
        return Err(crate::error::usage(
            env,
            format!(
                "the options are {}, and a load is told at least which node table it is writing",
                named(&options)
            ),
        ));
    }
    let options = Object::from_unknown(options)?;
    let refuse = |message: String| crate::error::usage(env, message);

    let nodes: Option<Unknown<'_>> = options.get("nodes")?;
    let Some(nodes) = nodes else {
        return Err(refuse(
            "a load names the node table it is writing, and this one names none".to_string(),
        ));
    };
    let nodes = text(&nodes, "node table").map_err(refuse)?;
    // A default rather than a required name, because a graph with no
    // edges still gets a rel table and a caller who wrote none has no
    // opinion about what it is called.
    let rels: Option<Unknown<'_>> = options.get("rels")?;
    let rels = match rels {
        Some(rels) => text(&rels, "rel table").map_err(refuse)?,
        None => "rel".to_string(),
    };
    for (name, what) in [(&nodes, "a node table"), (&rels, "a rel table")] {
        identifier(name, what).map_err(refuse)?;
    }

    let columns = built(env, &options)?;
    let asked = counted(env, &options)?;
    let rows = match (asked, columns.first()) {
        (Some(rows), _) if rows < 0.0 || rows.fract() != 0.0 => {
            return Err(refuse(format!(
                "a load of {rows} rows is a load of a number of rows that is not a whole one"
            )));
        }
        (Some(rows), Some((name, column))) if column.len() as f64 != rows => {
            return Err(refuse(format!(
                "column '{name}' holds {} values against the {rows} rows this load asks for",
                column.len()
            )));
        }
        (Some(rows), _) => rows as u64,
        (None, Some((_, column))) => column.len() as u64,
        (None, None) => {
            return Err(refuse(
                "a load with no columns has no rows to count, so it has to be told how many"
                    .to_string(),
            ));
        }
    };
    let pairs = pairs(env, &options, rows)?;

    Ok(Plan {
        path: PathBuf::from(path),
        nodes,
        rels,
        rows,
        columns,
        pairs,
    })
}

/// How many rows the caller said the table has, written either way a
/// count is written.
fn counted(env: &Env, options: &Object<'_>) -> Result<Option<f64>> {
    let Some(rows) = options.get::<Unknown<'_>>("rows")? else {
        return Ok(None);
    };
    Ok(match rows.get_type()? {
        ValueType::Null | ValueType::Undefined => None,
        ValueType::Number => Some(f64::from_unknown(rows)?),
        ValueType::BigInt => Some(BigInt::from_unknown(rows)?.get_i64().0 as f64),
        _ => {
            return Err(crate::error::usage(
                env,
                format!(
                    "the row count is {}, and a row count is a number",
                    named(&rows)
                ),
            ));
        }
    })
}

/// Every column, in the order the object holds them, which is the order
/// they were written.
fn built(env: &Env, options: &Object<'_>) -> Result<Vec<(String, Column)>> {
    let Some(columns) = options.get::<Object<'_>>("columns")? else {
        return Ok(Vec::new());
    };
    let names = Object::keys(&columns)?;
    let mut built: Vec<(String, Column)> = Vec::with_capacity(names.len());
    for name in names {
        identifier(&name, "a column").map_err(|message| crate::error::usage(env, message))?;
        let column = column(
            env,
            &name,
            columns.get_named_property::<Unknown<'_>>(&name)?,
        )?;
        // The store takes a column of bytes and every statement that
        // reads one back refuses it, so a load that wrote one would be
        // writing data the caller cannot get at again. Refused here until
        // the read side catches up, at which point this goes and nothing
        // else has to change.
        if matches!(column, Column::Bytes(_)) {
            return Err(crate::error::usage(
                env,
                format!(
                    "column '{name}' holds byte strings, and no statement can read one back yet, \
                     so a load will not write a column of them"
                ),
            ));
        }
        if let Some((first, had)) = built.first().map(|(name, column)| (name, column.len()))
            && column.len() != had
        {
            return Err(crate::error::usage(
                env,
                format!(
                    "column '{name}' holds {} values and column '{first}' holds {had}, and a table \
                     is as wide as it is long",
                    column.len()
                ),
            ));
        }
        built.push((name, column));
    }
    Ok(built)
}

/// One column, read out of whatever the caller wrote it as.
///
/// A typed array is read as the numbers it already holds, which is one
/// pass over memory and no runtime call per value. An ordinary array is
/// read a value at a time, where the first value settles what the column
/// is and every value after it has to agree, which is [`Column`]'s rule
/// and is the appender's rule too.
fn column(env: &Env, name: &str, values: Unknown<'_>) -> Result<Column> {
    let refuse = |message: String| crate::error::usage(env, message);
    if values.get_type()? == ValueType::Object && values.is_typedarray()? {
        return filled(env, name, values);
    }
    if !values.is_array()? {
        return Err(refuse(format!(
            "column '{name}' is {}, and a column is an array or a typed array of its values",
            named(&values)
        )));
    }
    let values = Object::from_unknown(values)?;
    let rows = values.get_array_length()?;
    let mut column: Option<Column> = None;
    for row in 0..rows {
        let value: Unknown<'_> = values.get_element(row)?;
        match column.as_mut() {
            Some(column) => column.widening_push(env, value).map_err(|why| match why {
                Mismatch::Wanted(holds) => refuse(format!(
                    "column '{name}' holds {holds} and row {row} is {}",
                    named(&value)
                )),
                Mismatch::Says(reason) => refuse(format!(
                    "row {row} does not go in column '{name}': {reason}"
                )),
                Mismatch::Boundary(err) => err,
            })?,
            None => {
                column = Some(
                    Column::start(env, value)
                        .map_err(|why| match why {
                            Mismatch::Boundary(err) => err,
                            Mismatch::Wanted(holds) => refuse(format!(
                                "column '{name}' holds {holds} and row {row} is {}",
                                named(&value)
                            )),
                            Mismatch::Says(reason) => refuse(format!(
                                "row {row} does not go in column '{name}': {reason}"
                            )),
                        })?
                        .ok_or_else(|| {
                            refuse(format!(
                                "column '{name}' starts at row {row} with {}, and a loaded column \
                                 holds booleans, integers, floats, strings, dates, times, \
                                 datetimes or durations",
                                named(&value)
                            ))
                        })?,
                );
            }
        }
    }
    column.ok_or_else(|| {
        refuse(format!(
            "column '{name}' is empty, and an empty column says nothing about what it would hold"
        ))
    })
}

/// A column read straight out of a typed array.
///
/// Every width goes in as the INT64 or the FLOAT64 the store keeps, so
/// what a caller saves by handing over an `Int32Array` is the runtime
/// call per value rather than the width on disk. A load writes the file a
/// statement will read, and a statement reads whole numbers and floats.
fn filled(env: &Env, name: &str, values: Unknown<'_>) -> Result<Column> {
    let kind = TypedArray::from_unknown(values)?.typed_array_type;
    let widen = |v: &[i64]| Column::Int(v.to_vec());
    Ok(match kind {
        TypedArrayType::Int8 => Column::Int(cast(Int8Array::from_unknown(values)?.as_ref())),
        TypedArrayType::Uint8 | TypedArrayType::Uint8Clamped => {
            Column::Int(cast(Uint8Array::from_unknown(values)?.as_ref()))
        }
        TypedArrayType::Int16 => Column::Int(cast(Int16Array::from_unknown(values)?.as_ref())),
        TypedArrayType::Uint16 => Column::Int(cast(Uint16Array::from_unknown(values)?.as_ref())),
        TypedArrayType::Int32 => Column::Int(cast(Int32Array::from_unknown(values)?.as_ref())),
        TypedArrayType::Uint32 => Column::Int(cast(Uint32Array::from_unknown(values)?.as_ref())),
        TypedArrayType::BigInt64 => widen(BigInt64Array::from_unknown(values)?.as_ref()),
        TypedArrayType::BigUint64 => {
            let array = BigUint64Array::from_unknown(values)?;
            let mut out = Vec::with_capacity(array.as_ref().len());
            for (row, &n) in array.as_ref().iter().enumerate() {
                // Refused by the row that holds it, because a column of
                // unsigned words is one a caller may well have built
                // without ever going near 2^63 and the one value that
                // did is the thing worth naming.
                if n > i64::MAX as u64 {
                    return Err(crate::error::usage(
                        env,
                        format!(
                            "column '{name}' holds {n} at row {row}, which is past what INT64 \
                             holds, and every whole number this engine stores is an INT64"
                        ),
                    ));
                }
                out.push(n as i64);
            }
            Column::Int(out)
        }
        TypedArrayType::Float32 => Column::Float(
            Float32Array::from_unknown(values)?
                .as_ref()
                .iter()
                .map(|&n| f64::from(n))
                .collect(),
        ),
        TypedArrayType::Float64 => Column::Float(Float64Array::from_unknown(values)?.to_vec()),
        _ => {
            return Err(crate::error::usage(
                env,
                format!(
                    "column '{name}' is a typed array of a kind this client does not read, and a \
                     column of numbers is one of the ten integer and float widths"
                ),
            ));
        }
    })
}

/// Every element of a narrower integer array, as the INT64 it becomes.
fn cast<T: Copy + Into<i64>>(values: &[T]) -> Vec<i64> {
    values.iter().map(|&n| n.into()).collect()
}

/// The edge list, as the pairs of row numbers it is.
///
/// An edge naming a row the table has not got is refused here rather than
/// written, because a graph builder handed one would either invent the
/// row or lose the edge and neither is what the caller meant.
fn pairs(env: &Env, options: &Object<'_>, rows: u64) -> Result<Vec<(u32, u32)>> {
    let Some(edges) = options.get::<Unknown<'_>>("edges")? else {
        return Ok(Vec::new());
    };
    if edges.get_type()? == ValueType::Null {
        return Ok(Vec::new());
    }
    let refuse = |message: String| crate::error::usage(env, message);
    let within = |at: usize, end: i64| -> Result<u32> {
        match end < 0 || end as u64 >= rows {
            true => Err(refuse(format!(
                "edge {at} joins row {end} of a table with {rows} rows in it"
            ))),
            false => Ok(end as u32),
        }
    };

    // A flat array of row numbers, which is the shape a program that
    // built its edges in memory already has and the one that costs
    // nothing to read: two elements an edge, no object per edge, and one
    // pass over a buffer the runtime never has to be asked about again.
    if edges.get_type()? == ValueType::Object && edges.is_typedarray()? {
        let flat = flat(edges)?.ok_or_else(|| {
            refuse(
                "the edge list is a typed array of a kind this client does not read, and a flat \
                 edge list is an Int32Array or a Uint32Array of row numbers"
                    .to_string(),
            )
        })?;
        if !flat.len().is_multiple_of(2) {
            return Err(refuse(format!(
                "the edge list is a flat array of {} row numbers, and an edge is a pair of them",
                flat.len()
            )));
        }
        // A pair is a pair in the type, so the two indexes below are not
        // indexes any more and the odd tail `as_chunks` would hand back
        // is already refused above.
        let mut pairs = Vec::with_capacity(flat.len() / 2);
        for (at, &[from, to]) in flat.as_chunks::<2>().0.iter().enumerate() {
            pairs.push((within(at, from)?, within(at, to)?));
        }
        return Ok(pairs);
    }

    if !edges.is_array()? {
        return Err(refuse(format!(
            "the edge list is {}, and an edge list is an array of pairs of row numbers or a flat \
             typed array of them",
            named(&edges)
        )));
    }
    let edges = Object::from_unknown(edges)?;
    let count = edges.get_array_length()?;
    let mut pairs = Vec::with_capacity(count as usize);
    for at in 0..count {
        let edge: Unknown<'_> = edges.get_element(at)?;
        let at = at as usize;
        let pair = match edge.is_array()? {
            true => Object::from_unknown(edge)?,
            false => {
                return Err(refuse(format!(
                    "edge {at} is {}, and an edge is a pair of row numbers",
                    named(&edge)
                )));
            }
        };
        if pair.get_array_length()? != 2 {
            return Err(refuse(format!(
                "edge {at} holds {} row numbers, and an edge is a pair of them",
                pair.get_array_length()?
            )));
        }
        let mut ends = [0u32; 2];
        for (end, slot) in ends.iter_mut().enumerate() {
            let value: Unknown<'_> = pair.get_element(end as u32)?;
            let n = match value.get_type()? {
                ValueType::Number => f64::from_unknown(value)?,
                ValueType::BigInt => {
                    let (n, lossless) = BigInt::from_unknown(value)?.get_i64();
                    match lossless {
                        true => n as f64,
                        false => {
                            return Err(refuse(format!(
                                "edge {at} joins a row past what INT64 holds"
                            )));
                        }
                    }
                }
                _ => {
                    return Err(refuse(format!(
                        "edge {at} joins {}, and a row is named by its number",
                        named(&value)
                    )));
                }
            };
            if n.fract() != 0.0 {
                return Err(refuse(format!(
                    "edge {at} joins row {n}, and a row number is a whole one"
                )));
            }
            *slot = within(at, n as i64)?;
        }
        pairs.push((ends[0], ends[1]));
    }
    Ok(pairs)
}

/// A flat edge list as the row numbers it holds, or `None` for a typed
/// array that is not a run of them.
///
/// The two widths a row number is written in and no others: a row is
/// numbered from zero and a table has fewer than 2^32 rows, so a
/// `Float64Array` of edges is a caller who meant something else.
fn flat(edges: Unknown<'_>) -> Result<Option<Vec<i64>>> {
    Ok(match TypedArray::from_unknown(edges)?.typed_array_type {
        TypedArrayType::Int32 => Some(cast(Int32Array::from_unknown(edges)?.as_ref())),
        TypedArrayType::Uint32 => Some(cast(Uint32Array::from_unknown(edges)?.as_ref())),
        _ => None,
    })
}
