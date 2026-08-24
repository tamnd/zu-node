/* The subset of YAML the corpus is written in.
 *
 * YAML is a large language and the corpus needs a small corner of it:
 * block mappings, block sequences, and scalars. Everything else is
 * refused with a line number. The files are hand written and are read
 * by people in nine repositories who did not write them, so a construct
 * a reader quietly reinterpreted would be a case that says one thing to
 * a reviewer and another to the runner.
 *
 * So: two space indentation and no tabs, `- ` with exactly one space,
 * plain, single quoted and double quoted scalars on one line, and
 * comments. No flow collections, no block scalars, no anchors, no
 * aliases, no tags, no document markers, no multi document streams.
 *
 * This is the fifth implementation of that subset, after
 * crates/zu-corpus/src/yaml.rs in the engine, conformance/c/yaml.c
 * beside it, conformance/reader.py in zu-python and corpus/reader.go in
 * zu-go. There is a YAML package on npm that would read these files,
 * and would read a good deal more besides: it would take a flow
 * sequence, a block scalar and an anchor, none of which a case may use.
 * What the corpus needs is a reader that refuses, and the cheapest way
 * to have one is to write it.
 *
 * Whether a scalar was quoted survives parsing, because the value
 * encoding turns on it. An INT64 written bare is a number some reader
 * in some language will round, and refusing it is the whole point of
 * the encoding.
 */

/* A file the corpus will not read, with the line it gave up on.
 *
 * A class of its own rather than a plain `Error` so that the command
 * can tell a corpus it cannot read from a case that did not pass, which
 * are two different exits.
 */
export class CorpusError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CorpusError'
  }
}

/* Every refusal in this file and the three beside it.
 *
 * The message is the whole of it: a reader that also carried a stack
 * would be printing the shape of this package at somebody trying to fix
 * a case.
 */
export function refuse(message) {
  return new CorpusError(message)
}

/* A string the way Rust's `{:?}` writes one.
 *
 * Every refusal in the corpus is written in five languages and diffed
 * across them, so a value quoted one way here and another way there
 * would be a difference in the report that is not a difference in the
 * answer. `JSON.stringify` escapes every code point it thinks is
 * unprintable and Rust does not, so the quoting is written out rather
 * than borrowed.
 */
