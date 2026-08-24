/* What a case is, and how a file of them is read.
 *
 * A case is a statement and what running it must produce. That is
 * deliberately the whole of it. Every client in every language can run a
 * statement and look at the rows that come back, so a corpus written in
 * those terms is one every client can run, and a corpus written in terms
 * of a client's own API would be nine corpora.
 *
 * The expectation is either rows or a condition. A case expecting a
 * condition names the GQLSTATUS code, not the message, because the code
 * is the contract and the message is prose that will improve.
 *
 * A statement may take parameters, which is the other direction the same
 * values travel: a case with `params:` writes a value in the encoding,
 * hands it to this client's own binding call, and asserts what came
 * back. A client that decodes a date correctly and encodes it a day
 * early passes every case that has no parameters in it.
 *
 * A case may say which connection each of its statements runs on, which
 * is how a case about a transaction is written: a transaction is only
 * observable from outside it, so a case that has to say what a commit
 * means needs a second connection to say it to. A case that says nothing
 * runs everything on one connection called main, which is every case but
 * a handful.
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { parseExport } from './arrow.mjs'
import { parse, quote, refuse } from './reader.mjs'
import { decode, form, payload, typed } from './values.mjs'

/* The schema version a file declares. It exists so that a corpus
 * unpacked from an old release tells a new runner what it is instead of
 * failing in the middle.
 */
export const SCHEMA = 4

/* The connection a statement runs on when the case does not name one. */
export const MAIN = 'main'

const SUITE_KEYS = ['schema', 'suite', 'doc', 'load', 'cases']
const CASE_KEYS = [
  'name',
  'doc',
  'setup',
  'on',
  'params',
  'query',
  'columns',
  'rows',
  'raises',
  'arrow',
]
const LOAD_KEYS = ['nodes', 'edges', 'count', 'columns', 'pairs']

/* Every suite in a directory, in the order a sorted listing gives, which
 * is the order the reference runner walks them in.
 */
export async function readDir(directory) {
  let names
  try {
    names = await readdir(directory)
  } catch (err) {
    throw refuse(`${directory}: ${err.message}`)
  }
  // Sorted, because a directory listing is the filesystem's order and a
  // report that is diffed against another runner's has to walk them the
  // same way.
  const paths = names
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => join(directory, name))
  const suites = []
  for (const path of paths) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      throw refuse(`${path}: ${err.message}`)
    }
    let suite
    try {
      suite = read(text)
    } catch (err) {
      throw refuse(`${path}: ${err.message}`)
    }
    const stem = basename(path, '.yaml')
    if (suite.name !== stem) {
      throw refuse(
        `${path}: the suite calls itself ${quote(suite.name)} and the file calls it ${quote(stem)}`,
      )
    }
    suites.push(suite)
  }
  if (suites.length === 0) throw refuse(`${directory}: no case files`)
  return suites
}

/* A suite, or the first thing in the file that is not one. */
export function read(text) {
  const doc = parse(text)
  const unknown = doc.unknown(...SUITE_KEYS)
  if (unknown.length > 0) {
    throw refuse(`line ${doc.line}: a suite has no key ${quote(unknown[0])}`)
  }
  const schemaNode = doc.get('schema')
  const schema = schemaNode === null ? null : schemaNode.str()
  if (schema === null) throw refuse('the file does not open with `schema:`')
  if (!/^[0-9]+$/.test(schema)) throw refuse(`${quote(schema)} is not a schema version`)
  const version = Number(schema)
  if (version !== SCHEMA) {
    throw refuse(`this is schema ${version} and the runner reads schema ${SCHEMA}`)
  }

  const name = field(doc, 'suite')
  const docText = field(doc, 'doc')
  const loadNode = doc.get('load')
  const load = loadNode === null ? null : readLoad(loadNode)

  const casesNode = doc.get('cases')
  if (casesNode === null) throw refuse('a suite with no `cases:`')
  const items = casesNode.seq()
  if (items === null) throw refuse('`cases:` is a sequence')
  if (items.length === 0) throw refuse('a suite with no cases in it')
  const cases = []
  // Names are what a report cites and what a binding's skip list names,
  // so two cases sharing one is a report that says less than it looks
  // like it does.
  const seen = new Set()
  for (const item of items) {
    const one = readCase(item)
    if (seen.has(one.name)) throw refuse(`two cases are called ${quote(one.name)}`)
    seen.add(one.name)
    cases.push(one)
  }
  return { name, doc: docText, load, cases }
}

