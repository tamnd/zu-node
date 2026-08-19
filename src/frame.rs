//! A frame of columns, described where the caller keeps them.
//!
//! The way in for data that is already in columns. What a JavaScript
//! program holds columns in is a typed array, and what an
//! `apache-arrow` table holds them in is typed arrays too: eight-byte
//! words back to back, one bit a row for a boolean, characters end to
//! end with offsets cutting them up. That is how this engine lays a
//! column out as well, so what this module produces is not a copy of any
//! of it but a description: where each column is, how wide its values
//! are, and what they mean.
//!
//! A typed array is not a Rust buffer, and the difference is who may
//! collect it. So every array a description points at is held here as a
//! reference the runtime counts, which is what [`Held`] is, and the
//! engine drops that when the last table naming those bytes goes. The
//! drop may happen on a thread that is not the runtime's, which is the
//! one thing about this that needs saying: napi-rs routes the release
//! back to the thread that owns the array rather than touching V8 from
//! wherever the frame died.
//!
//! Two things copy, and both are said rather than hidden. A column an
//! Arrow table holds in more than one chunk is concatenated, because a
//! column of a table is one run of bytes and three chunks are three of
//! them; that is a memcpy per column and it happens once. A plain array
//! of JavaScript values is read into buffers of this module's own,
//! because an array holds values of the runtime and a column holds
//! numbers, so there is nothing there to point at.
//!
//! There is no null anywhere in it. A property that is null is one no
//! row of this engine can hold, so a column with a gap in it can only
//! ever be refused, and refusing it by name and row number is the
//! difference between a caller who knows which cell to fix and one who
//! knows only that something somewhere was empty.

use std::ptr::NonNull;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::{Env, ValueType};
use zu_common::{DurationKind, FloatBits, IntBits, LogicalType};
use zudb::{Column as Described_, Layout};

use crate::buffer::{self, Mismatch, named};

/// What a registered frame's bytes are, and the thing whose life is
/// their life.
///
/// Both halves are filled as the columns need them. The lent arrays are
/// the caller's own, held so the runtime cannot collect them while a
/// statement is reading them; the owned buffers are what this client
/// built out of JavaScript values, for a caller with no frame library
/// and for the columns an Arrow table did not hand over whole.
pub struct Held {
    lent: Vec<Lent>,
    owned: Vec<Bytes>,
}

impl Held {
    fn new() -> Held {
        Held {
            lent: Vec::new(),
            owned: Vec::new(),
        }
    }

    /// Keeps one of the caller's arrays and says where its bytes are.
    fn lend(&mut self, array: Lent) -> NonNull<u8> {
        let ptr = array.ptr();
        self.lent.push(array);
        ptr
    }

    /// Keeps one buffer of this module's own and says where it is.
    ///
    /// The pointer survives everything after it, because what moves when
    /// the vector of them grows is the enum and not the allocation it
    /// names.
    fn own(&mut self, bytes: Bytes) -> NonNull<u8> {
        let ptr = bytes.ptr();
        self.owned.push(bytes);
        ptr
    }
}

/// One of the caller's typed arrays, held by reference.
///
/// Ten variants rather than one, because napi hands a typed array back
/// as the Rust type that matches its elements and each of those is a
/// different type that owns a different reference. What this module
/// wants from all of them is the same three things, which is what the
/// methods under it answer.
enum Lent {
    I8(Int8Array),
    U8(Uint8Array),
    I16(Int16Array),
    U16(Uint16Array),
    I32(Int32Array),
    U32(Uint32Array),
    I64(BigInt64Array),
    U64(BigUint64Array),
    F32(Float32Array),
    F64(Float64Array),
}

impl Lent {
    /// The array a value is, or `None` for a value that is not one.
    ///
    /// The kind is read first, off a borrowed view that takes no
    /// reference, so the array is claimed once and by the arm that
    /// wanted it rather than tried against each of ten in turn.
    fn of(value: Unknown<'_>) -> std::result::Result<Option<Lent>, Error> {
        if value.get_type()? != ValueType::Object || !value.is_typedarray()? {
            return Ok(None);
        }
        let kind = TypedArray::from_unknown(value)?.typed_array_type;
        Ok(Some(match kind {
            TypedArrayType::Int8 => Lent::I8(Int8Array::from_unknown(value)?),
            // A clamped array holds bytes like any other and clamping is
            // a rule about writing into one, which nothing here does.
            TypedArrayType::Uint8 | TypedArrayType::Uint8Clamped => {
                Lent::U8(Uint8Array::from_unknown(value)?)
            }
            TypedArrayType::Int16 => Lent::I16(Int16Array::from_unknown(value)?),
            TypedArrayType::Uint16 => Lent::U16(Uint16Array::from_unknown(value)?),
            TypedArrayType::Int32 => Lent::I32(Int32Array::from_unknown(value)?),
            TypedArrayType::Uint32 => Lent::U32(Uint32Array::from_unknown(value)?),
            TypedArrayType::BigInt64 => Lent::I64(BigInt64Array::from_unknown(value)?),
            TypedArrayType::BigUint64 => Lent::U64(BigUint64Array::from_unknown(value)?),
            TypedArrayType::Float32 => Lent::F32(Float32Array::from_unknown(value)?),
            TypedArrayType::Float64 => Lent::F64(Float64Array::from_unknown(value)?),
            _ => return Ok(None),
        }))
    }

