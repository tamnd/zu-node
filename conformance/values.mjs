/* The {type, value} encoding a case writes its values in.
 *
 * Every value in the corpus is a mapping with a `type` naming the GQL
 * type and a `value` holding the payload. The type is written down
 * rather than inferred because the corpus is read by nine languages and
 * inference is where they differ: a bare 1 is an integer in YAML, and
 * which integer it becomes is a decision each host language makes on
 * its own.
 *
 * The payload is a YAML scalar where a YAML scalar is exact, and a
 * string where it is not. An integer wider than 53 bits is a string,
 * because most YAML readers hand a number to a double, and JavaScript
 * is the reader that makes the case for the rule: `1` in a `.yaml` file
 * read by any library on npm is a `number`, and a `number` stops naming
 * one integer at 2^53. A float is a string, for that reason and for
 * NaN, inf and -0.0. A temporal value is a string, because YAML has no
 * type that keeps an offset.
 *
 * NODE, EDGE and PATH are the values a graph has and a table does not.
 * A node is `person#1`, the table it is a row of and which row of it. An
 * edge is `knows#0->1`, its table and the two rows it runs between. A
 * path is a sequence, like a list, holding a node and then an edge and a
 * node for each hop.
 *
 * Refusing the wrong form is half the point, and refusing it here is
 * what makes this a second reader of the corpus rather than a consumer
 * of it.
 *
 * What a decoded value becomes is what this client hands back for the
 * same value, because that is what a comparison has to be against. So an
 * integer is a `bigint` whatever width the case declared: the declared
 * width is dropped in the process, which is a fact about this engine
 * rather than about the corpus, since its own value is one signed 64 bit
 * integer either way.
 *
 * One thing this client does not need and the Python one does. There, a
 * temporal written finer than a microsecond is a value the host language
 * cannot hold, and a case carrying one is reported unsupported rather
 * than run. Here a time is a `bigint` count of nanoseconds, which is the
 * same resolution the engine keeps, so every temporal in the corpus is a
 * value this client holds exactly.
 */

import { ZuDate, ZuDecimal, ZuDuration, ZuNode, ZuRel, ZuTime, ZuTimestamp } from 'zudb'

import { quote, refuse } from './reader.mjs'
import {
  parseDate,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseZonedDateTime,
  parseZonedTime,
  showClock,
  showDate,
  showMonths,
  showNanos,
  showOffset,
  showStamp,
  NANOS_PER_MINUTE,
} from './temporal.mjs'

/* A node as a case names it: the node table it is a row of and which
 * row.
 *
 * A shape of the corpus's own rather than `ZuNode`, for the reason
 * `EdgeAt` is not `ZuRel` and for one that is smaller here than it is in
 * the other runners: a `ZuNode` holds its fields behind getters on the
 * prototype, so two of them are never `===` and comparing a pair means
 * reading them out anyway.
 */
export class NodeAt {
  constructor(table, offset) {
    /* The node table's name. */
    this.table = table
    /* The row's number within that table, counted from zero in the
     * order the load wrote it.
     */
    this.offset = offset
  }
}

/* An edge as a case names it: the rel table it is in and the two rows it
 * runs between.
 *
 * Not `ZuRel`, which carries a fourth field the corpus does not write.
 * That field is `ord`, where the edge's properties sit, which is its
 * place in the order the table was loaded in, and that is a number the
 * loader chose rather than one the case did. A pair may run more than
 * once, and a case that has to tell two parallel edges apart asserts a
 * property of them instead.
 */
export class EdgeAt {
  constructor(table, src, dst) {
    /* The rel table's name. */
    this.table = table
    /* The row numbers the edge runs from and to, within the node table
     * the load names.
     */
    this.src = src
    this.dst = dst
  }
}

