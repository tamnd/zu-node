//! A result read down its columns instead of across its rows.
//!
//! ```js
//! const read = await conn.columnar('MATCH (p:person) RETURN p.age AS age')
//! read.columns[0].values // a BigInt64Array of every age, and no objects
//! ```
//!
//! `query` builds an object per row and a JavaScript value per cell,
//! which is what a program reading a hundred rows wants and is the
//! wrong shape for a million: every value costs an allocation and a
//! write barrier, and everything a caller is likely to do next with a
//! million of them wants columns anyway. Arrow is columns, so is every
//! dataframe, so is every plotting library worth the name, and so is
//! the typed array a numeric loop reads.
//!
//! What comes back is the buffers themselves, in the layout Arrow
//! already uses: values end to end, one bit a row of validity where
//! anything is null, strings as bytes and offsets. `zu::query::column`
//! builds them in the engine, in two passes over the rows, and this
//! module hands each one to the runtime as an external typed array. The
//! `Vec` is moved rather than read: the pointer V8 is given is the
//! pointer the engine filled, and the allocation is freed when the
//! typed array is collected. So a column of a million integers crosses
//! the boundary as a pointer and a length.
//!
//! The layout is Arrow's because that is the layout with readers.
//! `apache-arrow` wraps a buffer of this shape without copying it, and
//! the README says how in the ten lines it takes. This package still
//! does not depend on that one, which is the whole reason the answer is
//! buffers rather than a `Table`: a client that hands out an Arrow
//! object has to agree with one version of Arrow forever, and a client
//! that hands out the bytes agrees with all of them.
//!
//! Two things are not buffers. A column of nodes, rels, paths, lists or
//! records has no fixed width cell, so it arrives as `items`, the same
//! JavaScript values `query` would have made, and a column of nothing
//! but nulls has a length and nothing else, because there is nothing to
//! put in a buffer. Both are named by the column's `type` rather than
//! found out by looking.
//!
//! `bigIntMode` says nothing here. A columnar read has one physical
//! layout per type and an INT64 column is 64 bit cells whatever a
//! caller would rather read one cell as, which is the difference
//! between a buffer and a value: the mode applies to the values inside
//! `items`, where this client is making objects anyway.

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use zudb::DiagnosticRecord;
use zudb::query::Value;
use zudb::query::column::{ColumnData, ColumnType, Columns, Offsets, Validity};

use crate::conn::{Failure, QueryTask, notices};
use crate::value::{Shape, to_js};

/// One statement, read as columns.
pub struct ColumnsTask(pub(crate) QueryTask);

/// What one column turned out to hold, owned here rather than borrowed
/// from the result, so that the result is free to go before any of this
/// reaches the runtime.
enum Held {
    /// A column of nulls, which has a length and no buffer.
    Empty,
    /// One bit a row, least significant bit first.
    Bits(Vec<u8>),
    Int(Vec<i64>),
    Float(Vec<f64>),
    Days(Vec<i32>),
    Nanos(Vec<i64>),
    Months(Vec<i64>),
    Str {
        bytes: Vec<u8>,
        offsets: Offsets,
    },
    /// The values themselves, for what no buffer covers.
    Items(Vec<Value>),
}

/// One column: what it is called, what it holds, and the rows that have
/// a value.
struct Out {
    name: String,
    /// What a reader calls this type, which is a smaller vocabulary
    /// than the engine's because the physical layout is the question.
    kind: &'static str,
    /// What a fixed width cell counts, where counting is what it does.
    unit: Option<&'static str>,
    /// Minutes east of UTC, for a column of zoned times or datetimes.
    zone: Option<i32>,
    held: Held,
    validity: Option<Validity>,
    len: usize,
}

/// A whole result, read down its columns.
pub struct Read {
    rows: usize,
    columns: Vec<Out>,
    gqlstatus: &'static str,
    notices: Vec<DiagnosticRecord>,
}

impl ColumnsTask {
    fn run(&mut self) -> std::result::Result<(Read, Shape), Failure> {
        let (result, shape) = self.0.run()?;
        // The borrow of the result ends with this block, and everything
        // that leaves it is owned, so the rows are freed here rather
        // than held across the hop back to the runtime thread.
        let read = {
            let columns = result
                .columnar()
                .map_err(|mixed| Failure::Usage(mixed.to_string()))?;
            taken(columns, result.status().code(), result.notices.clone())
        };
        Ok((read, shape))
    }
}

/// The engine's columns, with every buffer moved out of them and every
/// borrowed value cloned.
fn taken(columns: Columns<'_>, gqlstatus: &'static str, notices: Vec<DiagnosticRecord>) -> Read {
    let Columns { columns, rows } = columns;
    let columns = columns
        .into_iter()
        .map(|column| Out {
            name: column.name.to_string(),
            kind: kind(&column.ty),
            unit: unit(&column.ty),
            zone: match column.ty {
                ColumnType::ZonedTime { offset } | ColumnType::ZonedDatetime { offset } => {
                    Some(offset as i32)
                }
                _ => None,
            },
            held: match column.data {
                ColumnData::Null => Held::Empty,
                ColumnData::Bool { bits } => Held::Bits(bits),
                ColumnData::Int(values) => Held::Int(values),
                ColumnData::Float(values) => Held::Float(values),
                ColumnData::Days(values) => Held::Days(values),
                ColumnData::Nanos(values) => Held::Nanos(values),
                ColumnData::Months(values) => Held::Months(values),
                ColumnData::Str(column) => Held::Str {
                    bytes: column.bytes,
                    offsets: column.offsets,
                },
                // The one arm that copies, and the one arm whose values
                // are objects at the other end anyway.
                ColumnData::Complex(values) => {
                    Held::Items(values.into_iter().cloned().collect::<Vec<Value>>())
                }
            },
            validity: column.validity,
            len: column.len,
        })
        .collect();
    Read {
        rows,
        columns,
        gqlstatus,
        notices,
    }
}