function field(node, key) {
  const value = node.get(key)
  if (value === null) throw refuse(`line ${node.line}: no \`${key}:\``)
  const text = value.str()
  if (text === null) throw refuse(`line ${node.line}: \`${key}:\` is one line of text`)
  return text
}

function readCase(node) {
  const at = node.line
  if (!node.map()) throw refuse(`line ${at}: a case is a mapping, and this is ${node.what()}`)
  const unknown = node.unknown(...CASE_KEYS)
  if (unknown.length > 0) throw refuse(`line ${at}: a case has no key ${quote(unknown[0])}`)

  const name = field(node, 'name')
  if (!dashedWords(name)) {
    throw refuse(
      `line ${at}: ${quote(name)} is a case name, which is lower case words joined by dashes`,
    )
  }
  const doc = field(node, 'doc')
  const query = field(node, 'query')

  const setup = []
  const setupNode = node.get('setup')
  if (setupNode !== null) {
    const items = setupNode.seq()
    if (items === null) throw refuse(`line ${at}: \`setup:\` is a sequence of statements`)
    for (const item of items) setup.push(readStep(item))
  }

  const onNode = node.get('on')
  const on = onNode === null ? MAIN : connectionName(onNode)
  const params = readParams(node)
  const arrowNode = node.get('arrow')
  const arrow = arrowNode === null ? null : parseExport(arrowNode)

  const one = {
    name,
    doc,
    query,
    line: at,
    setup,
    on,
    params,
    arrow,
    hasColumns: false,
    columns: [],
    rows: [],
    raises: '',
  }

  const raisesNode = node.get('raises')
  const columnsNode = node.get('columns')
  if (raisesNode !== null && columnsNode !== null) {
    throw refuse(
      `line ${at}: a case that raises has no rows, and one that returns rows does not raise`,
    )
  }
  if (raisesNode !== null) {
    const code = raisesNode.str()
    if (code === null) throw refuse(`line ${at}: \`raises:\` is a GQLSTATUS code`)
    if (!gqlstatusShaped(code)) {
      throw refuse(
        `line ${raisesNode.line}: ${quote(code)} is not the shape of a GQLSTATUS, which is five ` +
          'characters of digits and capitals',
      )
    }
    one.raises = code
    return one
  }
  if (columnsNode === null) {
    throw refuse(
      `line ${at}: a case says what it produces, with \`columns:\` and \`rows:\` or with \`raises:\``,
    )
  }
  // Empty counts, because FINISH is a query that answers no columns at
  // all, which is not the same as a query whose columns held no rows,
  // and the corpus writes it as a `columns:` with nothing under it.
  const names = columnsNode.seqOrEmpty()
  if (names === null) throw refuse(`line ${at}: \`columns:\` is a sequence of names`)
  const columns = names.map((item) => {
    const text = item.str()
    if (text === null) throw refuse(`line ${item.line}: a column name is one word`)
    return text
  })
  const rows = readRows(node)
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw refuse(`line ${at}: a row of ${row.length} against ${columns.length} columns`)
    }
  }
  one.hasColumns = true
  one.columns = columns
  one.rows = rows
  return one
}

/* One setup statement, which is a line of its own or a line and the
 * connection it runs on.
 */
function readStep(node) {
  const text = node.str()
  if (text !== null) return { on: MAIN, query: text }
  if (!node.map()) {
    throw refuse(
      `line ${node.line}: a setup statement is one line, or \`on:\` and \`query:\`, and this is ` +
        node.what(),
    )
  }
  const unknown = node.unknown('on', 'query')
  if (unknown.length > 0) {
    throw refuse(`line ${node.line}: a setup statement has no key ${quote(unknown[0])}`)
  }
  const onNode = node.get('on')
  if (onNode === null) {
    throw refuse(
      `line ${node.line}: a setup statement written as a mapping names the connection it runs on`,
    )
  }
  return { on: connectionName(onNode), query: field(node, 'query') }
}