    /// Every byte of it, whatever its elements are.
    fn raw(&self) -> &[u8] {
        match self {
            Lent::I8(v) => flat(v.as_ref()),
            Lent::U8(v) => v.as_ref(),
            Lent::I16(v) => flat(v.as_ref()),
            Lent::U16(v) => flat(v.as_ref()),
            Lent::I32(v) => flat(v.as_ref()),
            Lent::U32(v) => flat(v.as_ref()),
            Lent::I64(v) => flat(v.as_ref()),
            Lent::U64(v) => flat(v.as_ref()),
            Lent::F32(v) => flat(v.as_ref()),
            Lent::F64(v) => flat(v.as_ref()),
        }
    }

    /// Where its first element is.
    ///
    /// Never null: an array of no elements lends out the address an
    /// empty slice has, which is aligned and is not zero, and no row is
    /// ever read through it anyway.
    fn ptr(&self) -> NonNull<u8> {
        NonNull::new(self.raw().as_ptr() as *mut u8).expect("an empty slice is not at address zero")
    }

    /// What one element of it is, in the terms a layout is written in.
    fn elem(&self) -> Elem {
        let int = |bits, signed| Elem::Int {
            bits,
            signed,
            scale: 1,
        };
        match self {
            Lent::I8(_) => int(IntBits::B8, true),
            Lent::U8(_) => int(IntBits::B8, false),
            Lent::I16(_) => int(IntBits::B16, true),
            Lent::U16(_) => int(IntBits::B16, false),
            Lent::I32(_) => int(IntBits::B32, true),
            Lent::U32(_) => int(IntBits::B32, false),
            Lent::I64(_) => int(IntBits::B64, true),
            Lent::U64(_) => int(IntBits::B64, false),
            Lent::F32(_) => Elem::Float(FloatBits::B32),
            Lent::F64(_) => Elem::Float(FloatBits::B64),
        }
    }

    /// How many elements it holds.
    fn len(&self) -> usize {
        self.raw().len() / self.elem().width()
    }

    /// One offset of a string column's offset array, which is 32 bits
    /// wide in Arrow's `Utf8` and 64 in its `LargeUtf8`.
    fn offset(&self, at: usize) -> Option<i64> {
        match self {
            Lent::I32(v) => v.as_ref().get(at).map(|&n| i64::from(n)),
            Lent::I64(v) => v.as_ref().get(at).copied(),
            _ => None,
        }
    }
}

/// A slice of values as the bytes under them.
///
/// Whole elements either way, so the length is exact and the alignment
/// only ever loosens.
fn flat<T>(values: &[T]) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    }
}

/// One buffer this client built, because a JavaScript value is not a
/// column and something has to hold the bytes.
///
/// The variants are widths rather than types: what a run of eight-byte
/// words means is said by the logical type recorded beside it, and a
/// count of nanoseconds and a number are the same eight bytes. Each is a
/// vector of its own width so that the allocation is aligned for the
/// values that will be read out of it.
enum Bytes {
    Eight(Vec<u64>),
    Four(Vec<u32>),
    Two(Vec<u16>),
    One(Vec<u8>),
    /// The `rows + 1` offsets that cut a string column up, always 32
    /// bits wide: a buffer this module builds is one it also sized, and
    /// it refuses to build one past what a 32-bit offset reaches.
    Offsets(Vec<i32>),
}

impl Bytes {
    /// An empty buffer of the width `elem` reads through.
    fn empty(elem: &Elem) -> Bytes {
        match elem.width() {
            8 => Bytes::Eight(Vec::new()),
            4 => Bytes::Four(Vec::new()),
            2 => Bytes::Two(Vec::new()),
            _ => Bytes::One(Vec::new()),
        }
    }

    /// A buffer of the width `elem` reads through, with room for `rows`.
    fn with_room(elem: &Elem, rows: usize) -> Bytes {
        match elem.width() {
            8 => Bytes::Eight(Vec::with_capacity(rows)),
            4 => Bytes::Four(Vec::with_capacity(rows)),
            2 => Bytes::Two(Vec::with_capacity(rows)),
            _ => Bytes::One(Vec::with_capacity(rows)),
        }
    }

    /// Copies whole elements onto the end of it.
    ///
    /// The bytes go in as they lie, because what is being copied is a
    /// column of this machine's own memory into another buffer of it:
    /// what the words mean is the layout's business and does not change
    /// on the way.
    fn extend(&mut self, raw: &[u8]) {
        match self {
            Bytes::Eight(v) => v.extend(
                raw.chunks_exact(8)
                    .map(|word| u64::from_ne_bytes(word.try_into().expect("eight bytes"))),
            ),
            Bytes::Four(v) => v.extend(
                raw.chunks_exact(4)
                    .map(|word| u32::from_ne_bytes(word.try_into().expect("four bytes"))),
            ),
            Bytes::Two(v) => v.extend(
                raw.chunks_exact(2)
                    .map(|word| u16::from_ne_bytes(word.try_into().expect("two bytes"))),
            ),
            Bytes::One(v) => v.extend_from_slice(raw),
            Bytes::Offsets(_) => {}
        }
    }

