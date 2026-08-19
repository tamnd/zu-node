//! Values, both ways across the boundary.
//!
//! A row that arrives as JavaScript objects is the slow path and the
//! one every first program uses, so it is the one that has to be
//! obvious: null is `null`, a string is a string, and a graph value is
//! a class with named fields rather than a tuple whose third element
//! is the ordinal if you remember the order.
//!
//! INT64 is `bigint` by default, which is ADR 0003 in the engine
//! repository. A JavaScript number is an IEEE double and stops being
//! exact at 2^53, zu's integers go to 2^63, and `count(*)` over a
//! large graph gets there on its own. A client that returns a number
//! here is a client whose users file "the id came back wrong" a year
//! later.
//!
//! A caller may ask for numbers anyway, with `bigIntMode: "number"`,
//! and then an integer outside what a double holds exactly is refused
//! rather than rounded. See [`Ints`].
//!
//! Going the other way a `number` that is a whole number binds as
//! INT64 and one that is not binds as FLOAT, because `{ id: 1 }` is
//! what a caller writes and refusing it would be pedantry. A `bigint`
//! always binds as INT64, which is the way to be sure.

use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi::{Env, ValueType};
use napi_derive::napi;
use zu_common::{DurationKind, Temporal};
use zudb::query::Value;
use zudb::zu1::catalog::Catalog;

use crate::error::usage;
use crate::temporal;

/// How an INT64 is spelled on the way out.
///
/// `bigint` is the default and the only one that is always right. The
/// other exists because a program that already knows its integers are
/// small spends a `Number(...)` on every one of them otherwise, and
/// because a `bigint` has no JSON spelling, so a result holding one
/// cannot be handed to `JSON.stringify` at all.
///
/// The hazard of the second is the whole reason it is not the default:
/// which integers a database holds is a property of the data and not of
/// the program, so a query that worked on every row of a test database
/// is a query that can fail on the one row where an id passed 2^53.
/// This client refuses that row rather than rounding it, which turns a
/// wrong answer into a failure that names the column, and that is the
/// most a client can do about a decision the caller has already made.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Ints {
    #[default]
    BigInt,
    Number,
}

impl Ints {
    /// The mode `bigIntMode` names, or what is wrong with what it named.
    pub fn named(mode: &str) -> std::result::Result<Ints, String> {
        match mode {
            "bigint" => Ok(Ints::BigInt),
            "number" => Ok(Ints::Number),
            other => Err(format!(
                "bigIntMode is \"{other}\", and the modes are \"bigint\" and \"number\""
            )),
        }
    }
}

/// How a statement spells the values it gives back.
///
/// Two decisions, both made where the connection is opened and one of
/// them changeable per statement. They travel together because they
/// travel the same way: from the call, through the task, to the thread
/// the statement runs on, and back to the row that is being built.
#[derive(Clone, Copy, Default)]
pub struct Spelling {
    /// How an INT64 comes back.
    pub ints: Ints,
    /// Whether a temporal value comes back as a `Temporal` one rather
    /// than as one of this client's four classes. Off unless the
    /// connection asked for it, and asking on a runtime without
    /// `Temporal` fails at the connect rather than at the first row.
    pub temporal: bool,
}

/// What a result needs on the way out.
///
/// The table names are the statement's, and so is the spelling of its
/// values, so both are settled once where the connection is held and
/// then read by every value of every row.
pub struct Shape {
    names: Names,
    spelling: Spelling,
}

impl Shape {
    pub fn of(catalog: &Catalog, spelling: Spelling) -> Shape {
        Shape {
            names: Names::of(catalog),
            spelling,
        }
    }
}

/// What the tables in a result are called.
///
/// A node value carries the id of the table it came from and nothing
/// else, because that is what a row holds. A person reading a result
/// wants the name, so the names are taken off the catalog once when a
/// statement runs and carried with the rows. A catalog holds tens of
/// tables, so this is a copy of a few short strings and not a
/// structure worth sharing.
#[derive(Default)]
pub struct Names {
    nodes: HashMap<u32, String>,
    rels: HashMap<u32, String>,
}