/* The name of a connection, spelled the way a case name is, because a
 * report cites it and a name a reader has to guess at is a report that
 * says less than it looks like it does.
 */
function connectionName(node) {
  const name = node.str()
  if (name === null) throw refuse(`line ${node.line}: \`on:\` is the name of a connection`)
  if (!dashedWords(name)) {
    throw refuse(
      `line ${node.line}: ${quote(name)} is a connection name, which is lower case words joined ` +
        'by dashes',
    )
  }
  return name
}

/* The parameters a case binds, which is the value encoding with a name
 * beside it.
 *
 * A name is what the statement spells after the $, so it is checked
 * against what a statement may spell: a case whose name is "n one" is
 * one no client can bind.
 */
function readParams(node) {
  const paramsNode = node.get('params')
  if (paramsNode === null) return []
  const items = paramsNode.seq()
  if (items === null) throw refuse(`line ${paramsNode.line}: \`params:\` is a sequence`)
  const out = []
  for (const item of items) {
    const at = item.line
    if (!item.map()) {
      throw refuse(
        `line ${at}: a parameter is a mapping of \`name\`, \`type\` and \`value\`, and this is ` +
          item.what(),
      )
    }
    const unknown = item.unknown('name', 'type', 'value')
    if (unknown.length > 0) throw refuse(`line ${at}: a parameter has no key ${quote(unknown[0])}`)
    const name = field(item, 'name')
    if (!wordOrUnderscore(name)) {
      throw refuse(
        `line ${at}: ${quote(name)} is a parameter name, which is what a statement writes after ` +
          'the `$`',
      )
    }
    if (out.some((held) => held.name === name)) {
      throw refuse(`line ${at}: two parameters are called ${quote(name)}`)
    }
    out.push({ name, value: typed(item) })
  }
  return out
}

function readRows(node) {
  const rowsNode = node.get('rows')
  if (rowsNode === null) {
    // A statement that returns no rows is a case worth having, and
    // writing it as an absent `rows:` would make it the same shape as
    // one somebody forgot to finish.
    throw refuse(
      `line ${node.line}: \`columns:\` with no \`rows:\`. A case expecting nothing back writes ` +
        '`rows:` with an empty sequence under it.',
    )
  }
  const items = rowsNode.seqOrEmpty()
  if (items === null) throw refuse(`line ${rowsNode.line}: \`rows:\` is a sequence of rows`)
  return items.map((item) => {
    const unknown = item.unknown('values')
    if (unknown.length > 0) throw refuse(`line ${item.line}: a row has no key ${quote(unknown[0])}`)
    const cellsNode = item.get('values')
    if (cellsNode === null) {
      throw refuse(`line ${item.line}: a row is a \`values:\` and the values under it`)
    }
    const cells = cellsNode.seqOrEmpty()
    if (cells === null) {
      throw refuse(`line ${cellsNode.line}: \`values:\` is a sequence of values`)
    }
    return cells.map((cell) => decode(cell))
  })
}

/* One node table, its columns, and the edges between its rows.
 *
 * Everything else in the corpus is an expression, and an expression says
 * what a value means on the way out and nothing about how it got in. A
 * load is the other half, and every runner puts it in through its own
 * bulk load path, which for this client is the package's `load`.
 */