/* A path as a case writes it: nodes and edges alternating, a node at
 * each end.
 *
 * Not the `{ nodes, rels }` this client hands back, for the reason
 * `EdgeAt` is not `ZuRel`, and for one more: what a case compares is the
 * walk, and two walks that cross the same edges are the same walk
 * whichever copy of a parallel edge the engine happened to hand back.
 */
export class Walk {
  constructor(elements) {
    /* The walk in order, a `NodeAt` at each end and an `EdgeAt` between
     * every two of them.
     */
    this.elements = elements
  }
}

/* Whether a type's payload is written as a quoted string. False is a
 * type a YAML scalar carries without loss, true is one it does not.
 */
const QUOTED = new Map([
  ['NULL', false],
  ['BOOL', false],
  ['INT8', false],
  ['INT16', false],
  ['INT32', false],
  ['INT64', true],
  ['UINT8', false],
  ['UINT16', false],
  ['UINT32', false],
  ['UINT64', true],
  ['FLOAT32', true],
  ['FLOAT64', true],
  ['STRING', false],
  // A byte string is written in quotes because its hexits are digits as
  // often as not: a bare 0041 is a number with a leading zero in one
  // reader and the string it looks like in another, and neither of them
  // is the two octets the case meant.
  ['BYTES', true],
  ['DATE', true],
  ['LOCALTIME', true],
  ['ZONEDTIME', true],
  ['LOCALDATETIME', true],
  ['ZONEDDATETIME', true],
  ['DURATION', true],
  ['LIST', false],
  // A node and an edge are written in quotes because what a case spells
  // is a name and two numbers with punctuation between them, which is
  // text in every reader and a number in none.
  ['NODE', true],
  ['EDGE', true],
  // A path is a sequence, like a list, because that is what it is: the
  // nodes and edges of a walk, in the order they were walked.
  ['PATH', false],
])

/* The types the encoding reserves a name for and the engine has no
 * runtime value for yet, kept apart from an outright typo so that the
 * error says which of the two it is.
 */
const RESERVED = ['DECIMAL']

/* The range each integer width holds, so that a case writing a value its
 * own type cannot carry is refused rather than stored wider than it
 * says. UINT64 stops at the signed maximum because the engine's integer
 * is signed and 64 bits wide, and wrapping the top half into a negative
 * would be a case that passes while meaning the opposite of what it
 * says.
 */
const BOUNDS = new Map([
  ['INT8', [-128n, 127n]],
  ['INT16', [-32768n, 32767n]],
  ['INT32', [-2147483648n, 2147483647n]],
  ['INT64', [-9223372036854775808n, 9223372036854775807n]],
  ['UINT8', [0n, 255n]],
  ['UINT16', [0n, 65535n]],
  ['UINT32', [0n, 4294967295n]],
  ['UINT64', [0n, 9223372036854775807n]],
])

/* Whether a type is written quoted, and whether it is a type at all. */
export function form(type) {
  return { quoted: QUOTED.get(type) === true, known: QUOTED.has(type) }
}

/* Whether a type is one of the integer widths, which is what a load
 * column of them turns on.
 */
export function isInteger(type) {
  return BOUNDS.has(type)
}

function unknownType(type) {
  if (RESERVED.includes(type)) {
    return `${type} is a type the encoding reserves and the engine has no value for`
  }
  return `${type} is not a type this encoding knows`
}

/* The value a {type, value} mapping describes. */
export function decode(node) {
  if (!node.map()) {
    throw refuse(
      `line ${node.line}: a value is a mapping of \`type\` and \`value\`, and this is ${node.what()}`,
    )
  }
  const unknown = node.unknown('type', 'value')
  if (unknown.length > 0) {
    throw refuse(`line ${node.line}: a value has no key ${quote(unknown[0])}`)
  }
  return typed(node)
}

/* The type and value of a mapping that carries more than those two,
 * which is a parameter: it is a value with a name, and the name belongs
 * to the case rather than to the encoding.
 */
