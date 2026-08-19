//! JavaScript values, buffered as the columns the engine stores.
//!
//! A row appended is not a row written. It goes into a vector per
//! column, in the shape the property store keeps that column in, and a
//! flush hands the whole batch over as one commit. So the work per
//! value is a conversion and a push, and the conversion is where a
//! value that does not belong in a column is caught.
//!
//! What a column holds is settled by the table being written to, which
//! is read when the appender opens. There is no null: a column that
//! holds one cannot be appended to at all, so a null here could only
//! ever be refused, and refusing it at the row that wrote it is better
//! than refusing it at the flush a million rows later.
//!
//! The rules are the parameter binder's, in [`crate::value`], and they
//! are deliberately the same: a `bigint` is an INT64, a whole `number`
//! is an INT64 too because `[1, 'ada']` is what a caller writes, and
//! the four temporal classes and the `Temporal` values are read the
//! same way in both places. What is different is that a column has
//! already said what it holds, so a value of the wrong type is refused
//! here where the binder would have bound it and let the engine
//! decide.

use napi::bindgen_prelude::*;
use napi::{Env, ValueType};
use zu_common::{DurationKind, FloatBits, IntBits, LogicalType, Temporal};
use zudb::Field;

use crate::temporal;
use crate::value::temporal_from;

/// One column's values, in the shape the property store wants them.
///
/// Owned rather than borrowed from the caller's arrays, because a
/// JavaScript array holds values of the runtime's own and the store
/// holds numbers: there is nothing here to borrow. The arms are the
/// storage arms, so a flush hands a buffer over with no pass to convert
/// it.
pub enum Column {
    Int(Vec<i64>),
    Float(Vec<f64>),
    Bool(Vec<bool>),
    /// Kept as strings rather than as bytes, because the store wants
    /// the bytes and the appender wants the `&str`, and a `String`
    /// lends out either without a copy.
    Str(Vec<String>),
    Bytes(Vec<Vec<u8>>),
    Date(Vec<i32>),
    LocalTime(Vec<i64>),
    LocalDatetime(Vec<i64>),
    Duration(DurationKind, Vec<i64>),
}

/// Why a value did not go in.
///
/// A column that wanted something else says what it holds and lets the
/// caller word the rest, since the caller knows the column's name and
/// where in the row it sits. A value that is of the right kind and
/// still wrong says so itself, as a phrase the caller puts its subject
/// in front of, because "a bigint outside what INT64 holds" is not
/// something a list of column types can express.
pub enum Mismatch {
    Wanted(&'static str),
    Says(String),
    /// The boundary itself failed, which is not the caller's mistake
    /// and is passed along as it is.
    Boundary(Error),
}

impl From<Error> for Mismatch {
    fn from(err: Error) -> Mismatch {
        Mismatch::Boundary(err)
    }
}

impl Column {
    /// The buffer a column of this declared type appends into, or
    /// `None` for a type the ingest path cannot carry.
    ///
    /// The match is on the exact declared type and not on its family,
    /// because that is what the ingest checks: it compares the stored
    /// column's type against the type its values claim, so an `INT32`
    /// column or a `VARCHAR(20)` one has no buffer here even though its
    /// bits would fit the same lane. This is the engine appender's own
    /// table, kept in step with it, because a buffer it would refuse is
    /// better refused before a million rows go into it.
    pub fn for_type(ty: &LogicalType) -> Option<Column> {
        Some(match ty {
            LogicalType::Int {
                signed: true,
                bits: IntBits::B64,
                precision: None,
            } => Column::Int(Vec::new()),
            LogicalType::Bool => Column::Bool(Vec::new()),
            LogicalType::Float {
                bits: FloatBits::B64,
                precision: None,
            } => Column::Float(Vec::new()),
            LogicalType::Date => Column::Date(Vec::new()),
            LogicalType::LocalTime => Column::LocalTime(Vec::new()),
            LogicalType::LocalDatetime => Column::LocalDatetime(Vec::new()),
            LogicalType::Duration(kind) => Column::Duration(*kind, Vec::new()),
            LogicalType::Str {
                min: None,
                max: None,
                fixed: false,
            } => Column::Str(Vec::new()),
            LogicalType::Bytes {
                min: None,
                max: None,
                fixed: false,
            } => Column::Bytes(Vec::new()),
            _ => return None,
        })
    }