    /// Where it starts.
    ///
    /// A vector that has never allocated lends out an aligned address
    /// rather than a real one, which is never zero and is never read,
    /// since a buffer with nothing in it belongs to a column with no
    /// rows.
    fn ptr(&self) -> NonNull<u8> {
        let ptr = match self {
            Bytes::Eight(v) => v.as_ptr().cast::<u8>(),
            Bytes::Four(v) => v.as_ptr().cast::<u8>(),
            Bytes::Two(v) => v.as_ptr().cast::<u8>(),
            Bytes::One(v) => v.as_ptr(),
            Bytes::Offsets(v) => v.as_ptr().cast::<u8>(),
        };
        NonNull::new(ptr as *mut u8).expect("a buffer of this process is never at address zero")
    }
}

/// What one value of a column is, in the terms the engine reads it in.
///
/// This is the layout and not the meaning: a date and a count of days
/// are the same `Int`, and the logical type beside it is what tells them
/// apart.
#[derive(Clone, Copy)]
enum Elem {
    Int {
        bits: IntBits,
        signed: bool,
        /// What one value is multiplied by to reach the unit its meaning
        /// counts in, which is where Arrow's microseconds meet this
        /// engine's nanoseconds. Nothing is converted here: the
        /// multiplication happens per scanned chunk, on the rows a
        /// statement actually reads.
        scale: i64,
    },
    Float(FloatBits),
    /// One bit a row, low bit of the first byte first.
    Bool,
    /// Characters end to end with offsets cutting them up.
    Str {
        /// Whether the offsets are 64 bits wide, which is Arrow's
        /// `LargeUtf8` against its `Utf8`.
        wide: bool,
    },
}

impl Elem {
    /// How many bytes one value takes, which for a boolean is the byte
    /// eight of them share.
    fn width(&self) -> usize {
        match self {
            Elem::Int { bits, .. } => bits.bits() as usize / 8,
            Elem::Float(bits) => bits.bits() as usize / 8,
            Elem::Bool => 1,
            Elem::Str { wide } => match wide {
                true => 8,
                false => 4,
            },
        }
    }
}

/// A frame as the engine is about to be told about it.
///
/// The columns hold raw pointers into what `held` keeps alive, which is
/// why the two travel together and why neither is any use without the
/// other.
pub struct Described {
    pub columns: Vec<Described_>,
    pub rows: u64,
    held: Arc<Held>,
}

// A pointer is not `Send`, because Rust cannot know what it addresses.
// These address buffers the `Arc` in the same struct keeps alive, and
// that `Arc` is `Send` and `Sync`, so a description travels wherever the
// thing it describes does. Nothing writes through them.
unsafe impl Send for Described {}

impl Described {
    /// Registers this as a table named `name` on `engine`.
    ///
    /// Every pointer in it addresses a buffer the `Arc` handed over with
    /// them keeps alive, which is what building one of these promises
    /// and what nothing between there and here undoes, so the `unsafe`
    /// that [`zudb::Frame::new`] asks for is discharged where the buffers
    /// were described rather than here.
    pub fn register(self, engine: &mut zudb::Connection, name: &str) -> zudb::Result<()> {
        let Described {
            columns,
            rows,
            held,
        } = self;
        let frame = unsafe { zudb::Frame::new(name, rows, columns, held) }?;
        engine.register(frame)
    }
}

/// Reads whatever the caller handed over into a description of it.
///
/// Two shapes, and both of them are shapes a JavaScript program already
/// has: an Arrow table, which is what every columnar library in this
/// ecosystem hands out, and an object of column name to values, whose
/// values are typed arrays where the caller has them and plain arrays
/// where they do not. Anything else is refused here rather than iterated
/// hopefully, because the message a caller wants is the list of what
/// would have worked.
///
/// Every failure comes back as the sentence to refuse the call with,
/// including a boundary failure, because a caller who cannot be given
/// the value they passed is being told the same thing either way.
pub fn read(env: &Env, data: Unknown<'_>) -> std::result::Result<Described, String> {
    inner(env, data).map_err(|err| err.reason)
}

fn inner(env: &Env, data: Unknown<'_>) -> Result<Described> {
    if data.get_type()? != ValueType::Object {
        return Err(refuse(env, &data));
    }
    let object = Object::from_unknown(data)?;
    if arrowish(&object)? {
        return from_arrow(env, &object);
    }
    if object.is_array()? || data.is_typedarray()? {
        return Err(refuse(env, &data));
    }
    from_object(env, &object)
}

fn refuse(env: &Env, data: &Unknown<'_>) -> Error {
    crate::error::usage(
        env,
        format!(
            "a frame is an Arrow table, which is what `apache-arrow` and everything built on it \
             hands out, or an object of column name to values, and this is {}",
            named(data)
        ),
    )
}