export function typed(node) {
  const at = node.line
  const typeNode = node.get('type')
  if (typeNode === null) throw refuse(`line ${at}: a value with no \`type\``)
  const type = typeNode.str()
  if (type === null) throw refuse(`line ${at}: a \`type\` that is not a name`)

  // Checked here as well as in `payload`, because a value whose type is
  // not a type and which also has no `value` under it should be told
  // about the type first: that is the mistake, and the missing payload
  // is a consequence of it.
  if (!form(type).known) throw refuse(`line ${at}: ${unknownType(type)}`)

  if (type === 'NULL') {
    if (node.get('value') !== null) throw refuse(`line ${at}: NULL carries no \`value\``)
    return null
  }
  const value = node.get('value')
  if (value === null) throw refuse(`line ${at}: a ${type} with no \`value\``)
  return payload(type, value)
}

/* The value a payload spells under a type that has already been read.
 *
 * A row of a case names its type beside every value. A column of a load
 * names it once at the top and every value under it is a bare payload,
 * which is the same encoding with the type factored out, so it is the
 * same function reading it.
 */
export function payload(type, value) {
  const { quoted, known } = form(type)
  if (!known) throw refuse(`line ${value.line}: ${unknownType(type)}`)

  if (type === 'LIST' || type === 'PATH') {
    // The empty list is a value worth a case and needs a spelling, which
    // is a `value:` with nothing under it.
    const items = value.seqOrEmpty()
    if (items === null) {
      throw refuse(
        `line ${value.line}: a ${type} holds a sequence of values, and this is ${value.what()}`,
      )
    }
    const decoded = items.map((item) => decode(item))
    return type === 'LIST' ? decoded : walk(decoded, value.line)
  }

  const spelled = value.scalar()
  if (spelled === null) {
    throw refuse(`line ${value.line}: a ${type} holds one scalar, and this is ${value.what()}`)
  }
  const { text, quoted: wasQuoted } = spelled
  const at = value.line
  // The one rule the whole encoding exists for, checked before the text
  // is looked at, because a value that parses is exactly the case where
  // a silent misread would survive review.
  if (quoted && !wasQuoted) {
    // A node and an edge are quoted for a different reason from the
    // numbers, so they are told a different reason. Both reasons are the
    // same rule: a payload is quoted where a bare one would read as
    // something else in some reader of this file.
    if (type === 'NODE' || type === 'EDGE') {
      throw refuse(
        `line ${at}: ${type} is written in quotes, because ${text} is a name and two numbers ` +
          'and no reader has a scalar for that',
      )
    }
    throw refuse(
      `line ${at}: ${type} is written in quotes, because a bare ${text} is a number and some ` +
        'reader of this file will round it',
    )
  }
  if (!quoted && wasQuoted && type !== 'STRING') {
    throw refuse(
      `line ${at}: ${type} is written without quotes, so that a reader cannot take it for a string`,
    )
  }

  let out
  if (type === 'NODE') out = nodeAt(text)
  else if (type === 'EDGE') out = edgeAt(text)
  else out = scalar(type, text)
  if (out === undefined) throw refuse(`line ${at}: ${quote(text)} is not a ${type}`)
  return out
}

/* The nodes and edges of a walk, or what is wrong with the sequence
 * somebody wrote.
 *
 * A path alternates and ends at both ends with a node, so a sequence
 * that does not is a case that could never pass. Refusing it here rather
 * than at the comparison is the difference between a message naming the
 * line and a report saying the row differs.
 */
function walk(items, at) {
  if (items.length % 2 === 0) {
    throw refuse(
      `line ${at}: a PATH is a node, then an edge and a node for each hop, so it holds an odd ` +
        `number of values and this holds ${items.length}`,
    )
  }
  for (let i = 0; i < items.length; i++) {
    const wantNode = i % 2 === 0
    let ok
    let was
    if (items[i] instanceof NodeAt) {
      ok = wantNode
      was = 'a NODE'
    } else if (items[i] instanceof EdgeAt) {
      ok = !wantNode
      was = 'an EDGE'
    } else {
      ok = false
      was = 'neither a NODE nor an EDGE'
    }
    if (!ok) {
      const wanted = wantNode ? 'a NODE' : 'an EDGE'
      throw refuse(
        `line ${at}: a PATH alternates, so value ${i + 1} is ${was} where it should be ${wanted}`,
      )
    }
  }
  return new Walk(items)
}