impl Names {
    pub fn of(catalog: &Catalog) -> Names {
        Names {
            nodes: catalog
                .node_tables()
                .iter()
                .map(|table| (table.id, table.name.clone()))
                .collect(),
            rels: catalog
                .rel_tables()
                .iter()
                .map(|table| (table.id, table.name.clone()))
                .collect(),
        }
    }

    /// The table's name, or its id written out for a table the catalog
    /// no longer has. A result outlives nothing here, but a name is for
    /// reading and an unreadable one should still print.
    fn node(&self, id: u32) -> String {
        self.nodes
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("#{id}"))
    }

    fn rel(&self, id: u32) -> String {
        self.rels
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("#{id}"))
    }
}

/// One node of the graph.
///
/// The table is the name written in the schema and the offset is the
/// row it sits at in that table, which together are what identifies a
/// node in zu. The offset is a `bigint` for the reason every other
/// 64-bit integer here is one.
///
/// The 64-bit fields are held as integers and handed out as `bigint` by
/// a getter, rather than being held as a `bigint` and handed out
/// directly, because a `bigint` is a JavaScript value and a value
/// cannot be held by a struct that is built on a threadpool thread
/// where there is no environment to build one in.
#[napi]
pub struct ZuNode {
    table: String,
    offset: u64,
}

#[napi]
impl ZuNode {
    #[napi(getter)]
    pub fn table(&self) -> &str {
        &self.table
    }

    #[napi(getter)]
    pub fn offset(&self) -> BigInt {
        BigInt::from(self.offset)
    }

    /// The same thing as a plain object.
    ///
    /// Every field here is a getter on the prototype, which is what
    /// lets a 64-bit field be handed out as a `bigint`, and a getter is
    /// invisible to `JSON.stringify` and to a shallow copy. So each of
    /// these classes says what it holds when it is asked, and a caller
    /// stringifying a row gets the node rather than `{}`. A `bigint`
    /// still has no JSON spelling, so a caller doing that passes a
    /// replacer, which they already had to.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("table", self.table.as_str())?;
        object.set("offset", BigInt::from(self.offset))?;
        Ok(object)
    }
}

/// One edge of the graph.
///
/// `ord` is where the edge's properties sit, which is its place in the
/// order the table was loaded in. That is what names an edge: a pair of
/// endpoints does not, since the same pair may run more than once and
/// each of those edges carries its own values. It is the field a caller
/// usually ignores and the one nothing else can replace.
#[napi]
pub struct ZuRel {
    table: String,
    src: u64,
    dst: u64,
    ord: u64,
}

#[napi]
impl ZuRel {
    #[napi(getter)]
    pub fn table(&self) -> &str {
        &self.table
    }

    #[napi(getter)]
    pub fn src(&self) -> BigInt {
        BigInt::from(self.src)
    }

    #[napi(getter)]
    pub fn dst(&self) -> BigInt {
        BigInt::from(self.dst)
    }

    #[napi(getter)]
    pub fn ord(&self) -> BigInt {
        BigInt::from(self.ord)
    }

    /// The same thing as a plain object, for the reason [`ZuNode::to_json`]
    /// gives.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("table", self.table.as_str())?;
        object.set("src", BigInt::from(self.src))?;
        object.set("dst", BigInt::from(self.dst))?;
        object.set("ord", BigInt::from(self.ord))?;
        Ok(object)
    }
}

/// A date, as days from 1970-01-01.
///
/// A count rather than a set of fields, which is what the engine
/// stores and what makes two dates compare as two numbers. `Temporal`
/// reached Stage 4 in March 2026 but is unflagged only in Node 26 and
/// the newest browsers, and Node 24 is still the active LTS, so this
/// is the stable type and the runtimes that have `Temporal` reach it
/// through the opt-in rather than through a type that changes shape
/// under them.
#[napi]
pub struct ZuDate {
    pub days: i32,
}

#[napi]
impl ZuDate {
    #[napi(constructor)]
    pub fn new(days: i32) -> ZuDate {
        ZuDate { days }
    }