/// Whether this looks like an Arrow table or record batch.
///
/// Asked of the object rather than of a package this client would have
/// to depend on. What is being recognized is the shape every Arrow table
/// in this ecosystem has, a schema listing its fields and a call that
/// hands a column back by position, and recognizing it that way means a
/// caller's `apache-arrow` and this client's are never two copies of one
/// library disagreeing about `instanceof`.
fn arrowish(object: &Object<'_>) -> Result<bool> {
    let schema: Unknown<'_> = object.get_named_property("schema")?;
    if schema.get_type()? != ValueType::Object {
        return Ok(false);
    }
    let fields: Unknown<'_> = Object::from_unknown(schema)?.get_named_property("fields")?;
    if fields.get_type()? != ValueType::Object || !fields.is_array()? {
        return Ok(false);
    }
    let child: Unknown<'_> = object.get_named_property("getChildAt")?;
    Ok(child.get_type()? == ValueType::Function)
}

/// Reads an Arrow table where it lies.
///
/// A column is read off the vector the table hands back rather than off
/// the table's own insides, because a vector is the part of that library
/// that has stayed the same: the chunks it is made of, the buffers under
/// each chunk, and the type they are read through.
fn from_arrow(env: &Env, table: &Object<'_>) -> Result<Described> {
    let schema: Object<'_> = table.get_named_property("schema")?;
    let fields: Object<'_> = schema.get_named_property("fields")?;
    let width = fields.get_array_length()?;
    let child: Function<'_, u32, Unknown<'_>> = table.get_named_property("getChildAt")?;

    let mut held = Held::new();
    let mut columns = Vec::with_capacity(width as usize);
    let mut rows: Option<u64> = None;
    for at in 0..width {
        let field: Object<'_> = fields.get_element(at)?;
        let name: String = field.get_named_property("name")?;
        let vector: Unknown<'_> = child.apply(*table, at)?;
        if vector.get_type()? != ValueType::Object {
            return Err(crate::error::usage(
                env,
                format!("this table names a column '{name}' and then has no column there"),
            ));
        }
        let vector = Object::from_unknown(vector)?;
        let (ty, elem) = meaning(env, &name, &vector)?;
        let (rows_here, layout) = column(env, &name, elem, &vector, &mut held)?;
        match rows {
            Some(had) if had != rows_here => {
                return Err(crate::error::usage(
                    env,
                    format!(
                        "column '{name}' holds {rows_here} values and the column before it holds \
                         {had}, and a table is as wide as it is long"
                    ),
                ));
            }
            _ => rows = Some(rows_here),
        }
        columns.push(Described_ { name, ty, layout });
    }
    Ok(Described {
        columns,
        rows: rows.unwrap_or(0),
        held: Arc::new(held),
    })
}

/// What one Arrow column holds, and how wide its values are.
///
/// The type ids are Arrow's own and the numbers are part of its format
/// rather than of any one library, which is why they are matched on
/// here: a table that came over IPC and a table built in JavaScript
/// carry the same ones.
fn meaning(env: &Env, name: &str, vector: &Object<'_>) -> Result<(LogicalType, Elem)> {
    let ty: Object<'_> = vector.get_named_property("type")?;
    let id: i32 = ty.get_named_property("typeId")?;
    let printed: String = printed(&ty).unwrap_or_else(|| format!("type {id}"));
    let refused = |instead: &str| {
        crate::error::usage(env, format!("column '{name}' is {printed}, and {instead}"))
    };
    let unit = || -> Result<i64> { ty.get_named_property::<f64>("unit").map(|n| n as i64) };
    let counts = |bits, signed| LogicalType::Int {
        signed,
        bits,
        precision: None,
    };
    let characters = LogicalType::Str {
        min: None,
        max: None,
        fixed: false,
    };
    let word = |bits, scale, means| {
        (
            means,
            Elem::Int {
                bits,
                signed: true,
                scale,
            },
        )
    };
    Ok(match id {
        // Integers, whose width and signedness are on the type rather
        // than in the id.
        2 => {
            let width: f64 = ty.get_named_property("bitWidth")?;
            let signed: bool = ty.get_named_property("isSigned")?;
            let bits = match width as i64 {
                8 => IntBits::B8,
                16 => IntBits::B16,
                32 => IntBits::B32,
                64 => IntBits::B64,
                _ => {
                    return Err(refused(
                        "this engine reads integers of 8, 16, 32 and 64 bits",
                    ));
                }
            };
            (
                counts(bits, signed),
                Elem::Int {
                    bits,
                    signed,
                    scale: 1,
                },
            )
        }
        3 => {
            let precision: f64 = ty.get_named_property("precision")?;
            let bits = match precision as i64 {
                1 => FloatBits::B32,
                2 => FloatBits::B64,
                _ => return Err(refused("this engine reads 32 and 64 bit floats")),
            };
            (
                LogicalType::Float {
                    bits,
                    precision: None,
                },
                Elem::Float(bits),
            )
        }
        6 => (LogicalType::Bool, Elem::Bool),
        // The two string layouts that cut one buffer up with offsets.
        // A view column is Arrow's third and is not one of these: its
        // chunks are several buffers a row can point into, which this
        // client does not read yet.
        5 => (characters, Elem::Str { wide: false }),
        20 => (characters, Elem::Str { wide: true }),
        // A date is days when its unit is days and milliseconds when it
        // is not, and the second of those is eight bytes wide.
        8 => match unit()? {
            0 => word(IntBits::B32, 1, LogicalType::Date),
            _ => {
                return Err(refused(
                    "a date of this engine counts whole days, so cast it to Date32 or read it as \
                     a datetime",
                ));
            }
        },
        // A time, a datetime and a duration are all counts, and what
        // differs is the unit they count in and what the count means.
        9 => match unit()? {
            0 => word(IntBits::B32, 1_000_000_000, LogicalType::LocalTime),
            1 => word(IntBits::B32, 1_000_000, LogicalType::LocalTime),
            2 => word(IntBits::B64, 1_000, LogicalType::LocalTime),
            _ => word(IntBits::B64, 1, LogicalType::LocalTime),
        },
        10 => {
            let zone: Unknown<'_> = ty.get_named_property("timezone")?;
            if zone.get_type()? == ValueType::String {
                let zone = String::from_unknown(zone)?;
                return Err(refused(&format!(
                    "a column of this table has nowhere to keep '{zone}', so drop the zone once \
                     the values are in the zone you want them in, or write it as a string"
                )));
            }
            word(IntBits::B64, nanos(unit()?), LogicalType::LocalDatetime)
        }
        18 => word(
            IntBits::B64,
            nanos(unit()?),
            LogicalType::Duration(DurationKind::DayTime),
        ),
        11 => match unit()? {
            0 => word(
                IntBits::B32,
                1,
                LogicalType::Duration(DurationKind::YearMonth),
            ),
            _ => {
                return Err(refused(
                    "a duration of this engine is months or it is nanoseconds, so cast it to \
                     Interval<YEAR_MONTH> or to a Duration",
                ));
            }
        },
        -1 => {
            return Err(refused(
                "a dictionary is a layout rather than a type here, so cast it to what it holds \
                 first",
            ));
        }
        4 | 19 | 23 => {
            return Err(refused(
                "no statement can read a column of bytes back yet, so registering one would be \
                 naming data the caller cannot get at",
            ));
        }
        _ => {
            return Err(refused(
                "a column holds booleans, integers, floats, strings, dates, times, datetimes or \
                 durations",
            ));
        }
    })
}

