/* What a result looks like on the way out through Arrow.
 *
 * A client that reads rows one at a time and a client that exports a
 * million of them to a dataframe are the same client, and only one of
 * those paths is covered by a case that asserts values. The other one
 * has its own contract: a column of dates is a Date32 and not a string
 * of digits, a year-month duration is a month-day-nano interval because
 * that is the interval every reader implements, a node is a struct of
 * the name of its table and the row it is, and a time with an offset is
 * refused rather than quietly moved to UTC. None of that shows up in a
 * row a case compares.
 *
 * So a case may say what the export gives as well as what the rows are,
 * and the runner checks both against one statement. What it checks is
 * the schema, field by field and into the nested types, and how many
 * rows came back through the stream. The schema is spelled in the C Data
 * Interface's own format strings, "l" for an int64 and "+s" for a
 * struct, because that is the one spelling every language sees the same.
 *
 * Where this file differs from the other runners is where the client
 * does. Go and Python are handed a C Data Interface stream and read the
 * format strings straight off it. This package hands out Arrow IPC
 * bytes, one buffer holding a schema message and then the batches, and
 * there is no pointer to read a format string from. So the schema
 * message is parsed here, out of the flatbuffer, and turned back into
 * the format strings the case is written in.
 *
 * That is a mapping rather than a reading, and a mapping is an opinion,
 * which is worth being uncomfortable about. It is written the way the C
 * Data Interface specification writes it, one arm per Arrow type and
 * nothing inferred, and it is short enough to read in full. The
 * alternative was to make `apache-arrow` a dependency of the corpus,
 * which pulls a tree into a checkout whose whole job is to have nothing
 * in it, and which does not hand out format strings either, so it would
 * have been the same mapping written against a second set of names.
 *
 * Values are not read back here. A consumer that decoded every array by
 * hand in each of nine languages would be nine new decoders under test,
 * which is more of our own code and not more of the contract; the rows
 * the case already asserts are the same values by another road.
 */

import { quote, refuse } from './reader.mjs'

/* How a report names the whole result, which is the place the columns of
 * an export are in.
 */
export const THE_RESULT = 'the result'

/* The stream saying no, with what it said. It is a type of its own so
 * that a refusal on the way out is told apart from a schema that does
 * not match, which is what a case writing `refused` turns on.
 */
export class ArrowError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArrowError'
  }
}

/* Reads the `arrow:` of a case.
 *
 * A field is a name, the format string, and the fields under it when it
 * is a struct or a list. A list has exactly one field under it, which
 * Arrow names "item", and a case writes that out rather than leaving it
 * implied: a client that named it "element" would export something no
 * reader lines up with what another client wrote.
 */
export function parseExport(node) {
  const text = node.str()
  if (text !== null) {
    if (text === 'refused') return { refused: true, fields: [] }
    throw refuse(
      `line ${node.line}: \`arrow:\` is the columns the export gives, or \`refused\` for a result ` +
        `Arrow has no type for, and this is ${quote(text)}`,
    )
  }
  return { refused: false, fields: exportFields(node) }
}

function exportFields(node) {
  const items = node.seq()
  if (items === null) {
    throw refuse(`line ${node.line}: \`arrow:\` is a sequence of fields, and this is ${node.what()}`)
  }
  return items.map((item) => exportField(item))
}

function exportField(node) {
  const at = node.line
  if (!node.map()) {
    throw refuse(
      `line ${at}: an Arrow field is a mapping of \`name\` and \`format\`, and this is ${node.what()}`,
    )
  }
  const unknown = node.unknown('name', 'format', 'children')
  if (unknown.length > 0) throw refuse(`line ${at}: an Arrow field has no key ${quote(unknown[0])}`)
  const text = (key) => {
    const value = node.get(key)
    const spelled = value === null ? null : value.str()
    if (spelled === null) throw refuse(`line ${at}: an Arrow field has a \`${key}:\``)
    return spelled
  }
  const name = text('name')
  const format = text('format')
  if (format === '') throw refuse(`line ${at}: an empty format string is not a type Arrow has`)
  const under = node.get('children')
  const children = under === null ? [] : exportFields(under)
  // A nested format is the one thing about a format string this reader
  // knows, and it is worth knowing here: a case that wrote the fields of
  // a struct under a "u" would be asserting something the export cannot
  // produce, and finding that out at load time says so with a line
  // number rather than as a failure in a report.
  const nested = format[0] === '+'
  if (nested && children.length === 0) {
    throw refuse(
      `line ${at}: ${quote(format)} is a nested type and the fields under it are part of it`,
    )
  }
  if (!nested && children.length > 0) {
    throw refuse(`line ${at}: ${quote(format)} holds no fields, so nothing goes under it`)
  }
  return { name, format, children }
}