    /// The same day as a `Temporal.PlainDate`.
    ///
    /// For the program that wants one value converted rather than all of
    /// them, which is the common one: a result is read for its ids and
    /// its names and then formats the one date it is going to show. A
    /// connection opened with `{ temporal: true }` does this to every
    /// temporal value it gives back and this method is what it calls.
    ///
    /// Throws on a runtime that has no `Temporal`, naming the flag that
    /// turns it on.
    #[napi(js_name = "toTemporal", ts_return_type = "ZuPlainDate")]
    pub fn to_temporal<'env>(&self, env: &'env Env) -> Result<Unknown<'env>> {
        converted(env, Temporal::Date(self.days))
    }

    /// The same thing as a plain object, for the reason [`ZuNode::to_json`]
    /// gives.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("days", self.days)?;
        Ok(object)
    }
}

/// A time of day, as nanoseconds from midnight, with the offset from
/// UTC in minutes for a zoned one and `null` for a local one.
///
/// The offset is minutes and never an IANA name, which is the engine's
/// decision and worth repeating here: a name is a rule that changes
/// under a stored value when the zone database is updated, and a value
/// that means something different tomorrow is not a value.
#[napi]
pub struct ZuTime {
    nanos: i64,
    pub offset: Option<i32>,
}

#[napi]
impl ZuTime {
    #[napi(constructor)]
    pub fn new(nanos: BigInt, offset: Option<i32>) -> ZuTime {
        ZuTime {
            nanos: nanos.get_i64().0,
            offset,
        }
    }

    #[napi(getter)]
    pub fn nanos(&self) -> BigInt {
        BigInt::from(self.nanos)
    }

    /// The same time as a `Temporal.PlainTime`.
    ///
    /// A local time only. A time with an offset has no `Temporal` type
    /// at all, so one throws here rather than losing the offset, and the
    /// message says why.
    #[napi(js_name = "toTemporal", ts_return_type = "ZuPlainTime")]
    pub fn to_temporal<'env>(&self, env: &'env Env) -> Result<Unknown<'env>> {
        match self.offset {
            Some(offset) => converted(
                env,
                Temporal::ZonedTime {
                    nanos: self.nanos,
                    offset: offset as i16,
                },
            ),
            None => converted(env, Temporal::LocalTime(self.nanos)),
        }
    }

    /// The same thing as a plain object, for the reason [`ZuNode::to_json`]
    /// gives.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("nanos", BigInt::from(self.nanos))?;
        object.set("offset", self.offset)?;
        Ok(object)
    }
}

/// A date and a time together, as nanoseconds from the epoch, with the
/// offset from UTC in minutes for a zoned one and `null` for a local
/// one.
///
/// A zoned one holds the instant in UTC and the offset separately, so
/// two of them compare as instants while each still prints in the zone
/// it was written in.
#[napi]
pub struct ZuTimestamp {
    nanos: i64,
    pub offset: Option<i32>,
}

#[napi]
impl ZuTimestamp {
    #[napi(constructor)]
    pub fn new(nanos: BigInt, offset: Option<i32>) -> ZuTimestamp {
        ZuTimestamp {
            nanos: nanos.get_i64().0,
            offset,
        }
    }

    #[napi(getter)]
    pub fn nanos(&self) -> BigInt {
        BigInt::from(self.nanos)
    }

    /// The same instant as a `Temporal.PlainDateTime` for a local one
    /// and a `Temporal.ZonedDateTime` for a zoned one.
    ///
    /// The zone of a zoned one is the offset it was written at, spelled
    /// `+02:00`, because that is what the engine stores. A named zone is
    /// a rule that changes under a stored value when the zone database
    /// is updated, so no value here has ever had one.
    #[napi(
        js_name = "toTemporal",
        ts_return_type = "ZuPlainDateTime | ZuZonedDateTime"
    )]
    pub fn to_temporal<'env>(&self, env: &'env Env) -> Result<Unknown<'env>> {
        match self.offset {
            Some(offset) => converted(
                env,
                Temporal::ZonedDatetime {
                    nanos: self.nanos,
                    offset: offset as i16,
                },
            ),
            None => converted(env, Temporal::LocalDatetime(self.nanos)),
        }
    }

    /// The same thing as a plain object, for the reason [`ZuNode::to_json`]
    /// gives.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("nanos", BigInt::from(self.nanos))?;
        object.set("offset", self.offset)?;
        Ok(object)
    }
}