export function quote(text) {
  let out = '"'
  for (const c of text) {
    if (c === '"' || c === '\\') out += '\\' + c
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return out + '"'
}

/* The four shapes a node is.
 *
 * `empty` is a key with nothing under it: it is a node rather than an
 * error because a case that expects no rows back writes `rows:` and
 * stops, and that is a real expectation which needs a spelling. Every
 * accessor says no to it, so a `name:` left blank is still caught by
 * whoever wanted a name.
 */
export const SCALAR = 'scalar'
export const SEQ = 'seq'
export const MAP = 'map'
export const EMPTY = 'empty'

/* One node of a document, with the line it started on. */
export class Node {
  constructor(kind, line, { text = '', quoted = false, items = [], pairs = [] } = {}) {
    this.kind = kind
    this.line = line
    this.text = text
    this.quoted = quoted
    this.items = items
    this.pairs = pairs
  }

  /* What kind of node this is, for an error that has to say what it
   * found instead of what it wanted.
   */
  what() {
    if (this.kind === SCALAR) return 'a scalar'
    if (this.kind === SEQ) return 'a sequence'
    if (this.kind === MAP) return 'a mapping'
    return 'nothing'
  }

  /* The text of a scalar and whether it was written in quotes, or null
   * for anything that is not a scalar.
   */
  scalar() {
    if (this.kind !== SCALAR) return null
    return { text: this.text, quoted: this.quoted }
  }

  /* The text of a scalar, for a caller the quoting does not concern,
   * and null for anything else.
   */
  str() {
    return this.kind === SCALAR ? this.text : null
  }

  /* The items of a sequence, or null. */
  seq() {
    return this.kind === SEQ ? this.items : null
  }

  /* A sequence, counting a key with nothing under it as the empty one.
   *
   * Only a caller for whom empty is a meaningful answer should reach
   * for this. The rest want `seq`, so that a list somebody left
   * unfinished is refused rather than read as none.
   */
  seqOrEmpty() {
    if (this.kind === EMPTY) return []
    return this.seq()
  }

  /* The entries of a mapping, in the order they were written. */
  map() {
    return this.kind === MAP ? this.pairs : null
  }

  /* The value under one key, or null when this is not a mapping or the
   * key is not in it.
   */
  get(key) {
    if (this.kind !== MAP) return null
    for (const pair of this.pairs) if (pair.key === key) return pair.value
    return null
  }

  /* The keys that are not in `known`, so a caller can refuse a typo
   * rather than drop the field on the floor.
   */
  unknown(...known) {
    if (this.kind !== MAP) return []
    return this.pairs.filter((p) => !known.includes(p.key)).map((p) => p.key)
  }
}

/* A document, or the first thing in it this reader will not read. */
export function parse(text) {
  const lines = lex(text)
  if (lines.length === 0) throw refuse('the file has nothing in it')
  if (lines[0].indent !== 0) throw refuse(`line ${lines[0].no}: the first line is indented`)
  const at = { lines, i: 0 }
  const node = parseNode(at, 0)
  if (at.i < lines.length) {
    throw refuse(`line ${lines[at.i].no}: this belongs to nothing above it`)
  }
  return node
}

/* Lines, with blanks and comments dropped and every `- ` split into the
 * item it opens and the content that followed it on the same line.
 *
 * Splitting here rather than in the parser is what lets `- name: x` and
 * a `name: x` on its own line be the same shape by the time anything
 * looks at them.
 */
function lex(text) {
  const out = []
  const raws = text.split('\n')
  for (let n = 0; n < raws.length; n++) {
    const raw = raws[n]
    const no = n + 1
    const tab = raw.indexOf('\t')
    if (tab >= 0) {
      throw refuse(`line ${no}: a tab at column ${tab + 1}, and indentation here is spaces`)
    }
    const content = trimRight(stripComment(raw))
    const rest0 = content.replace(/^ +/, '')
    const indent = content.length - rest0.length
    if (rest0 === '') continue
    if (rest0 === '---' || rest0 === '...') {
      throw refuse(
        `line ${no}: ${quote(rest0)} opens or closes a document, and a file here holds one`,
      )
    }
    if (indent % 2 !== 0) {
      throw refuse(
        `line ${no}: indented ${indent}, and indentation here goes two spaces at a time`,
      )
    }

    if (rest0 !== '-' && !rest0.startsWith('- ')) {
      out.push({ indent, dash: false, text: rest0, no })
      continue
    }
    let rest = rest0.slice(1)
    if (rest.startsWith('  ')) {
      throw refuse(
        `line ${no}: a \`- \` takes exactly one space, so that what follows it lines up with ` +
          'the lines under it',
      )
    }
    rest = rest.replace(/^ +/, '')
    if (rest.startsWith('- ')) {
      throw refuse(
        `line ${no}: a sequence opening straight into another one, which nothing here needs`,
      )
    }
    out.push({ indent, dash: true, text: '', no })
    if (rest !== '') out.push({ indent: indent + 2, dash: false, text: rest, no })
  }
  return out
}

/* The trailing whitespace YAML ignores, which is not the set
 * `String.trimEnd` takes off: a non-breaking space is whitespace to
 * JavaScript and is content here.
 */
function trimRight(text) {
  let end = text.length
  while (end > 0 && ' \r\v\f'.includes(text[end - 1])) end--
  return text.slice(0, end)
}

/* Everything from an unquoted ` #` on, dropped.
 *
 * Three rules keep this from eating content. A `#` starts a comment
 * only with whitespace before it, because one inside a word is part of
 * the word. A quote opens a quoted run only with whitespace before it,
 * because a quote inside a word is part of the word too, which is what
 * lets a `doc:` say "it's" without opening a run that never closes. And
 * a quote that opens nothing that closes was not a run at all, which is
 * what lets a `query:` hold `cast('  42  ' AS INT64)`.
 */
function stripComment(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const opens = i === 0 || space(text[i - 1])
    if (c === '#' && opens) return text.slice(0, i)
    if ((c === '"' || c === "'") && opens) {
      const end = closingQuote(text.slice(i + 1), c)
      if (end >= 0) i += 1 + end
    }
  }
  return text
}

/* Whether a character is one of the ones that can stand before a
 * comment or a quote.
 */
function space(c) {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\v' || c === '\f'
}

/* The offset of the quote that closes a run whose opening quote has
 * already been passed, and -1 when the line ends first.
 *
 * The two styles hide a quote differently: a double quoted run escapes
 * with a backslash, and a single quoted run doubles the quote, which is
 * the only escape it has.
 */
function closingQuote(rest, mark) {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\' && mark === '"') {
      i++
      continue
    }
    if (rest[i] === mark) {
      if (mark === "'" && i + 1 < rest.length && rest[i + 1] === "'") {
        i++
        continue
      }
      return i
    }
  }
  return -1
}

/* The node that starts where the cursor is and is indented `indent`,
 * leaving the cursor on the first line that is not part of it.
 */
function parseNode(at, indent) {
  const here = at.lines[at.i]
  if (here.dash) return parseSeq(at, indent)
  // A mapping key is a bare word and a `:`. Anything else at this
  // position is a scalar standing on its own, which is what the items
  // of a sequence of scalars are.
  if (splitKey(here.text)) return parseMap(at, indent)
  at.i++
  return parseScalar(here.text, here.no)
}