/* The columns a result gives through Arrow, how many rows its batches
 * hold, and how many rows it says it holds.
 *
 * The last two are separate on purpose. The buffer carries a row count
 * beside the bytes, and the bytes carry their own in the batches, and a
 * client where those two disagree has a bug that no case asserting
 * values would ever see.
 */
export function exported(arrow) {
  const bytes = arrow.ipc
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let fields = null
  let rows = 0
  for (const message of messages(view)) {
    const kind = message.header.uint8(HEADER_TYPE, MESSAGE_NONE)
    const header = message.header.table(HEADER)
    if (header === null) continue
    if (kind === MESSAGE_SCHEMA) {
      if (fields !== null) throw new ArrowError('the stream carries two schemas')
      fields = schemaFields(header)
      continue
    }
    if (kind === MESSAGE_RECORD_BATCH) {
      if (fields === null) throw new ArrowError('a batch arrived before the schema')
      rows += Number(header.int64(BATCH_LENGTH, 0n))
    }
    // A dictionary batch is skipped rather than refused. Nothing this
    // engine exports is dictionary encoded today, and a runner that fell
    // over on one would be asserting that, which is not the contract.
  }
  if (fields === null) throw new ArrowError('the stream carries no schema')
  return { fields, rows, declared: arrow.rows }
}

/* What the export gave that the case did not want, or the empty string
 * when the two agree.
 *
 * The comparison walks the schema and the case's fields together and
 * stops at the first difference, for the reason the row comparison does:
 * the first is nearly always the cause of the rest.
 */
export function schemaSays(got, want) {
  return fieldsUnder('', got, want)
}

/* The fields under one place, where the place is the dotted path of the
 * field they are under and the empty one is the result itself.
 */
function fieldsUnder(prefix, got, want) {
  const place = prefix === '' ? THE_RESULT : quote(prefix)
  if (got.length !== want.length) {
    return `arrow gives ${got.length} fields in ${place} where the case wants ${want.length}`
  }
  for (let i = 0; i < got.length; i++) {
    if (got[i].name !== want[i].name) {
      return (
        `arrow field ${i + 1} in ${place} is named ${quote(got[i].name)} where the case wants ` +
        quote(want[i].name)
      )
    }
    // The path is the case's own names joined with dots, which is how a
    // field inside a path inside a column is pointed at without printing
    // the whole schema at somebody.
    const path = prefix === '' ? want[i].name : `${prefix}.${want[i].name}`
    if (got[i].format !== want[i].format) {
      return (
        `arrow field ${quote(path)} is ${quote(got[i].format)} where the case wants ` +
        quote(want[i].format)
      )
    }
    const why = fieldsUnder(path, got[i].children, want[i].children)
    if (why !== '') return why
  }
  return ''
}

/* The IPC framing.
 *
 * A message is a continuation marker, the length of its metadata, the
 * metadata itself, and then a body of the length the metadata declares.
 * The stream ends at a length of zero or at the end of the buffer, and a
 * writer old enough to predate the marker leaves it out, which is why
 * the length is looked at before it is trusted.
 */
function* messages(view) {
  let at = 0
  while (at + 4 <= view.byteLength) {
    let length = view.getInt32(at, true)
    at += 4
    if (length === CONTINUATION) {
      if (at + 4 > view.byteLength) return
      length = view.getInt32(at, true)
      at += 4
    }
    if (length <= 0) return
    if (at + length > view.byteLength) {
      throw new ArrowError(`a message declares ${length} bytes of metadata past the end of the stream`)
    }
    const header = root(view, at)
    at += length
    const body = Number(header.int64(BODY_LENGTH, 0n))
    if (body < 0 || at + body > view.byteLength) {
      throw new ArrowError(`a message declares a body of ${body} bytes past the end of the stream`)
    }
    yield { header }
    // A body is padded out to eight, and the padding is not counted in
    // the length the message declares.
    at += body + ((8 - (body % 8)) % 8)
  }
}

const CONTINUATION = -1

// Message
const HEADER_TYPE = 1
const HEADER = 2
const BODY_LENGTH = 3

