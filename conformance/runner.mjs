/* Running the corpus through this client, and saying what happened in
 * the form the other runners are compared against.
 *
 * Each case gets a database of its own. Cases in a suite are written as
 * if nothing came before them, and the cheapest way to keep that true is
 * to make it true: a case that leaked a table into the next one would be
 * a failure that moves when the file is reordered, which is the worst
 * kind to be handed.
 *
 * An outcome is one of three things and not two. Passed and failed are
 * obvious. Unsupported is the third, and it exists because the corpus is
 * versioned with the engine and shipped to clients that will not all
 * implement the same subset at the same time: a client that cannot yet
 * parse a statement should say so, and a report should be able to tell
 * that apart from an answer that came back wrong.
 *
 * What this prints is what the Rust runner prints, line for line, so
 * that a disagreement between two clients is a diff and not a reading
 * exercise.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { connect, load } from 'zudb'

import { exported, schemaSays } from './arrow.mjs'
import { MAIN } from './cases.mjs'
import { CorpusError, quote, refuse } from './reader.mjs'
import { cell, isInteger, same, show } from './values.mjs'

/* A result this client's own value mapping has nowhere to put.
 *
 * Not a defect and not a failure. A case that asks for something the
 * mapping cannot express is a case this client is honestly unable to
 * answer, and saying so by name is worth more than either passing it on
 * a value made up for the occasion or failing it as though the engine
 * had got something wrong. The corpus writes those cases on purpose, so
 * a client that hits one is being told what its mapping costs.
 */
export class Beyond extends Error {
  constructor(message) {
    super(message)
    this.name = 'Beyond'
  }
}

/* The three outcomes. */
export const PASSED = 'passed'
export const FAILED = 'failed'
export const UNSUPPORTED = 'unsupported'

/* How a report spells an outcome, which is the reference runner's
 * spelling and not a word of it different.
 */
export function mark(outcome) {
  if (outcome === PASSED) return 'ok'
  if (outcome === FAILED) return 'FAILED'
  return 'unsupported'
}

/* The line a report prints for one case. */
export function line(ran) {
  const head = `${ran.suite}/${ran.case} line ${ran.line} ${mark(ran.outcome)}`
  return ran.detail === '' ? head : `${head}: ${ran.detail}`
}

/* How many cases came to one outcome. */
export function count(ran, outcome) {
  return ran.filter((one) => one.outcome === outcome).length
}

/* One line saying what the run came to, which is what a CI log keeps and
 * what two runs are compared by.
 */
export function summary(ran) {
  return (
    `${ran.length} cases, ${count(ran, PASSED)} passed, ${count(ran, FAILED)} failed, ` +
    `${count(ran, UNSUPPORTED)} unsupported`
  )
}

/* Runs every case of every suite, in the order they were written.
 *
 * `directory` is one the runner may make databases under. Each case gets
 * its own file in it, named after the case, so that a failure leaves
 * something to open.
 *
 * `onRan` is called with each case as it finishes, which is what makes a
 * run of fourteen hundred cases print as it goes rather than at the end.
 */
export async function run(suites, directory, onRan) {
  const ran = []
  for (const suite of suites) {
    for (const one of suite.cases) {
      const outcome = await runCase(suite, one, directory)
      // A failure leaves its database behind, which is the one thing
      // somebody reading the report will want to open. Everything else
      // goes as it finishes, because a corpus of fourteen hundred cases
      // is fourteen hundred files and holding them all until the run
      // ends is gigabytes of a disk that has other work to do. The Rust
      // and Go runners do the same.
      if (outcome.outcome !== FAILED) {
        const path = casePath(directory, suite.name, one.name)
        await rm(path, { force: true })
        // The WAL sidecar goes with it. A database is <db> and its log
        // is <db>.wal, and a log left beside a name the next run creates
        // again is a log that run would adopt.
        await rm(`${path}.wal`, { force: true })
      }
      ran.push(outcome)
      if (onRan) onRan(outcome)
    }
  }
  return ran
}

function casePath(directory, suite, name) {
  return join(directory, `${suite}-${name}.zu`)
}

async function runCase(suite, one, directory) {
  const ran = (outcome, detail) => ({
    suite: suite.name,
    case: one.name,
    line: one.line,
    outcome,
    detail,
  })
  const path = casePath(directory, suite.name, one.name)

  // The load goes in before the connection opens, because it is bulk
  // load and bulk load is the path that builds the file rather than one
  // that goes through a statement. Every case of the suite gets its own
  // copy of it for the same reason every case gets its own database.
  //
  // A load makes the file, so the two halves of this are the two ways a
  // database comes into being in this client and a case has exactly one
  // of them.
  if (suite.load !== null) {
    try {
      await applyLoad(suite.load, path)
    } catch (err) {
      return ran(FAILED, `the suite's load: ${errorText(err)}`)
    }
  }

  let main
  try {
    main = await connect(path)
  } catch (err) {
    return ran(FAILED, `opening ${path}: ${errorText(err)}`)
  }
  const open = [{ name: MAIN, conn: main }]
  try {
    return await withConnections(suite, one, open, ran)
  } finally {
    // In reverse, so that the connection the case was opened with is the
    // last one to go, which is the order the ones after it were made
    // from it in.
    for (let i = open.length - 1; i >= 0; i--) open[i].conn.close()
  }
}