/* A node, written as its table and the offset of its row: person#1.
 *
 * Split from the right, so that a table whose name holds a `#` is still
 * readable.
 */
function nodeAt(text) {
  const hash = text.lastIndexOf('#')
  if (hash <= 0) return undefined
  const offset = text.slice(hash + 1)
  if (!digits(offset)) return undefined
  return new NodeAt(text.slice(0, hash), BigInt(offset))
}

/* An edge, written as its table and the rows it runs between:
 * knows#0->1.
 */
function edgeAt(text) {
  const hash = text.lastIndexOf('#')
  if (hash <= 0) return undefined
  const ends = text.slice(hash + 1)
  const arrow = ends.indexOf('->')
  if (arrow < 0) return undefined
  const src = ends.slice(0, arrow)
  const dst = ends.slice(arrow + 2)
  if (!digits(src) || !digits(dst)) return undefined
  return new EdgeAt(text.slice(0, hash), BigInt(src), BigInt(dst))
}

/* Whether text is one or more ASCII digits and nothing else, which is
 * what a row number in a node or an edge is. `BigInt` takes a leading
 * sign, a leading `0x` and whitespace around the whole of it, and none
 * of those is a row number anybody meant to write.
 */
function digits(text) {
  if (text === '') return false
  for (const c of text) if (c < '0' || c > '9') return false
  return true
}

/* The corpus's own shape for a value that came back from a statement.
 *
 * Everything a table holds is spelled the same on both sides and comes
 * through untouched. A graph value is not: an edge carries a field the
 * corpus does not write and a path arrives as two lists rather than as
 * the walk it is, so they are put into the shapes above before anything
 * is compared, which is what the Rust runner's `from_engine` does for
 * the same reason.
 */
export function cell(value) {
  if (value instanceof ZuNode) return new NodeAt(value.table, value.offset)
  if (value instanceof ZuRel) return new EdgeAt(value.table, value.src, value.dst)
  if (Array.isArray(value)) return value.map(cell)
  if (isPath(value)) {
    const elements = []
    for (let i = 0; i < value.nodes.length; i++) {
      if (i > 0) elements.push(cell(value.rels[i - 1]))
      elements.push(cell(value.nodes[i]))
    }
    return new Walk(elements)
  }
  if (isRecord(value)) {
    const out = {}
    for (const [name, item] of Object.entries(value)) out[name] = cell(item)
    return out
  }
  return value
}

/* Whether a value is the `{ nodes, rels }` this client hands a path back
 * as.
 *
 * Structural, because a path has no class here: it is two arrays kept
 * apart so that a caller asking about one of them does not have to write
 * the stride by hand. The test is tight enough that a record cannot pass
 * it by accident. A walk holds at least one node and one fewer edge than
 * it holds nodes, so a record with an empty `nodes` and an empty `rels`
 * in it is a record, and one holding anything but nodes and edges under
 * those names is too.
 */
function isPath(value) {
  if (value === null || typeof value !== 'object') return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('nodes') || !keys.includes('rels')) return false
  if (!Array.isArray(value.nodes) || !Array.isArray(value.rels)) return false
  if (value.nodes.length === 0 || value.rels.length !== value.nodes.length - 1) return false
  return (
    value.nodes.every((one) => one instanceof ZuNode) &&
    value.rels.every((one) => one instanceof ZuRel)
  )
}

/* Whether a value is a record, which is a plain object and not one of
 * the classes this client hands values back as.
 */
function isRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/* The value a type's text spells, and `undefined` for text that spells
 * none. Undefined rather than null, because null is the value NULL
 * spells and a decoder that used it for failure could not tell the two
 * apart.
 */
function scalar(type, text) {
  switch (type) {
    case 'BOOL':
      if (text === 'true') return true
      if (text === 'false') return false
      return undefined
    case 'STRING':
      return text
    case 'BYTES':
      return fromHexits(text)
    case 'FLOAT32':
    case 'FLOAT64': {
      const f = readFloat(text)
      if (f === undefined) return undefined
      return type === 'FLOAT32' ? Math.fround(f) : f
    }
    case 'DATE':
      return parseDate(text)
    case 'LOCALTIME':
      return parseLocalTime(text)
    case 'ZONEDTIME':
      return parseZonedTime(text)
    case 'LOCALDATETIME':
      return parseLocalDateTime(text)
    case 'ZONEDDATETIME':
      return parseZonedDateTime(text)
    case 'DURATION':
      return parseDuration(text)
  }
  const bound = BOUNDS.get(type)
  if (bound === undefined) return undefined
  let n
  try {
    n = BigInt(text)
  } catch {
    return undefined
  }
  // Written back out and compared, so that a leading plus, a leading
  // zero, an underscore between digits and a `0x` in front are all
  // refused rather than read as the number they resemble. `BigInt('')`
  // is zero, which this catches along with the rest.
  if (String(n) !== text) return undefined
  if (n < bound[0] || n > bound[1]) return undefined
  return n
}

/* A float, including the three spellings YAML has no opinion about.
 *
 * They are spelled the way Rust prints them, because that is what the
 * reference runner writes into a failure report and what a case is
 * pasted from.
 */
function readFloat(text) {
  if (text === 'NaN') return Number.NaN
  if (text === 'inf') return Number.POSITIVE_INFINITY
  if (text === '-inf') return Number.NEGATIVE_INFINITY
  // A float is exact here, so `1` is not a FLOAT64 and neither is
  // `1e400`. The first is an integer somebody meant to write as `1.0`
  // and the second is `inf` under another name.
  if (!/[.eE]/.test(text)) return undefined
  // `Number` takes `Infinity`, `0x10`, `1_0` and the empty string, none
  // of which the corpus writes and all of which would be a case that
  // reads differently in the other three runners.
  if (!/^[0-9.eE+-]+$/.test(text)) return undefined
  const f = Number(text)
  if (!Number.isFinite(f)) return undefined
  return f
}

/* Whether two values are the same value.
 *
 * Not `===`, for three reasons. A float: NaN is not equal to itself and
 * a case asserting NaN has to pass, and 0.0 equals -0.0 and a case
 * asserting -0.0 has to fail on 0.0, because the sign of zero is exactly
 * the sort of thing that survives one binding and not another. The
 * shapes that hold other values, which are compared by walking them. And
 * every temporal value, which is a class holding its count behind a
 * getter, so two of them are never `===` however equal they are.
 *
 * The type is part of the answer everywhere: a `bigint` is not the
 * `number` beside it, and a year-month duration is not the day-time one
 * that counts the same nothing.
 */