// MessageHeader
const MESSAGE_NONE = 0
const MESSAGE_SCHEMA = 1
const MESSAGE_RECORD_BATCH = 3

// Schema
const SCHEMA_FIELDS = 1

// RecordBatch
const BATCH_LENGTH = 0

// Field
const FIELD_NAME = 0
const FIELD_TYPE_TYPE = 2
const FIELD_TYPE = 3
const FIELD_CHILDREN = 5

function schemaFields(schema) {
  const out = []
  const count = schema.vectorLength(SCHEMA_FIELDS)
  for (let i = 0; i < count; i++) out.push(walked(schema.element(SCHEMA_FIELDS, i)))
  return out
}

/* One field of an exported schema, and everything under it. */
function walked(field) {
  const children = []
  const count = field.vectorLength(FIELD_CHILDREN)
  for (let i = 0; i < count; i++) children.push(walked(field.element(FIELD_CHILDREN, i)))
  return { name: field.string(FIELD_NAME) ?? '', format: formatOf(field), children }
}

/* The Type union, in the order the schema flatbuffer numbers it. */
const NULL = 1
const INT = 2
const FLOATING_POINT = 3
const BINARY = 4
const UTF8 = 5
const BOOL = 6
const DECIMAL = 7
const DATE = 8
const TIME = 9
const TIMESTAMP = 10
const INTERVAL = 11
const LIST = 12
const STRUCT = 13
const FIXED_SIZE_BINARY = 15
const FIXED_SIZE_LIST = 16
const MAP = 17
const DURATION = 18
const LARGE_BINARY = 19
const LARGE_UTF8 = 20
const LARGE_LIST = 21

/* The format string for a field's type, spelled the way the C Data
 * Interface spells it.
 *
 * One arm per Arrow type and nothing inferred. A type this does not know
 * is a refusal naming the number, because a schema this file cannot read
 * is a report that would otherwise say the export was wrong when what
 * happened is that the runner did not keep up.
 */
function formatOf(field) {
  const which = field.uint8(FIELD_TYPE_TYPE, 0)
  const type = field.table(FIELD_TYPE)
  const say = (message) => new ArrowError(`${message} in field ${quote(field.string(FIELD_NAME) ?? '')}`)
  switch (which) {
    case NULL:
      return 'n'
    case BOOL:
      return 'b'
    case BINARY:
      return 'z'
    case LARGE_BINARY:
      return 'Z'
    case UTF8:
      return 'u'
    case LARGE_UTF8:
      return 'U'
    case STRUCT:
      return '+s'
    case LIST:
      return '+l'
    case LARGE_LIST:
      return '+L'
    case MAP:
      return '+m'
    case INT: {
      const width = type === null ? 0 : type.int32(0, 0)
      // Unsigned is the default in the schema, and a flatbuffer leaves
      // out a field that holds its default, so an absent `is_signed` is
      // an unsigned integer and not a missing answer. Defaulting the
      // other way reads every UINT64 as an INT64 and reports `l` for a
      // field the case wrote `L`.
      const signed = type === null ? false : type.bool(1, false)
      const spelled = { 8: 'c', 16: 's', 32: 'i', 64: 'l' }[width]
      if (spelled === undefined) throw say(`an integer of ${width} bits`)
      return signed ? spelled : spelled.toUpperCase()
    }
    case FLOATING_POINT: {
      // Half is the default, and an export of a half float leaves the
      // field out rather than writing a zero into it.
      const precision = type === null ? 0 : type.int16(0, 0)
      const spelled = ['e', 'f', 'g'][precision]
      if (spelled === undefined) throw say(`a float of precision ${precision}`)
      return spelled
    }
    case DECIMAL: {
      const scale = type === null ? 0 : type.int32(1, 0)
      const precision = type === null ? 0 : type.int32(0, 0)
      const bits = type === null ? 128 : type.int32(2, 128)
      return bits === 128 ? `d:${precision},${scale}` : `d:${precision},${scale},${bits}`
    }
    case DATE: {
      const unit = type === null ? 1 : type.int16(0, 1)
      if (unit === 0) return 'tdD'
      if (unit === 1) return 'tdm'
      throw say(`a date in unit ${unit}`)
    }
    case TIME: {
      // Milliseconds here, unlike a timestamp, which the schema gives no
      // default at all and so defaults to seconds.
      const unit = type === null ? 1 : type.int16(0, 1)
      const spelled = ['tts', 'ttm', 'ttu', 'ttn'][unit]
      if (spelled === undefined) throw say(`a time in unit ${unit}`)
      return spelled
    }
    case TIMESTAMP: {
      const unit = type === null ? 0 : type.int16(0, 0)
      const spelled = ['tss', 'tsm', 'tsu', 'tsn'][unit]
      if (spelled === undefined) throw say(`a timestamp in unit ${unit}`)
      // The zone is part of the type rather than beside it, and an
      // absent one is a timestamp with no zone rather than one in UTC.
      return `${spelled}:${type === null ? '' : (type.string(1) ?? '')}`
    }
    case DURATION: {
      // Milliseconds, the way a time is and a timestamp is not.
      const unit = type === null ? 1 : type.int16(0, 1)
      const spelled = ['tDs', 'tDm', 'tDu', 'tDn'][unit]
      if (spelled === undefined) throw say(`a duration in unit ${unit}`)
      return spelled
    }
    case INTERVAL: {
      const unit = type === null ? 0 : type.int16(0, 0)
      const spelled = ['tiM', 'tiD', 'tin'][unit]
      if (spelled === undefined) throw say(`an interval in unit ${unit}`)
      return spelled
    }
    case FIXED_SIZE_BINARY:
      return `w:${type === null ? 0 : type.int32(0, 0)}`
    case FIXED_SIZE_LIST:
      return `+w:${type === null ? 0 : type.int32(0, 0)}`
    default:
      throw say(`arrow type ${which}`)
  }
}