/// A duration, which is a count of months or a count of nanoseconds
/// and never both.
///
/// The two kinds do not mix, because no number of days is a month: a
/// value holding both would have to invent an answer for one month
/// after 31 January, and the standard does not ask for the invention.
/// `kind` says which one this is, and the other count is zero.
#[napi]
pub struct ZuDuration {
    kind: &'static str,
    months: i64,
    nanos: i64,
}

#[napi]
impl ZuDuration {
    /// A duration of `months` months, which is the year-month kind.
    #[napi(factory, js_name = "ofMonths")]
    pub fn of_months(months: BigInt) -> ZuDuration {
        year_month(months.get_i64().0)
    }

    /// A duration of `nanos` nanoseconds, which is the day-time kind.
    #[napi(factory, js_name = "ofNanos")]
    pub fn of_nanos(nanos: BigInt) -> ZuDuration {
        day_time(nanos.get_i64().0)
    }

    /// Which of the two kinds this is: `yearMonth` or `dayTime`.
    #[napi(getter)]
    pub fn kind(&self) -> &str {
        self.kind
    }

    /// The months, which is zero for a day-time duration.
    #[napi(getter)]
    pub fn months(&self) -> BigInt {
        BigInt::from(self.months)
    }

    /// The nanoseconds, which is zero for a year-month duration.
    #[napi(getter)]
    pub fn nanos(&self) -> BigInt {
        BigInt::from(self.nanos)
    }

    /// The same length as a `Temporal.Duration`.
    ///
    /// A year-month one becomes months and a day-time one becomes
    /// seconds and nanoseconds, which are the fields that hold what zu
    /// stores without inventing the rest: `Temporal.Duration` can carry
    /// months and days at once and no zu duration ever does.
    #[napi(js_name = "toTemporal", ts_return_type = "ZuTemporalDuration")]
    pub fn to_temporal<'env>(&self, env: &'env Env) -> Result<Unknown<'env>> {
        let kind = match self.kind {
            "yearMonth" => Temporal::Duration(DurationKind::YearMonth, self.months),
            _ => Temporal::Duration(DurationKind::DayTime, self.nanos),
        };
        converted(env, kind)
    }

    /// The same thing as a plain object, for the reason [`ZuNode::to_json`]
    /// gives.
    #[napi(js_name = "toJSON")]
    pub fn to_json<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let mut object = Object::new(env)?;
        object.set("kind", self.kind)?;
        object.set("months", BigInt::from(self.months))?;
        object.set("nanos", BigInt::from(self.nanos))?;
        Ok(object)
    }
}

/// What `toTemporal()` gives back, which is the `Temporal` value or the
/// reason there is not one.
///
/// The reason is a `ZuUsageError` rather than a plain throw, because it
/// is the same kind of thing every other refusal in this client is: the
/// caller asked for something the value cannot be, and the answer names
/// the value rather than the line it happened on.
fn converted(env: &Env, value: Temporal) -> Result<Unknown<'_>> {
    // A runtime without `Temporal` at all, which the connect option
    // catches before a statement runs and this method cannot: it is
    // called on a value that already exists, so the first it hears of
    // the runtime is now.
    if !temporal::present(env)? {
        return Err(usage(env, temporal::MISSING));
    }
    match temporal::to_temporal(env, value)? {
        Some(made) => Ok(made),
        None => Err(usage(env, temporal::NO_ZONED_TIME)),
    }
}

fn year_month(months: i64) -> ZuDuration {
    ZuDuration {
        kind: "yearMonth",
        months,
        nanos: 0,
    }
}

fn day_time(nanos: i64) -> ZuDuration {
    ZuDuration {
        kind: "dayTime",
        months: 0,
        nanos,
    }
}