    /// Takes one more value, or says why this column would not have it.
    pub fn push(&mut self, env: &Env, value: Unknown<'_>) -> std::result::Result<(), Mismatch> {
        let holds = self.holds();
        let wanted = || Mismatch::Wanted(holds);
        match self {
            Column::Bool(v) => v.push(read_bool(value).ok_or_else(wanted)?),
            Column::Int(v) => v.push(read_int(value)?.ok_or_else(wanted)?),
            Column::Float(v) => v.push(read_float(value)?.ok_or_else(wanted)?),
            Column::Str(v) => v.push(read_str(value)?.ok_or_else(wanted)?),
            Column::Bytes(v) => v.push(read_bytes(value)?.ok_or_else(wanted)?),
            Column::Date(v) => match moment(env, &value)? {
                Some(Temporal::Date(days)) => v.push(days),
                _ => return Err(wanted()),
            },
            Column::LocalTime(v) => match moment(env, &value)? {
                Some(Temporal::LocalTime(nanos)) => v.push(nanos),
                // A time that carries an offset is a different type and
                // not a time this column can hold, and saying so beats
                // dropping the offset or writing it as though it were
                // local.
                Some(Temporal::ZonedTime { .. }) => {
                    return Err(Mismatch::Says(
                        "it carries an offset, and this column holds local times".to_string(),
                    ));
                }
                _ => return Err(wanted()),
            },
            Column::LocalDatetime(v) => match moment(env, &value)? {
                Some(Temporal::LocalDatetime(nanos)) => v.push(nanos),
                Some(Temporal::ZonedDatetime { .. }) => {
                    return Err(Mismatch::Says(
                        "it carries an offset, and this column holds local datetimes".to_string(),
                    ));
                }
                _ => return Err(wanted()),
            },
            Column::Duration(kind, v) => match moment(env, &value)? {
                // The two kinds do not mix: a column of months has no
                // room for a count of nanoseconds and the other way
                // about, and a duration of the other kind is refused
                // rather than converted through a month of some length
                // nobody chose.
                Some(Temporal::Duration(found, count)) if found == *kind => v.push(count),
                Some(Temporal::Duration(..)) => return Err(wanted()),
                _ => return Err(wanted()),
            },
        }
        Ok(())
    }

    /// What this column holds, for the message when it was handed
    /// something else. Plural, because it is the column that is being
    /// described and not the value.
    pub fn holds(&self) -> &'static str {
        match self {
            Column::Int(_) => "whole numbers",
            Column::Float(_) => "floats",
            Column::Bool(_) => "booleans",
            Column::Str(_) => "strings",
            Column::Bytes(_) => "byte strings",
            Column::Date(_) => "dates",
            Column::LocalTime(_) => "times",
            Column::LocalDatetime(_) => "datetimes",
            Column::Duration(DurationKind::YearMonth, _) => "year-month durations",
            Column::Duration(DurationKind::DayTime, _) => "day-time durations",
        }
    }

    /// Drops the value written last, which is how a refused row takes
    /// back the fields it managed to write before the one that failed.
    pub fn pop(&mut self) {
        match self {
            Column::Int(v) => drop(v.pop()),
            Column::Float(v) => drop(v.pop()),
            Column::Bool(v) => drop(v.pop()),
            Column::Str(v) => drop(v.pop()),
            Column::Bytes(v) => drop(v.pop()),
            Column::Date(v) => drop(v.pop()),
            Column::LocalTime(v) | Column::LocalDatetime(v) => drop(v.pop()),
            Column::Duration(_, v) => drop(v.pop()),
        }
    }

    pub fn clear(&mut self) {
        match self {
            Column::Int(v) => v.clear(),
            Column::Float(v) => v.clear(),
            Column::Bool(v) => v.clear(),
            Column::Str(v) => v.clear(),
            Column::Bytes(v) => v.clear(),
            Column::Date(v) => v.clear(),
            Column::LocalTime(v) | Column::LocalDatetime(v) => v.clear(),
            Column::Duration(_, v) => v.clear(),
        }
    }

    /// One value of this column as the engine's appender takes it.
    ///
    /// A field borrows rather than owning, which is the point of it on
    /// a string column: the buffer already holds the bytes and the
    /// appender is about to copy them into its own, so lending them is
    /// the difference between one copy per row and two.
    pub fn field(&self, row: usize) -> Field<'_> {
        match self {
            Column::Int(v) => Field::Int(v[row]),
            Column::Float(v) => Field::Float(v[row]),
            Column::Bool(v) => Field::Bool(v[row]),
            Column::Str(v) => Field::Str(&v[row]),
            Column::Bytes(v) => Field::Bytes(&v[row]),
            Column::Date(v) => Field::Temporal(Temporal::Date(v[row])),
            Column::LocalTime(v) => Field::Temporal(Temporal::LocalTime(v[row])),
            Column::LocalDatetime(v) => Field::Temporal(Temporal::LocalDatetime(v[row])),
            Column::Duration(kind, v) => Field::Temporal(Temporal::Duration(*kind, v[row])),
        }
    }
}