/// What the Arrow type calls itself, for a message about a column this
/// client will not take.
fn printed(ty: &Object<'_>) -> Option<String> {
    let name: Function<'_, (), String> = ty.get_named_property("toString").ok()?;
    name.apply(*ty, ()).ok()
}

/// How many nanoseconds one count of an Arrow time unit is.
fn nanos(unit: i64) -> i64 {
    match unit {
        0 => 1_000_000_000,
        1 => 1_000_000,
        2 => 1_000,
        _ => 1,
    }
}

/// One Arrow column, as the layout the engine reads it through.
///
/// A vector is chunks, and a column of a table is one run of bytes, so a
/// vector of one chunk is described where it lies and a vector of
/// several is concatenated first. The common case is the first: a table
/// built in this process, or read from one batch, holds a column whole.
fn column(
    env: &Env,
    name: &str,
    elem: Elem,
    vector: &Object<'_>,
    held: &mut Held,
) -> Result<(u64, Layout)> {
    let chunks: Object<'_> = vector.get_named_property("data")?;
    let count = chunks.get_array_length()?;
    let mut pieces = Vec::with_capacity(count as usize);
    let mut row = 0usize;
    let nulls: f64 = vector.get_named_property("nullCount")?;
    for at in 0..count {
        let chunk: Object<'_> = chunks.get_element(at)?;
        // Named by the row that is empty rather than by how many are,
        // because the caller's next move is to go and look at that cell.
        if nulls != 0.0
            && let Some(empty) = hole(&chunk)?
        {
            return Err(crate::error::usage(
                env,
                format!(
                    "column '{name}' has no value at row {}, and every column of a row holds one",
                    row + empty
                ),
            ));
        }
        let piece = piece(env, name, &elem, &chunk)?;
        row += piece.rows;
        pieces.push(piece);
    }
    let rows: usize = pieces.iter().map(|piece| piece.rows).sum();
    Ok((rows as u64, laid(env, name, elem, pieces, rows, held)?))
}

/// Which row of this chunk holds nothing, when one does.
///
/// The validity bitmap is a bit a row, set where there is a value. A
/// chunk with none of them clear is a chunk whose bitmap is empty, which
/// is what a column with no nulls in it carries even when a sibling
/// chunk has some.
fn hole(chunk: &Object<'_>) -> Result<Option<usize>> {
    let Some(bitmap) = Lent::of(chunk.get_named_property("nullBitmap")?)? else {
        return Ok(None);
    };
    let raw = bitmap.raw();
    if raw.is_empty() {
        return Ok(None);
    }
    let rows: f64 = chunk.get_named_property("length")?;
    let at: f64 = chunk.get_named_property("offset")?;
    let at = at as usize;
    Ok((0..rows as usize).find(|row| {
        let bit = at + row;
        raw.get(bit / 8)
            .is_none_or(|byte| byte >> (bit % 8) & 1 == 0)
    }))
}

/// One chunk of one Arrow column.
///
/// A chunk of a sliced column is the awkward one, and arrow-js splits
/// the difference in a way worth writing down. Slicing narrows the
/// values buffer and the offsets buffer to the rows that were kept, so
/// those two already start at row zero of the chunk. It leaves the
/// validity bitmap and a boolean column's bits alone, because both count
/// in bits and a bit is not a place a typed array can start. So `offset`
/// stays on the chunk, and it means those two buffers and nothing else.
struct Piece {
    rows: usize,
    /// Which bit of the validity bitmap, and of a boolean column's data,
    /// this chunk's first row is.
    at: usize,
    values: Lent,
    offsets: Option<Lent>,
}