/// Turns an engine value into the JavaScript value it is.
///
/// `column` is the name the value arrived under, carried the whole way
/// down for the same reason [`from_js`] carries one up: the only thing
/// that can fail here is an integer that will not fit the spelling the
/// caller asked for, and a caller told which column that was can act on
/// it, while one told the number alone has to go looking.
pub fn to_js<'env>(
    env: &'env Env,
    column: &str,
    value: &Value,
    shape: &Shape,
) -> Result<Unknown<'env>> {
    match value {
        Value::Null => Null.into_unknown(env),
        Value::Bool(b) => (*b).into_unknown(env),
        Value::Int(n) => int(env, column, *n, shape.spelling.ints),
        Value::Float(f) => (*f).into_unknown(env),
        Value::Str(s) => s.as_str().into_unknown(env),
        Value::Node { table, offset } => node(*table, *offset, &shape.names)
            .into_instance(env)?
            .into_unknown(env),
        Value::Rel {
            table,
            src,
            dst,
            ord,
        } => rel(*table, *src, *dst, *ord, &shape.names)
            .into_instance(env)?
            .into_unknown(env),
        Value::List(items) => {
            let mut array = env.create_array(items.len() as u32)?;
            for (ix, item) in items.iter().enumerate() {
                array.set(ix as u32, to_js(env, column, item, shape)?)?;
            }
            array.into_unknown(env)
        }
        Value::Record(fields) => {
            let mut object = Object::new(env)?;
            for (name, field) in fields {
                object.set(name.as_str(), to_js(env, column, field, shape)?)?;
            }
            object.into_unknown(env)
        }
        Value::Temporal(t) => moment(env, *t, shape.spelling.temporal),
        Value::Path(walk) => path(env, walk, &shape.names),
        // The three the executor keeps to itself. A chain is settled
        // into an edge list before any value leaves the pipeline, and a
        // graph or a binding table is a handle to something that has no
        // spelling outside the engine, so none of these reaches a
        // result and the arm is here to be exhaustive rather than to
        // run.
        Value::Chain(_) | Value::Graph(_) | Value::BindingTable(_) => Null.into_unknown(env),
    }
}

/// The largest integer a JavaScript number holds exactly, which is
/// 2^53 - 1, and the smallest is its negation.
///
/// Past it the doubles run out of significand and start standing for
/// two integers at once: 2^53 and 2^53 + 1 are the same double, so a
/// number that came back from there cannot be turned into the integer
/// it was.
const EXACT: i64 = 9_007_199_254_740_991;

/// An INT64, spelled the way this statement was asked to spell them.
///
/// The refusal is a usage error rather than a data error, because
/// nothing is wrong with the value: it is a perfectly good INT64 and
/// the program asked for a container that does not hold it. Naming the
/// column and the value gives the caller the two things they need to
/// decide whether to widen the mode or narrow the query.
fn int<'env>(env: &'env Env, column: &str, n: i64, ints: Ints) -> Result<Unknown<'env>> {
    match ints {
        Ints::BigInt => BigInt::from(n).into_unknown(env),
        Ints::Number if !(-EXACT..=EXACT).contains(&n) => Err(usage(
            env,
            format!(
                "column {column} holds {n}, which a JavaScript number cannot tell from \
                 its neighbours, and this statement asked for bigIntMode: \"number\""
            ),
        )),
        Ints::Number => (n as f64).into_unknown(env),
    }
}

fn node(table: u32, offset: u64, names: &Names) -> ZuNode {
    ZuNode {
        table: names.node(table),
        offset,
    }
}

fn rel(table: u32, src: u64, dst: u64, ord: u64, names: &Names) -> ZuRel {
    ZuRel {
        table: names.rel(table),
        src,
        dst,
        ord,
    }
}

/// A walk through the graph: nodes and edges, alternating, a node at
/// each end, given back as `{ nodes, rels }`.
///
/// The engine hands one over as the walk itself: node, edge, node,
/// edge, node. The two lists are kept apart rather than interleaved,
/// because the question a caller asks is almost always about one of
/// them and picking one out of an alternating list means writing the
/// stride by hand. Splitting it here rather than in JavaScript is one
/// pass instead of two, and it is the difference between `path.nodes`
/// and `path.items.filter((_, i) => i % 2 === 0)`. A path of one node
/// has no edges and is the shortest there is.
fn path<'env>(env: &'env Env, walk: &[Value], names: &Names) -> Result<Unknown<'env>> {
    let mut nodes = env.create_array(0)?;
    let mut rels = env.create_array(0)?;
    for step in walk {
        match step {
            Value::Node { table, offset } => nodes.insert(node(*table, *offset, names))?,
            Value::Rel {
                table,
                src,
                dst,
                ord,
            } => rels.insert(rel(*table, *src, *dst, *ord, names))?,
            // A path holds nodes and edges and the engine builds one
            // through a constructor that checks the shape, so anything
            // else here would be a bug in the engine rather than in the
            // caller's statement. Dropping it keeps the two lists
            // aligned, which is what a reader of them relies on.
            _ => {}
        }
    }
    let mut object = Object::new(env)?;
    object.set("nodes", nodes)?;
    object.set("rels", rels)?;
    object.into_unknown(env)
}