async function withConnections(suite, one, open, ran) {
  for (const [i, step] of one.setup.entries()) {
    let on
    try {
      on = await connection(open, step.on)
    } catch (err) {
      return ran(FAILED, `connecting as ${quote(step.on)}: ${errorText(err)}`)
    }
    try {
      await on.exec(step.query)
    } catch (err) {
      // A setup that fails is not a result about the statement under
      // test, so it is never a pass and never a quiet skip.
      if (unsupported(err)) return ran(UNSUPPORTED, `setup ${i + 1}: ${errorText(err)}`)
      return ran(FAILED, `setup ${i + 1} failed: ${errorText(err)}`)
    }
  }

  let on
  try {
    on = await connection(open, one.on)
  } catch (err) {
    return ran(FAILED, `connecting as ${quote(one.on)}: ${errorText(err)}`)
  }

  const params = bound(one)
  let rows
  try {
    rows = await on.query(one.query, params)
  } catch (err) {
    if (one.raises !== '') {
      const code = statusCode(err)
      if (code === '') {
        return ran(
          FAILED,
          `failed with no GQLSTATUS where the case wants ${one.raises}: ${errorText(err)}`,
        )
      }
      if (code === one.raises) return ran(PASSED, '')
      return ran(FAILED, `raised ${code} where the case wants ${one.raises}: ${errorText(err)}`)
    }
    if (unsupported(err)) return ran(UNSUPPORTED, errorText(err))
    return ran(FAILED, errorText(err))
  }

  if (one.raises !== '') return ran(FAILED, `returned rows where the case wants ${one.raises}`)

  let got
  try {
    got = readAll(rows)
  } catch (err) {
    if (err instanceof Beyond) return ran(UNSUPPORTED, err.message)
    return ran(FAILED, errorText(err))
  }
  const detail = compare(one.columns, one.rows, rows.columns, got)
  if (detail !== '') return ran(FAILED, detail)
  const arrow = await exportSays(one.arrow, on, one, params, got.length)
  if (arrow !== '') return ran(FAILED, arrow)
  return ran(PASSED, '')
}

/* The connection a case named, made if this is the first mention of it.
 *
 * A new one is a duplicate of the case's own rather than a second open
 * of the file, which is what a pool does: the two share the write side,
 * so each sees what the other has committed. Opening the path twice
 * would be two databases that happen to be the same file, which is a
 * different thing and not what a case about a transaction means.
 */
async function connection(open, name) {
  for (const had of open) {
    if (had.name === name) return had.conn
  }
  const made = await open[0].conn.duplicate()
  open.push({ name, conn: made })
  return made
}

/* The parameters of a case, in the shape this client's own call takes,
 * which is an object of name to value.
 */
function bound(one) {
  if (one.params.length === 0) return null
  const out = {}
  for (const param of one.params) out[param.name] = param.value
  return out
}

/* Every row of a result, in the corpus's own shape.
 *
 * A row comes back as an object keyed by column name, so the positions a
 * case is written in come from the result's own `columns`. Two columns
 * of one name are one property, so a result holding them is one this
 * client cannot read positionally at all, and the case is reported
 * unsupported with the reason named rather than compared against a row
 * this made up.
 */
function readAll(rows) {
  const columns = rows.columns
  if (new Set(columns).size !== columns.length) {
    throw new Beyond(
      'the result has two columns of one name, and a row comes back keyed by name in this client',
    )
  }
  // Into the corpus's own shape here rather than at the comparison,
  // because the engine's edge carries a field the corpus does not write
  // and a path is a pair of lists where a case writes one walk.
  return rows.map((row) => columns.map((name) => cell(row[name])))
}

/* Puts the suite's load in through this client's own bulk load path,
 * which is the strongest form of the corpus question: the value crosses
 * the boundary twice and by two different mechanisms.
 */
async function applyLoad(loadable, path) {
  const columns = {}
  for (const column of loadable.columns) columns[column.name] = loadColumn(column)
  const options = {
    nodes: loadable.nodes,
    rels: loadable.edges,
    rows: loadable.count,
    columns,
  }
  if (loadable.pairs.length > 0) {
    // Flat, which is the spelling that costs nothing: two elements an
    // edge, read where they lie.
    const edges = new Uint32Array(loadable.pairs.length * 2)
    for (const [i, pair] of loadable.pairs.entries()) {
      edges[i * 2] = pair[0]
      edges[i * 2 + 1] = pair[1]
    }
    options.edges = edges
  }
  await load(path, options)
}