fn piece(env: &Env, name: &str, elem: &Elem, chunk: &Object<'_>) -> Result<Piece> {
    let missing = || {
        crate::error::usage(
            env,
            format!("column '{name}' is a shape this client cannot find the values of"),
        )
    };
    let rows: f64 = chunk.get_named_property("length")?;
    let at: f64 = chunk.get_named_property("offset")?;
    let values = Lent::of(chunk.get_named_property("values")?)?.ok_or_else(missing)?;
    let offsets = match elem {
        Elem::Str { .. } => {
            Some(Lent::of(chunk.get_named_property("valueOffsets")?)?.ok_or_else(missing)?)
        }
        _ => None,
    };
    Ok(Piece {
        rows: rows as usize,
        at: at as usize,
        values,
        offsets,
    })
}

/// Where a column's bytes are, once it is known whether they are the
/// caller's or this client's.
///
/// One chunk is described where it lies, which is the whole point of
/// registering a frame. Several are put together first, into a buffer of
/// this module's own, because a column of a table is one run of bytes
/// and three chunks are three of them.
fn laid(
    env: &Env,
    name: &str,
    elem: Elem,
    pieces: Vec<Piece>,
    rows: usize,
    held: &mut Held,
) -> Result<Layout> {
    if rows == 0 {
        // No row is ever read out of it, and what a layout still needs
        // is a pointer that is not null and is aligned for the width it
        // claims. An empty buffer of this module's own is both.
        return Ok(match elem {
            Elem::Str { .. } => Layout::Str {
                offsets: held.own(Bytes::Offsets(Vec::new())),
                wide: false,
                data: held.own(Bytes::One(Vec::new())),
                data_len: 0,
            },
            _ => plain(elem, held.own(Bytes::empty(&elem))),
        });
    }
    match elem {
        Elem::Str { wide } => strings(env, name, wide, pieces, rows, held),
        Elem::Bool => Ok(Layout::Bool {
            ptr: bits(pieces, rows, held),
        }),
        _ => Ok(plain(elem, words(elem, pieces, held))),
    }
}

/// The layout a fixed width column of this element is read through.
fn plain(elem: Elem, ptr: NonNull<u8>) -> Layout {
    match elem {
        Elem::Float(bits) => Layout::Float { ptr, bits },
        Elem::Int {
            bits,
            signed,
            scale,
        } => Layout::Int {
            ptr,
            bits,
            signed,
            scale,
        },
        // A boolean and a string are laid out by the two functions that
        // know their shapes, and neither of them comes through here.
        _ => Layout::Bool { ptr },
    }
}

/// Where a fixed width column's words are.
///
/// The values buffer of a chunk already starts at that chunk's first
/// row, sliced or not, so one chunk is lent exactly as it arrived.
fn words(elem: Elem, mut pieces: Vec<Piece>, held: &mut Held) -> NonNull<u8> {
    let width = elem.width();
    if pieces.len() == 1 {
        return held.lend(pieces.pop().expect("the one chunk").values);
    }
    let mut built = Bytes::with_room(&elem, pieces.iter().map(|piece| piece.rows).sum());
    for piece in &pieces {
        built.extend(&piece.values.raw()[..piece.rows * width]);
    }
    held.own(built)
}

/// Where a boolean column's bitmap is.
///
/// A chunk whose first row is a whole byte in is described where it
/// lies, because the engine reads a bitmap from a byte boundary. One
/// that starts partway through a byte, or a column of several chunks, is
/// rebuilt, which is a bit a row and happens once.
fn bits(mut pieces: Vec<Piece>, rows: usize, held: &mut Held) -> NonNull<u8> {
    if pieces.len() == 1 && pieces[0].at.is_multiple_of(8) {
        let one = pieces.pop().expect("the one chunk");
        let byte = one.at / 8;
        let ptr = held.lend(one.values);
        return unsafe { NonNull::new_unchecked(ptr.as_ptr().add(byte)) };
    }
    let mut built = vec![0u8; rows.div_ceil(8).max(1)];
    let mut row = 0usize;
    for piece in &pieces {
        let raw = piece.values.raw();
        for at in 0..piece.rows {
            let bit = piece.at + at;
            if raw[bit / 8] >> (bit % 8) & 1 == 1 {
                built[row / 8] |= 1 << (row % 8);
            }
            row += 1;
        }
    }
    held.own(Bytes::One(built))
}