function readLoad(node) {
  const at = node.line
  if (!node.map()) throw refuse(`line ${at}: a load is a mapping, and this is ${node.what()}`)
  const unknown = node.unknown(...LOAD_KEYS)
  if (unknown.length > 0) throw refuse(`line ${at}: a load has no key ${quote(unknown[0])}`)
  const nodes = tableName(node, 'nodes')
  const edges = tableName(node, 'edges')
  const countNode = node.get('count')
  const countText = countNode === null ? null : countNode.str()
  if (countText === null) {
    throw refuse(`line ${at}: a load says how many rows it has, with \`count:\``)
  }
  if (!/^[0-9]+$/.test(countText)) throw refuse(`line ${at}: \`count:\` is a number of rows`)
  const count = Number(countText)
  if (count === 0) {
    throw refuse(`line ${at}: a load of no rows is a load nothing can be read back from`)
  }

  const columnsNode = node.get('columns')
  if (columnsNode === null) throw refuse(`line ${at}: a load has \`columns:\``)
  const items = columnsNode.seq()
  if (items === null) throw refuse(`line ${at}: \`columns:\` is a sequence`)
  const columns = []
  const seen = new Set()
  for (const item of items) {
    const column = readColumn(item, count)
    if (seen.has(column.name)) throw refuse(`line ${at}: two columns are called ${quote(column.name)}`)
    seen.add(column.name)
    columns.push(column)
  }
  if (columns.length === 0) throw refuse(`line ${at}: a load with no columns holds no values`)

  const pairs = []
  const pairsNode = node.get('pairs')
  if (pairsNode !== null) {
    const edgeItems = pairsNode.seqOrEmpty()
    if (edgeItems === null) throw refuse(`line ${at}: \`pairs:\` is a sequence of edges`)
    for (const item of edgeItems) pairs.push(readEdge(item, count))
  }
  return { nodes, edges, count, columns, pairs }
}

function tableName(node, key) {
  const text = field(node, key)
  if (!wordOrUnderscore(text)) {
    throw refuse(`line ${node.line}: ${quote(text)} is not a table name`)
  }
  return text
}

/* One column of a load: a name, the type every value in it has, and the
 * values in row order.
 */
function readColumn(node, count) {
  const at = node.line
  const unknown = node.unknown('name', 'type', 'values')
  if (unknown.length > 0) throw refuse(`line ${at}: a column has no key ${quote(unknown[0])}`)
  const name = tableName(node, 'name')
  const type = field(node, 'type')
  if (!form(type).known) {
    throw refuse(`line ${at}: ${type} is not a type this encoding knows`)
  }
  const valuesNode = node.get('values')
  const items = valuesNode === null ? null : valuesNode.seq()
  if (items === null) throw refuse(`line ${at}: a column holds \`values:\` in row order`)
  if (items.length !== count) {
    throw refuse(
      `line ${at}: column ${quote(name)} holds ${items.length} values against the ${count} rows ` +
        'the load declares',
    )
  }
  return { name, type, values: items.map((item) => payload(type, item)) }
}

function readEdge(node, count) {
  const at = node.line
  const unknown = node.unknown('from', 'to')
  if (unknown.length > 0) throw refuse(`line ${at}: an edge has no key ${quote(unknown[0])}`)
  const ends = []
  for (const key of ['from', 'to']) {
    const value = node.get(key)
    const text = value === null ? null : value.str()
    if (text === null) throw refuse(`line ${at}: an edge has a \`${key}:\` row number`)
    if (!/^-?[0-9]+$/.test(text)) throw refuse(`line ${at}: \`${key}:\` is a row number`)
    const end = Number(text)
    if (end < 0 || end >= count) {
      throw refuse(
        `line ${at}: \`${key}: ${end}\` against a table of ${count} rows, which are numbered 0 ` +
          `to ${count - 1}`,
      )
    }
    ends.push(end)
  }
  return ends
}

/* Whether text is lower case ASCII words joined by dashes, which is how
 * a case and a connection are named.
 */
function dashedWords(text) {
  return text !== '' && /^[a-z0-9-]+$/.test(text)
}

/* Whether text is ASCII letters, digits and underscores, which is what a
 * statement may write after a $ and what a table may be called.
 */
function wordOrUnderscore(text) {
  return text !== '' && /^[A-Za-z0-9_]+$/.test(text)
}

/* Whether a code is the shape of a GQLSTATUS, which is five characters
 * of digits and capitals. The shape and not the list: a corpus that had
 * to be told about every code the standard defines would be one nobody
 * could add a case to.
 */
function gqlstatusShaped(code) {
  return /^[0-9A-Z]{5}$/.test(code)
}