export function same(want, got) {
  if (typeof want === 'number') {
    if (typeof got !== 'number') return false
    if (Number.isNaN(want) && Number.isNaN(got)) return true
    return Object.is(want, got)
  }
  if (Array.isArray(want)) return Array.isArray(got) && sameAll(want, got)
  if (Array.isArray(got)) return false
  if (want instanceof Walk) return got instanceof Walk && sameAll(want.elements, got.elements)
  if (want instanceof NodeAt) {
    return got instanceof NodeAt && want.table === got.table && want.offset === got.offset
  }
  if (want instanceof EdgeAt) {
    return (
      got instanceof EdgeAt &&
      want.table === got.table &&
      want.src === got.src &&
      want.dst === got.dst
    )
  }
  if (want instanceof ZuDate) return got instanceof ZuDate && want.days === got.days
  if (want instanceof ZuTime) {
    return got instanceof ZuTime && want.nanos === got.nanos && sameOffset(want, got)
  }
  if (want instanceof ZuTimestamp) {
    return got instanceof ZuTimestamp && want.nanos === got.nanos && sameOffset(want, got)
  }
  if (want instanceof ZuDuration) {
    return (
      got instanceof ZuDuration &&
      want.kind === got.kind &&
      want.months === got.months &&
      want.nanos === got.nanos
    )
  }
  if (want instanceof ZuDecimal) {
    // The scale as well as the number. Two decimals of one number at
    // two scales are one value to the engine and print differently, and
    // what a case asserts is what a reader would see.
    return (
      got instanceof ZuDecimal && want.scale === got.scale && want.unscaled === got.unscaled
    )
  }
  if (want instanceof Uint8Array) {
    if (!(got instanceof Uint8Array) || want.length !== got.length) return false
    for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) return false
    return true
  }
  if (got instanceof Uint8Array) return false
  if (isRecord(want)) {
    if (!isRecord(got)) return false
    const names = Object.keys(want)
    if (names.length !== Object.keys(got).length) return false
    return names.every((name) => name in got && same(want[name], got[name]))
  }
  if (isRecord(got)) return false
  return want === got
}

/* Whether two temporal values carry the same offset.
 *
 * A local one has no offset and the class spells that absence as `null`.
 * `undefined` is taken for the same thing, because the constructor takes
 * either and a case comparing what it built against what the engine gave
 * back should not turn on which of the two words was used for nothing.
 */
function sameOffset(want, got) {
  return (want.offset ?? null) === (got.offset ?? null)
}

function sameAll(want, got) {
  return want.length === got.length && want.every((one, i) => same(one, got[i]))
}

/* How a value reads in a failure report, in the encoding's own spelling
 * so that it can be pasted into a case, and line for line what the Rust
 * runner prints so that two reports can be diffed.
 */
export function show(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'BOOL true' : 'BOOL false'
  if (typeof value === 'bigint') return `INT64 "${value}"`
  if (typeof value === 'number') return `FLOAT64 "${showFloat(value)}"`
  if (typeof value === 'string') return `STRING ${quote(value)}`
  if (value instanceof Uint8Array) return `BYTES "${hexits(value)}"`
  // A decimal is a value a statement can hand back today even though
  // DECIMAL is still a reserved name a case may not write, since CAST
  // reaches one and no case declares one. That makes this the got side
  // of a report and never the want side, and a report that could not
  // print what it got would be the least useful moment to find out.
  if (value instanceof ZuDecimal) return `DECIMAL "${value.toString()}"`
  if (value instanceof ZuDate) return `DATE "${showDate(value.days)}"`
  if (value instanceof ZuTime) {
    if ((value.offset ?? null) === null) return `LOCALTIME "${showClock(value.nanos)}"`
    return `ZONEDTIME "${showClock(value.nanos)}${showOffset(value.offset)}"`
  }
  if (value instanceof ZuTimestamp) {
    if ((value.offset ?? null) === null) return `LOCALDATETIME "${showStamp(value.nanos)}"`
    const wall = value.nanos + BigInt(value.offset) * NANOS_PER_MINUTE
    return `ZONEDDATETIME "${showStamp(wall)}${showOffset(value.offset)}"`
  }
  if (value instanceof ZuDuration) {
    if (value.kind === 'yearMonth') return `DURATION "${showMonths(value.months)}"`
    return `DURATION "${showNanos(value.nanos)}"`
  }
  if (Array.isArray(value)) return `LIST [${value.map(show).join(', ')}]`
  if (value instanceof Walk) return `PATH [${value.elements.map(show).join(', ')}]`
  if (value instanceof NodeAt) return `NODE "${value.table}#${value.offset}"`
  if (value instanceof EdgeAt) return `EDGE "${value.table}#${value.src}->${value.dst}"`
  if (isRecord(value)) {
    // Sorted, so that a report of one reads the same twice. A plain
    // object keeps the order its keys were added in, which is the order
    // the engine wrote them, and a failure that reorders its own fields
    // between an engine and a case is a failure nobody can diff.
    const fields = Object.keys(value)
      .sort()
      .map((name) => `${name}: ${show(value[name])}`)
    return `RECORD {${fields.join(', ')}}`
  }
  // A `ZuNode`, a `ZuRel` or a path reaching here is a value the runner
  // did not put through `cell`. It prints as itself, under a name that
  // is not a type, so that a report carrying one cannot be mistaken for
  // a case that could be pasted back into the corpus.
  const name = value?.constructor?.name ?? typeof value
  return `(${name}) ${JSON.stringify(value, (_, one) => (typeof one === 'bigint' ? `${one}` : one))}`
}