/* Enough of a flatbuffer reader to walk a schema message.
 *
 * A table is a signed offset back to its vtable and then its fields. The
 * vtable is its own size, the table's size, and then one unsigned short
 * per field holding where that field is inside the table, where a zero
 * or a slot past the end of the vtable means the field is not there and
 * the default stands. Everything is little endian, an offset to another
 * object is unsigned and relative to where the offset itself is, a
 * string is a length and then its bytes, and a vector is a length and
 * then its elements.
 *
 * That is the whole format. It is here rather than generated because
 * generated flatbuffer code for the Arrow schema is several thousand
 * lines to read four numbers out of a header, and because a corpus
 * checkout should pull nothing.
 */
class Table {
  constructor(view, at) {
    this.view = view
    this.at = at
    this.vtable = at - view.getInt32(at, true)
  }

  /* Where a field is inside the table, or zero when it is not there. */
  slot(index) {
    const size = this.view.getUint16(this.vtable, true)
    const at = 4 + index * 2
    if (at >= size) return 0
    return this.view.getUint16(this.vtable + at, true)
  }

  uint8(index, fallback) {
    const at = this.slot(index)
    return at === 0 ? fallback : this.view.getUint8(this.at + at)
  }

  bool(index, fallback) {
    const at = this.slot(index)
    return at === 0 ? fallback : this.view.getUint8(this.at + at) !== 0
  }

  int16(index, fallback) {
    const at = this.slot(index)
    return at === 0 ? fallback : this.view.getInt16(this.at + at, true)
  }

  int32(index, fallback) {
    const at = this.slot(index)
    return at === 0 ? fallback : this.view.getInt32(this.at + at, true)
  }

  int64(index, fallback) {
    const at = this.slot(index)
    return at === 0 ? fallback : this.view.getBigInt64(this.at + at, true)
  }

  /* Another table, at the far end of an offset. */
  table(index) {
    const at = this.slot(index)
    if (at === 0) return null
    const from = this.at + at
    return new Table(this.view, from + this.view.getUint32(from, true))
  }

  string(index) {
    const at = this.slot(index)
    if (at === 0) return null
    let from = this.at + at
    from += this.view.getUint32(from, true)
    const length = this.view.getUint32(from, true)
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + from + 4,
      length,
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  vectorLength(index) {
    const at = this.slot(index)
    if (at === 0) return 0
    const from = this.at + at
    return this.view.getUint32(from + this.view.getUint32(from, true), true)
  }

  /* One element of a vector of tables. */
  element(index, i) {
    const at = this.slot(index)
    const from = this.at + at
    const start = from + this.view.getUint32(from, true) + 4 + i * 4
    return new Table(this.view, start + this.view.getUint32(start, true))
  }
}

/* The table a buffer opens with, which is where the root offset points. */
function root(view, at) {
  return new Table(view, at + view.getUint32(at, true))
}