/// A temporal value, spelled the way this statement was asked to spell
/// them.
///
/// A connection that asked for `Temporal` gets it for every value that
/// has a `Temporal` type, and the one that does not, which is a time
/// with an offset, keeps its class. That is a mode with a hole in it and
/// the hole is the standard's: `PlainTime` is local and `ZonedDateTime`
/// carries a date, so the alternatives are dropping the offset or
/// inventing a day, and a class the caller already knows how to read is
/// better than either.
fn moment(env: &Env, value: Temporal, wanted: bool) -> Result<Unknown<'_>> {
    if wanted && let Some(made) = temporal::to_temporal(env, value)? {
        return Ok(made);
    }
    as_class(env, value)
}

fn as_class(env: &Env, value: Temporal) -> Result<Unknown<'_>> {
    match value {
        Temporal::Date(days) => ZuDate { days }.into_instance(env)?.into_unknown(env),
        Temporal::LocalTime(nanos) => ZuTime {
            nanos,
            offset: None,
        }
        .into_instance(env)?
        .into_unknown(env),
        Temporal::ZonedTime { nanos, offset } => ZuTime {
            nanos,
            offset: Some(i32::from(offset)),
        }
        .into_instance(env)?
        .into_unknown(env),
        Temporal::LocalDatetime(nanos) => ZuTimestamp {
            nanos,
            offset: None,
        }
        .into_instance(env)?
        .into_unknown(env),
        Temporal::ZonedDatetime { nanos, offset } => ZuTimestamp {
            nanos,
            offset: Some(i32::from(offset)),
        }
        .into_instance(env)?
        .into_unknown(env),
        Temporal::Duration(DurationKind::YearMonth, months) => {
            year_month(months).into_instance(env)?.into_unknown(env)
        }
        Temporal::Duration(DurationKind::DayTime, nanos) => {
            day_time(nanos).into_instance(env)?.into_unknown(env)
        }
    }
}

/// Turns a JavaScript value into the engine value it binds as.
///
/// The refusals are the point of this function. A parameter that
/// cannot be bound is told so by name and by type, on the call that
/// passed it, rather than becoming a null the statement then compares
/// against and answers nothing for.
///
/// A refusal is an `InvalidArg`, which is how [`crate::conn`] tells one
/// apart from a boundary failure and turns it into the rejection the
/// caller is already awaiting.
pub fn from_js(env: &Env, name: &str, value: Unknown<'_>) -> Result<Value> {
    nested(env, name, value, 0)
}

/// How deep a parameter may nest before this stops reading it.
///
/// A list of lists of records is a value somebody meant to send, and a
/// value that contains itself is a call that would otherwise walk until
/// the stack ran out and take the process with it. There is no depth
/// between the two that anybody writes on purpose, so the limit is set
/// where a real value never reaches and a cycle always does.
const DEEP: usize = 64;