/* A float the way Rust's {:?} writes one, which is the shortest text
 * that reads back as the same double and always carries a point or an
 * exponent.
 *
 * Written out rather than taken from `toString`, which switches to an
 * exponent at a different place, writes the exponent with a sign, and
 * prints a whole number with no point at all. Each of those is a report
 * that differs from the reference one without the answer differing,
 * which is the thing this whole file exists to avoid.
 */
export function showFloat(f) {
  if (Number.isNaN(f)) return 'NaN'
  if (f === Number.POSITIVE_INFINITY) return 'inf'
  if (f === Number.NEGATIVE_INFINITY) return '-inf'
  const negative = Object.is(f, -0) || f < 0
  const sign = negative ? '-' : ''
  const g = negative ? -f : f
  // The shortest digits that read back as this double, and where the
  // point goes in them. `toExponential` with no argument is what says
  // shortest, and it always writes the digits and the exponent apart
  // whatever the size of the number.
  const spelled = g.toExponential()
  const at = spelled.indexOf('e')
  const run = spelled.slice(0, at).replace('.', '')
  const exp = Number(spelled.slice(at + 1))
  const point = exp + 1
  if (point <= -4 || point > 16) {
    const out = run.length > 1 ? `${run[0]}.${run.slice(1)}` : run
    return `${sign}${out}e${exp}`
  }
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${run}`
  if (point >= run.length) return `${sign}${run}${'0'.repeat(point - run.length)}.0`
  return `${sign}${run.slice(0, point)}.${run.slice(point)}`
}

/* A byte string the way the engine writes one: two hexits to a byte,
 * upper case, no quotes and no X.
 *
 * Upper case because the standard writes the literal that way, and a
 * reader comparing two of these is comparing text, so one case is one
 * answer.
 */
export function hexits(raw) {
  let out = ''
  for (const b of raw) out += b.toString(16).toUpperCase().padStart(2, '0')
  return out
}

/* The bytes a run of hexits names, and `undefined` for anything that is
 * not a run of hexits or that names half a byte.
 *
 * Space is allowed anywhere and dropped, which is what the standard's
 * production allows and what lets a long literal be written in groups.
 * Either case reads, because a value that went in as 00ab and came back
 * as 00AB is the same value.
 */
function fromHexits(text) {
  const nibbles = []
  for (const c of text) {
    if (' \t\n\r\v\f'.includes(c)) continue
    // `parseInt` with a radix of sixteen takes exactly the sixteen
    // hexits and nothing else, in either case, which is the whole of the
    // test here.
    const n = Number.parseInt(c, 16)
    if (Number.isNaN(n)) return undefined
    nibbles.push(n)
  }
  if (nibbles.length % 2 !== 0) return undefined
  const out = new Uint8Array(nibbles.length / 2)
  for (let i = 0; i < nibbles.length; i += 2) out[i / 2] = (nibbles[i] << 4) | nibbles[i + 1]
  return out
}