/// Where a string column's characters and offsets are.
///
/// The characters are never copied. What may be is the offsets: the
/// engine reads a column whose first offset is zero, and a chunk that is
/// a slice of a longer array starts somewhere else, so the offsets are
/// rebased and the characters are pointed at from where that chunk's
/// first one begins. A column of several chunks is the one case where
/// the characters do move, because three runs of bytes are not one.
fn strings(
    env: &Env,
    name: &str,
    wide: bool,
    mut pieces: Vec<Piece>,
    rows: usize,
    held: &mut Held,
) -> Result<Layout> {
    let span = |piece: &Piece| -> Result<(usize, usize)> {
        let offsets = piece.offsets.as_ref().ok_or_else(|| {
            crate::error::usage(
                env,
                format!("column '{name}' holds strings and does not say where they are cut"),
            )
        })?;
        let at = |row: usize| {
            offsets.offset(row).ok_or_else(|| {
                crate::error::usage(
                    env,
                    format!("column '{name}' is cut by offsets this client cannot read"),
                )
            })
        };
        Ok((at(0)? as usize, at(piece.rows)? as usize))
    };
    if pieces.len() == 1 {
        let one = pieces.pop().expect("the one chunk");
        let (from, to) = span(&one)?;
        let Piece {
            values, offsets, ..
        } = one;
        let offsets = offsets.expect("a string column is cut by offsets");
        if from == 0 {
            let data = held.lend(values);
            return Ok(Layout::Str {
                offsets: held.lend(offsets),
                wide,
                data,
                data_len: to,
            });
        }
        // Rebased rather than copied down: the characters stay where
        // they are and what is rebuilt is the `rows + 1` numbers that
        // cut them up, which is four bytes a row against however many
        // characters a row holds. A sliced column is where this happens:
        // its offsets were kept whole and so still count from the row
        // the whole column started at.
        let mut rebased = Vec::with_capacity(rows + 1);
        for row in 0..=rows {
            let raw = offsets.offset(row).unwrap_or(0) as usize - from;
            rebased.push(narrow(env, name, raw)?);
        }
        let data = held.lend(values);
        return Ok(Layout::Str {
            offsets: held.own(Bytes::Offsets(rebased)),
            wide: false,
            data: unsafe { NonNull::new_unchecked(data.as_ptr().add(from)) },
            data_len: to - from,
        });
    }
    let mut data: Vec<u8> = Vec::new();
    let mut offsets: Vec<i32> = Vec::with_capacity(rows + 1);
    offsets.push(0);
    for piece in &pieces {
        let (from, to) = span(piece)?;
        let raw = piece.values.raw();
        let base = data.len();
        data.extend_from_slice(&raw[from..to]);
        let cuts = piece.offsets.as_ref().expect("the offsets");
        for row in 1..=piece.rows {
            let end = cuts.offset(row).unwrap_or(0) as usize - from + base;
            offsets.push(narrow(env, name, end)?);
        }
    }
    let data_len = data.len();
    // The characters first, so that a pointer taken from either one is
    // taken after everything that could have moved the vector has.
    let data = held.own(Bytes::One(data));
    Ok(Layout::Str {
        offsets: held.own(Bytes::Offsets(offsets)),
        wide: false,
        data,
        data_len,
    })
}

/// One offset of a rebuilt string column, which is 32 bits wide.
fn narrow(env: &Env, name: &str, offset: usize) -> Result<i32> {
    i32::try_from(offset).map_err(|_| {
        crate::error::usage(
            env,
            format!(
                "column '{name}' holds more than two gigabytes of characters once its chunks are \
                 put together, which is further than the offsets of a frame reach"
            ),
        )
    })
}

/// Reads an object of column name to values.
///
/// The shape a program with no frame library writes, and the shape one
/// with typed arrays writes too: a typed array is a column already and
/// is described where it lies, and a plain array is read into a buffer
/// of this module's own, because an array of JavaScript values is a
/// column of objects and a column of a table is a run of numbers.
fn from_object(env: &Env, object: &Object<'_>) -> Result<Described> {
    let mut held = Held::new();
    let mut columns = Vec::new();
    let mut rows: Option<u64> = None;
    for name in Object::keys(object)? {
        let value: Unknown<'_> = object.get_named_property(name.as_str())?;
        let (rows_here, ty, layout) = match Lent::of(value)? {
            Some(array) => {
                let elem = array.elem();
                let ty = match elem {
                    Elem::Float(bits) => LogicalType::Float {
                        bits,
                        precision: None,
                    },
                    Elem::Int { bits, signed, .. } => LogicalType::Int {
                        signed,
                        bits,
                        precision: None,
                    },
                    _ => unreachable!("a typed array is words or floats"),
                };
                let rows = array.len() as u64;
                match rows {
                    0 => (0, ty, plain(elem, held.own(Bytes::empty(&elem)))),
                    _ => (rows, ty, plain(elem, held.lend(array))),
                }
            }
            None => {
                let built = values(env, &name, value)?;
                let rows = built.len() as u64;
                let (ty, layout) = packed(env, &name, built, &mut held)?;
                (rows, ty, layout)
            }
        };
        match rows {
            Some(had) if had != rows_here => {
                return Err(crate::error::usage(
                    env,
                    format!(
                        "column '{name}' holds {rows_here} values and the column before it holds \
                         {had}, and a table is as wide as it is long"
                    ),
                ));
            }
            _ => rows = Some(rows_here),
        }
        columns.push(Described_ { name, ty, layout });
    }
    Ok(Described {
        columns,
        rows: rows.unwrap_or(0),
        held: Arc::new(held),
    })
}