fn read_bool(value: Unknown<'_>) -> Option<bool> {
    match value.get_type().ok()? {
        ValueType::Boolean => bool::from_unknown(value).ok(),
        _ => None,
    }
}

/// A `bigint`, or a `number` that is a whole one.
///
/// The `number` is the reason this is not one line. A caller writing
/// row literals writes `[1, 'ada']`, and refusing that because the
/// column is INT64 would be pedantry, so a whole number goes in. One
/// that is not whole does not: rounding it would put a value in the
/// database that the caller never wrote, and a number past 2^53 is one
/// whose neighbours it can no longer be told from, so both are refused
/// where they were written.
fn read_int(value: Unknown<'_>) -> std::result::Result<Option<i64>, Mismatch> {
    match value.get_type()? {
        ValueType::BigInt => {
            let (n, lossless) = BigInt::from_unknown(value)?.get_i64();
            match lossless {
                true => Ok(Some(n)),
                false => Err(Mismatch::Says(
                    "it is a bigint outside what INT64 holds, which is -2^63 up to 2^63 - 1"
                        .to_string(),
                )),
            }
        }
        ValueType::Number => {
            let n = f64::from_unknown(value)?;
            if n.fract() != 0.0 {
                return Err(Mismatch::Says(format!(
                    "it is {n}, which is not a whole number"
                )));
            }
            if n.abs() > 9_007_199_254_740_992.0 {
                return Err(Mismatch::Says(format!(
                    "it is {n}, which is past 2^53, where a number can no longer be told from \
                     its neighbours: write it as a bigint"
                )));
            }
            Ok(Some(n as i64))
        }
        _ => Ok(None),
    }
}

fn read_float(value: Unknown<'_>) -> std::result::Result<Option<f64>, Mismatch> {
    match value.get_type()? {
        ValueType::Number => Ok(Some(f64::from_unknown(value)?)),
        _ => Ok(None),
    }
}

fn read_str(value: Unknown<'_>) -> std::result::Result<Option<String>, Mismatch> {
    match value.get_type()? {
        ValueType::String => Ok(Some(String::from_unknown(value)?)),
        _ => Ok(None),
    }
}

/// The bytes of a `Uint8Array`, which is what a `Buffer` is too.
fn read_bytes(value: Unknown<'_>) -> std::result::Result<Option<Vec<u8>>, Mismatch> {
    if value.get_type()? != ValueType::Object || !value.is_typedarray()? {
        return Ok(None);
    }
    // A typed array of some other width is not bytes, and it says so
    // the way every other wrong value does rather than as a boundary
    // failure about a conversion the caller never wrote.
    Ok(Uint8Array::from_unknown(value)
        .ok()
        .map(|array| array.to_vec()))
}

/// The instant a value carries, whichever of the two spellings it is
/// written in.
///
/// The four classes first and `Temporal` second, which is the order
/// [`crate::value`] binds a parameter in and for the same reason: a
/// `Temporal` value has no own enumerable properties, so anything that
/// reads it as a plain object reads it as empty.
fn moment(env: &Env, value: &Unknown<'_>) -> std::result::Result<Option<Temporal>, Mismatch> {
    if value.get_type()? != ValueType::Object {
        return Ok(None);
    }
    if let Some(found) = temporal_from(env, value)? {
        return Ok(Some(found));
    }
    Ok(temporal::from_temporal(env, "this value", value)?)
}

/// What arrived, in the words a person writing JavaScript uses for it.
///
/// A class name where there is one, because `a ZuTimestamp` in a
/// message about a column of dates is the whole explanation, and `an
/// object` is a message that sends the reader back to their own code to
/// work out which object.
pub fn named(value: &Unknown<'_>) -> String {
    let kind = match value.get_type() {
        Ok(kind) => kind,
        Err(_) => return "a value this client could not read".to_string(),
    };
    match kind {
        ValueType::Undefined => "undefined".to_string(),
        ValueType::Null => "null".to_string(),
        ValueType::Object => class_of(value).map_or_else(
            || "an object".to_string(),
            |name| match name.starts_with(['A', 'E', 'I', 'O', 'U']) {
                true => format!("an {name}"),
                false => format!("a {name}"),
            },
        ),
        other => format!("a {other}").to_lowercase(),
    }
}

/// The name of the class a value was made by, when it has one that is
/// worth printing.
fn class_of(value: &Unknown<'_>) -> Option<String> {
    let object = Object::from_unknown(*value).ok()?;
    let constructor: Unknown<'_> = object.get_named_property("constructor").ok()?;
    if constructor.get_type().ok()? != ValueType::Function {
        return None;
    }
    let name: String = Object::from_unknown(constructor)
        .ok()?
        .get_named_property("name")
        .ok()?;
    match name.is_empty() {
        true => None,
        false => Some(name),
    }
}