/* One column of a load, in the shape the load call takes.
 *
 * The type is pinned by what the column declared rather than left to the
 * values, because a plain array is read by its first value and a FLOAT64
 * column whose first value is a whole 1.0 is the number 1, which would
 * settle the column as INT64 and put every value in it somewhere it does
 * not belong. A typed array says the width outright, so the two types
 * that have one get one.
 */
function loadColumn(column) {
  if (isInteger(column.type)) return BigInt64Array.from(column.values)
  if (column.type === 'FLOAT32' || column.type === 'FLOAT64') {
    return Float64Array.from(column.values)
  }
  switch (column.type) {
    case 'STRING':
    case 'BOOL':
    case 'DATE':
    case 'LOCALTIME':
    case 'ZONEDTIME':
    case 'LOCALDATETIME':
    case 'ZONEDDATETIME':
    case 'DURATION':
      // A class or a runtime value, which a column of this client holds
      // as itself. The first value settles nothing here because every
      // one of these is exactly one type.
      return column.values
  }
  throw refuse(`a load column of ${column.type}, which this client has no column type for`)
}

/* What the export gave that the case did not want, or the empty string
 * when the case says nothing about it and when the two agree.
 *
 * A result Arrow has no type for is a refusal from the export rather
 * than a condition from the statement, so a case saying `refused` is the
 * case where the export failing is the right answer.
 *
 * This runs the statement a second time, where the Go and Python runners
 * export the result they already read. Those clients are handed a C Data
 * Interface stream off a result; this one is handed a buffer of Arrow
 * IPC bytes by a call of its own, and there is no way to ask an already
 * read result for them. Every case that asserts an export is a read, so
 * running it twice says the same thing twice.
 */
async function exportSays(want, on, one, params, rows) {
  if (want === null) return ''
  let arrow
  try {
    arrow = await on.arrow(one.query, params)
  } catch (err) {
    if (want.refused) return ''
    return `arrow refused the result: ${errorText(err)}`
  }
  if (want.refused) return 'arrow exported the result where the case wants a refusal'
  let got
  try {
    got = exported(arrow)
  } catch (err) {
    return `arrow gave a stream this runner could not read: ${errorText(err)}`
  }
  const detail = schemaSays(got.fields, want.fields)
  if (detail !== '') return detail
  if (got.rows !== rows) {
    return `arrow gives ${got.rows} rows where the case wants ${rows}`
  }
  if (got.declared !== got.rows) {
    return `arrow says it holds ${got.declared} rows and its batches hold ${got.rows}`
  }
  return ''
}

/* Whether a condition means the engine does not implement the statement
 * rather than that the statement is wrong.
 *
 * The two GQL classes that say so are 42, syntax error or access rule
 * violation, and 0A, feature not supported. A case landing on either is
 * a case ahead of the engine, which the corpus allows on purpose: the
 * cases are the contract and the engine catches up to them.
 */
function unsupported(err) {
  const code = statusCode(err)
  return code.startsWith('42') || code.startsWith('0A')
}

/* The GQLSTATUS a failure carries, or the empty string for one that
 * carries none.
 */
function statusCode(err) {
  return typeof err?.code === 'string' ? err.code : ''
}

/* What the engine said, which is what the Rust runner prints for the
 * same failure.
 *
 * The message a condition carries already opens with its own code, which
 * is why nothing is added here.
 */
function errorText(err) {
  if (err instanceof CorpusError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/* What differs between what a case wants and what came back, or the
 * empty string if nothing does.
 *
 * It reports the first difference rather than all of them, because the
 * first is nearly always the cause of the rest, and a report that prints
 * a hundred rows is one nobody reads to the end. The order the checks
 * run in is the reference runner's, so that two runners looking at the
 * same wrong answer say the same thing about it.
 */
function compare(wantColumns, wantRows, gotColumns, gotRows) {
  if (!sameNames(wantColumns, gotColumns)) {
    return `columns ${names(gotColumns)} where the case wants ${names(wantColumns)}`
  }
  for (let i = 0; i < wantRows.length && i < gotRows.length; i++) {
    const want = wantRows[i]
    const got = gotRows[i]
    for (let j = 0; j < want.length && j < got.length; j++) {
      if (same(want[j], got[j])) continue
      const name = j < wantColumns.length ? wantColumns[j] : '?'
      return (
        `row ${i + 1} column ${name} is ${show(got[j])} where the case wants ${show(want[j])}`
      )
    }
  }
  if (wantRows.length !== gotRows.length) {
    return `${gotRows.length} rows where the case wants ${wantRows.length}`
  }
  return ''
}

function sameNames(want, got) {
  return want.length === got.length && want.every((name, i) => name === got[i])
}

/* A list of column names the way Rust's {:?} writes one. */
function names(columns) {
  return `[${columns.map((name) => `"${name}"`).join(', ')}]`
}