/// What a reader calls this column's type.
///
/// Narrower than [`ColumnType`] on purpose: what a caller has to branch
/// on is which buffer they were handed, and a time with an offset and a
/// time without are the same 64 bit cells. The offset rides beside as
/// `zone`, where it can be read by the caller who cares and ignored by
/// the loop that does not.
fn kind(ty: &ColumnType) -> &'static str {
    match ty {
        ColumnType::Null => "null",
        ColumnType::Bool => "bool",
        ColumnType::Int => "int",
        ColumnType::Float => "float",
        ColumnType::Str => "string",
        ColumnType::Date => "date",
        ColumnType::LocalTime | ColumnType::ZonedTime { .. } => "time",
        ColumnType::LocalDatetime | ColumnType::ZonedDatetime { .. } => "datetime",
        ColumnType::YearMonth | ColumnType::DayTime => "duration",
        _ => "value",
    }
}

/// What one cell of this column counts.
///
/// A duration is months or nanoseconds and never both, which is the
/// engine's rule and the one thing a reader of the buffer cannot work
/// out from the numbers in it.
fn unit(ty: &ColumnType) -> Option<&'static str> {
    match ty {
        ColumnType::Date => Some("days"),
        ColumnType::LocalTime
        | ColumnType::ZonedTime { .. }
        | ColumnType::LocalDatetime
        | ColumnType::ZonedDatetime { .. }
        | ColumnType::DayTime => Some("nanos"),
        ColumnType::YearMonth => Some("months"),
        _ => None,
    }
}

impl<'task> ScopedTask<'task> for ColumnsTask {
    type Output = std::result::Result<(Read, Shape), Failure>;
    type JsValue = Object<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.run())
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let (read, shape) = output.map_err(|failure| self.0.failed(env, failure))?;
        let mut array = env.create_array(read.columns.len() as u32)?;
        for (ix, column) in read.columns.into_iter().enumerate() {
            array.set(ix as u32, described(env, column, &shape)?)?;
        }
        let mut object = Object::new(env)?;
        object.set("rows", read.rows as f64)?;
        object.set("columns", array)?;
        object.set("gqlstatus", read.gqlstatus)?;
        object.set("notices", notices(env, &read.notices)?)?;
        Ok(object)
    }

    fn finally(mut self, env: Env) -> Result<()> {
        self.0.release(&env)
    }
}

/// One column as the object a caller reads.
///
/// Every field is present on every column, holding null where it does
/// not apply, because a shape that changes by type is a shape a program
/// has to test before it can read, and the whole point of `type` is
/// that the test is one string comparison.
fn described<'env>(env: &'env Env, column: Out, shape: &Shape) -> Result<Object<'env>> {
    let Out {
        name,
        kind,
        unit,
        zone,
        held,
        validity,
        len,
    } = column;
    let mut object = Object::new(env)?;
    object.set("name", name.as_str())?;
    object.set("type", kind)?;
    object.set("length", len as f64)?;
    object.set("unit", unit)?;
    object.set("zone", zone)?;

    // The three that hold the values, one of which is not null.
    let (mut values, mut data, mut offsets, mut items) = (None, None, None, None);
    match held {
        Held::Empty => {}
        Held::Bits(bits) => values = Some(Uint8Array::new(bits).into_unknown(env)?),
        Held::Int(v) | Held::Nanos(v) | Held::Months(v) => {
            values = Some(BigInt64Array::new(v).into_unknown(env)?)
        }
        Held::Float(v) => values = Some(Float64Array::new(v).into_unknown(env)?),
        Held::Days(v) => values = Some(Int32Array::new(v).into_unknown(env)?),
        Held::Str { bytes, offsets: at } => {
            data = Some(Uint8Array::new(bytes));
            offsets = Some(match at {
                // Narrow until the bytes pass what a 32 bit offset
                // addresses, which is what Arrow calls Utf8 against
                // LargeUtf8 and what a reader has to know before it
                // reads one.
                Offsets::I32(o) => Int32Array::new(o).into_unknown(env)?,
                Offsets::I64(o) => BigInt64Array::new(o).into_unknown(env)?,
            });
        }
        Held::Items(held) => {
            let mut array = env.create_array(held.len() as u32)?;
            for (ix, value) in held.iter().enumerate() {
                array.set(ix as u32, to_js(env, name.as_str(), value, shape)?)?;
            }
            items = Some(array);
        }
    }
    object.set("values", values)?;
    object.set("data", data)?;
    object.set("offsets", offsets)?;
    object.set("items", items)?;

    // Absent when every row has a value, which is the common case and
    // the one where a reader gets to skip the test entirely. Present
    // means at least one null, so a caller never has to count to find
    // out whether the bits are worth attaching.
    match validity {
        Some(Validity { bits, nulls, .. }) if nulls > 0 => {
            object.set("validity", Uint8Array::new(bits))?;
            object.set("nulls", nulls as f64)?;
        }
        _ => {
            object.set("validity", Null)?;
            object.set("nulls", 0.0)?;
        }
    }
    Ok(object)
}