fn nested(env: &Env, name: &str, value: Unknown<'_>, depth: usize) -> Result<Value> {
    if depth > DEEP {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "parameter {name} nests deeper than {DEEP}, which is what a value that contains \
                 itself looks like"
            ),
        ));
    }
    match value.get_type()? {
        ValueType::Null | ValueType::Undefined => Ok(Value::Null),
        ValueType::Boolean => Ok(Value::Bool(bool::from_unknown(value)?)),
        ValueType::String => Ok(Value::Str(String::from_unknown(value)?)),
        ValueType::BigInt => {
            let big = BigInt::from_unknown(value)?;
            let (n, lossless) = big.get_i64();
            if !lossless {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "parameter {name} is a bigint outside what INT64 holds, \
                         which is -2^63 up to 2^63 - 1"
                    ),
                ));
            }
            Ok(Value::Int(n))
        }
        // A whole number binds as an integer and anything else as a
        // float. The alternative, binding every number as a float,
        // makes `{ id: 1 }` fail to match a row whose id is an integer,
        // which is the first thing anybody writes.
        ValueType::Number => {
            let n = f64::from_unknown(value)?;
            if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_992.0 {
                Ok(Value::Int(n as i64))
            } else {
                Ok(Value::Float(n))
            }
        }
        ValueType::Object => from_object(env, name, value, depth),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("parameter {name} is a {other}, which is not a value a statement can hold"),
        )),
    }
}

fn from_object(env: &Env, name: &str, value: Unknown<'_>, depth: usize) -> Result<Value> {
    if let Some(temporal) = temporal_from(env, &value)? {
        return Ok(Value::Temporal(temporal));
    }
    let object = Object::from_unknown(value)?;
    if object.is_array()? {
        let len = object.get_array_length()?;
        let mut items = Vec::with_capacity(len as usize);
        for ix in 0..len {
            let item: Unknown<'_> = object.get_element(ix)?;
            items.push(nested(env, name, item, depth + 1)?);
        }
        return Ok(Value::List(items));
    }
    // After the array and before the record, because a `Temporal` value
    // has no own enumerable properties at all: read as a record it
    // would bind as `{}` and compare against nothing, which is the one
    // outcome worse than a refusal.
    if let Some(moment) = temporal::from_temporal(env, name, &value)? {
        return Ok(Value::Temporal(moment));
    }
    // A plain object is a record, which is the one mapping that reads
    // the same in both directions: a record comes back as an object
    // with the same field names.
    let mut fields = Vec::new();
    for key in Object::keys(&object)? {
        let field: Unknown<'_> = object.get_named_property(key.as_str())?;
        fields.push((key, nested(env, name, field, depth + 1)?));
    }
    Ok(Value::record(fields))
}

/// The four value classes, recognized by asking each one whether this
/// is one of its own rather than by reading a tag off the object.
/// A plain object shaped like a date is a record, and only an instance
/// is a date.
pub(crate) fn temporal_from(env: &Env, value: &Unknown<'_>) -> Result<Option<Temporal>> {
    if ZuDate::instance_of(env, value)? {
        let days: i32 = Object::from_unknown(*value)?.get_named_property("days")?;
        return Ok(Some(Temporal::Date(days)));
    }
    if ZuTime::instance_of(env, value)? {
        let (nanos, offset) = parts(value)?;
        return Ok(Some(match offset {
            Some(offset) => Temporal::ZonedTime { nanos, offset },
            None => Temporal::LocalTime(nanos),
        }));
    }
    if ZuTimestamp::instance_of(env, value)? {
        let (nanos, offset) = parts(value)?;
        return Ok(Some(match offset {
            Some(offset) => Temporal::ZonedDatetime { nanos, offset },
            None => Temporal::LocalDatetime(nanos),
        }));
    }
    if ZuDuration::instance_of(env, value)? {
        let object = Object::from_unknown(*value)?;
        let kind: String = object.get_named_property("kind")?;
        return Ok(Some(if kind == "yearMonth" {
            let months: BigInt = object.get_named_property("months")?;
            Temporal::Duration(DurationKind::YearMonth, months.get_i64().0)
        } else {
            let nanos: BigInt = object.get_named_property("nanos")?;
            Temporal::Duration(DurationKind::DayTime, nanos.get_i64().0)
        }));
    }
    Ok(None)
}

/// The nanosecond count and the offset a time or a timestamp carries.
/// The offset is what tells a zoned one from a local one, so it stays
/// an option all the way rather than becoming a zero that would read
/// as UTC.
fn parts(value: &Unknown<'_>) -> Result<(i64, Option<i16>)> {
    let object = Object::from_unknown(*value)?;
    let nanos: BigInt = object.get_named_property("nanos")?;
    let offset: Option<i32> = object.get_named_property("offset")?;
    Ok((nanos.get_i64().0, offset.map(|minutes| minutes as i16)))
}