function parseSeq(at, indent) {
  const start = at.lines[at.i].no
  const items = []
  for (;;) {
    const here = at.lines[at.i]
    if (!here || !here.dash || here.indent !== indent) break
    const opened = here.no
    at.i++
    const next = at.lines[at.i]
    if (next && next.indent === indent + 2) {
      items.push(parseNode(at, indent + 2))
    } else if (next && next.indent > indent) {
      throw refuse(
        `line ${next.no}: indented ${next.indent}, where an item of the sequence on line ` +
          `${opened} is indented ${indent + 2}`,
      )
    } else {
      throw refuse(`line ${opened}: a \`-\` with nothing after it`)
    }
  }
  return new Node(SEQ, start, { items })
}

function parseMap(at, indent) {
  const start = at.lines[at.i].no
  const pairs = []
  for (;;) {
    const here = at.lines[at.i]
    if (!here || here.dash || here.indent !== indent) break
    const split = splitKey(here.text)
    if (!split) break
    const { key, rest } = split
    const opened = here.no
    at.i++

    let value
    const next = at.lines[at.i]
    if (rest !== '') {
      value = parseScalar(rest, opened)
    } else if (next && next.indent === indent + 2) {
      value = parseNode(at, indent + 2)
    } else if (next && next.indent > indent) {
      throw refuse(
        `line ${next.no}: indented ${next.indent}, where what is under \`${key}:\` on line ` +
          `${opened} is indented ${indent + 2}`,
      )
    } else {
      value = new Node(EMPTY, opened)
    }
    if (pairs.some((p) => p.key === key)) {
      throw refuse(`line ${opened}: ${key} is set twice in one mapping`)
    }
    pairs.push({ key, value })
  }
  return new Node(MAP, start, { pairs })
}

/* The key and the rest of the line, when the line opens a mapping
 * entry, and null when it does not.
 *
 * A key is a bare word, and the `:` after it ends the line or has a
 * space after it, so that a plain scalar holding a colon is still a
 * scalar.
 */
function splitKey(text) {
  let key
  let rest
  const cut = text.indexOf(': ')
  if (cut >= 0) {
    key = text.slice(0, cut)
    rest = text.slice(cut + 2).replace(/^ +/, '')
  } else if (text.endsWith(':')) {
    key = text.slice(0, -1)
    rest = ''
  } else {
    return null
  }
  if (key === '') return null
  for (const c of key) {
    const bare =
      c === '_' || c === '-' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
    if (!bare) return null
  }
  return { key, rest }
}

function parseScalar(text, at) {
  for (const mark of ['"', "'"]) {
    if (text.length === 0 || text[0] !== mark) continue
    const body = text.slice(1)
    // The closing quote is found by scanning rather than by taking the
    // last one on the line, so that `"a" and "b"` is refused instead of
    // read as one scalar with quotes in the middle.
    const end = closingQuote(body, mark)
    if (end < 0) {
      throw refuse(`line ${at}: a ${mark} that opens and does not close on its line`)
    }
    if (end + 1 !== body.length) {
      throw refuse(`line ${at}: ${quote(body.slice(end + 1))} after the scalar ends`)
    }
    const inner = body.slice(0, end)
    if (mark === "'") {
      // A single quoted run has one escape, the doubled quote, and a
      // backslash in it is a backslash.
      return new Node(SCALAR, at, { text: inner.replaceAll("''", "'"), quoted: true })
    }
    return new Node(SCALAR, at, { text: unescape(inner, at), quoted: true })
  }
  if (text.length > 0 && '[]{}&*!|>%@`'.includes(text[0])) {
    throw refuse(
      `line ${at}: a plain scalar opening with '${text[0]}', which is a construct this reader ` +
        'does not read',
    )
  }
  return new Node(SCALAR, at, { text })
}

/* The escapes the corpus uses, which is a subset of YAML's.
 *
 * The ones that name a code point by its digits are not here, because
 * the corpus writes those as the character itself and a case that wants
 * the digits is testing the engine's own escapes inside a query rather
 * than the file's.
 */
const escapes = {
  '"': '"',
  '\\': '\\',
  n: '\n',
  r: '\r',
  t: '\t',
  0: '\0',
  b: '\b',
  f: '\f',
}

function unescape(body, at) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i]
      continue
    }
    if (i + 1 >= body.length) throw refuse(`line ${at}: a scalar ending in a backslash`)
    const next = body[i + 1]
    if (!Object.hasOwn(escapes, next)) {
      throw refuse(`line ${at}: \\${next} is not an escape`)
    }
    out += escapes[next]
    i++
  }
  return out
}