/// One column, read out of an array of JavaScript values.
///
/// The first value settles what the column is and every value after it
/// has to agree, which is the loader's rule in the Python client and is
/// this client's appender's rule too. What it adds is the widening: a
/// column that started as whole numbers and meets a fractional one
/// becomes a column of floats, because `[1, 2, 2.5]` is a column of
/// numbers however it was written.
fn values(env: &Env, name: &str, value: Unknown<'_>) -> Result<buffer::Column> {
    if value.get_type()? != ValueType::Object || !value.is_array()? {
        return Err(crate::error::usage(
            env,
            format!(
                "column '{name}' is {}, and a column is an array of values or a typed array",
                named(&value)
            ),
        ));
    }
    let array = Object::from_unknown(value)?;
    let len = array.get_array_length()?;
    let mut column: Option<buffer::Column> = None;
    for row in 0..len {
        let value: Unknown<'_> = array.get_element(row)?;
        match column.as_mut() {
            Some(column) => column.widening_push(env, value).map_err(|why| match why {
                Mismatch::Wanted(holds) => crate::error::usage(
                    env,
                    format!(
                        "column '{name}' holds {holds} and row {row} is {}",
                        named(&value)
                    ),
                ),
                Mismatch::Says(reason) => crate::error::usage(
                    env,
                    format!("row {row} does not go in column '{name}': {reason}"),
                ),
                Mismatch::Boundary(err) => err,
            })?,
            None => {
                column = Some(
                    buffer::Column::start(env, value)
                        .map_err(|why| match why {
                            Mismatch::Boundary(err) => err,
                            Mismatch::Wanted(_) | Mismatch::Says(_) => unreachable!(
                                "a column that has not started has nothing to disagree with"
                            ),
                        })?
                        .ok_or_else(|| {
                            crate::error::usage(
                                env,
                                format!(
                                    "column '{name}' starts at row {row} with {}, and a column \
                                     holds booleans, integers, floats, strings, dates, times, \
                                     datetimes or durations",
                                    named(&value)
                                ),
                            )
                        })?,
                );
            }
        }
    }
    column.ok_or_else(|| {
        crate::error::usage(
            env,
            format!("column '{name}' is empty, and an empty column says nothing about what it would hold"),
        )
    })
}

/// One column of JavaScript values, as the bytes a frame reads and what
/// they mean.
fn packed(
    env: &Env,
    name: &str,
    column: buffer::Column,
    held: &mut Held,
) -> Result<(LogicalType, Layout)> {
    let counts = LogicalType::Int {
        signed: true,
        bits: IntBits::B64,
        precision: None,
    };
    let word = Elem::Int {
        bits: IntBits::B64,
        signed: true,
        scale: 1,
    };
    // The temporal buffers count in `i64` and the integer one holds the
    // bits of one in a `u64`, and both of them are the eight-byte lane
    // the engine reads through, so this cast is the identity on the
    // bytes and the logical type beside them is what says how to read
    // them.
    let same = |v: Vec<i64>| Bytes::Eight(v.into_iter().map(|n| n as u64).collect());
    Ok(match column {
        buffer::Column::Int(v) => (counts, plain(word, held.own(same(v)))),
        buffer::Column::Float(v) => {
            let bits = FloatBits::B64;
            (
                LogicalType::Float {
                    bits,
                    precision: None,
                },
                plain(
                    Elem::Float(bits),
                    held.own(Bytes::Eight(v.into_iter().map(f64::to_bits).collect())),
                ),
            )
        }
        buffer::Column::Bool(v) => {
            // At least one byte, so the pointer is an allocation and not
            // the address an empty vector lends out.
            let mut packed = vec![0u8; v.len().div_ceil(8).max(1)];
            for (row, &yes) in v.iter().enumerate() {
                if yes {
                    packed[row / 8] |= 1 << (row % 8);
                }
            }
            (
                LogicalType::Bool,
                Layout::Bool {
                    ptr: held.own(Bytes::One(packed)),
                },
            )
        }
        buffer::Column::Str(v) => {
            let mut data = Vec::with_capacity(v.iter().map(String::len).sum::<usize>().max(1));
            let mut offsets = Vec::with_capacity(v.len() + 1);
            offsets.push(0i32);
            for word in &v {
                data.extend_from_slice(word.as_bytes());
                offsets.push(narrow(env, name, data.len())?);
            }
            let data_len = data.len();
            let data = held.own(Bytes::One(data));
            (
                LogicalType::Str {
                    min: None,
                    max: None,
                    fixed: false,
                },
                Layout::Str {
                    offsets: held.own(Bytes::Offsets(offsets)),
                    wide: false,
                    data,
                    data_len,
                },
            )
        }
        buffer::Column::Bytes(_) => {
            return Err(crate::error::usage(
                env,
                format!(
                    "column '{name}' holds byte strings, and no statement can read a column of \
                     bytes back yet"
                ),
            ));
        }
        buffer::Column::Date(v) => (
            LogicalType::Date,
            plain(
                Elem::Int {
                    bits: IntBits::B32,
                    signed: true,
                    scale: 1,
                },
                held.own(Bytes::Four(v.into_iter().map(|n| n as u32).collect())),
            ),
        ),
        buffer::Column::LocalTime(v) => (LogicalType::LocalTime, plain(word, held.own(same(v)))),
        buffer::Column::LocalDatetime(v) => {
            (LogicalType::LocalDatetime, plain(word, held.own(same(v))))
        }
        buffer::Column::Duration(kind, v) => {
            (LogicalType::Duration(kind), plain(word, held.own(same(v))))
        }
    })
}
