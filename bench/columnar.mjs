// What a result costs read down its columns against read across its
// rows.
//
// The two calls run the same statement and differ only in what they
// build out of the answer: `query` makes an object a row and a value a
// cell, and `columnar` moves one buffer a column. So the gap between
// the two lines of a pair is the cost of making JavaScript values, which
// is what this is measuring and the only reason the second call exists.
//
// The last block is what a caller does next. A sum over a typed array
// against a sum over an array of objects is the honest comparison,
// because a program that asked for a million rows is going to walk them,
// and the buffer is quicker to walk as well as quicker to make.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:columnar

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 1_000_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 5)

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-columnar-'))
const conn = await connect(join(dir, 'bench.zu1'))

await conn.exec("INSERT (p:person {uid: 1, score: 1.5, name: 'n1'})")
{
  const rows = await conn.appender('person')
  for (let ix = 2; ix <= ROWS; ix++) rows.appendRow([BigInt(ix), ix / 3, `n${ix}`])
  await rows.close()
}

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
///
/// The fastest for the reason bench/query.mjs gives: everything that
/// makes a run slower than the work itself is something that happened to
/// it rather than something about it.
async function time(run) {
  await run()
  let best = Infinity
  for (let round = 0; round < REPEATS; round++) {
    const started = performance.now()
    await run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

function report(name, ms) {
  const each = (ms * 1e6) / ROWS
  console.log(
    `${name.padEnd(30)} ${ms.toFixed(1).padStart(8)} ms  ${Math.round(each).toString().padStart(6)} ns/row`,
  )
}

const cases = [
  {
    name: 'one integer column, columnar',
    run: () => conn.columnar('MATCH (p:person) RETURN p.uid AS uid'),
  },
  {
    name: 'one integer column, rows',
    run: () => conn.query('MATCH (p:person) RETURN p.uid AS uid'),
  },
  {
    name: 'a float column, columnar',
    run: () => conn.columnar('MATCH (p:person) RETURN p.score AS score'),
  },
  {
    name: 'a float column, rows',
    run: () => conn.query('MATCH (p:person) RETURN p.score AS score'),
  },
  {
    name: 'a string column, columnar',
    run: () => conn.columnar('MATCH (p:person) RETURN p.name AS name'),
  },
  {
    name: 'a string column, rows',
    run: () => conn.query('MATCH (p:person) RETURN p.name AS name'),
  },
  {
    name: 'three columns, columnar',
    run: () =>
      conn.columnar('MATCH (p:person) RETURN p.uid AS uid, p.score AS score, p.name AS name'),
  },
  {
    name: 'three columns, rows',
    run: () => conn.query('MATCH (p:person) RETURN p.uid AS uid, p.score AS score, p.name AS name'),
  },
]

console.log(`reading ${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, run } of cases) report(name, await time(run))

// What the caller does with what they were handed. The statement is not
// timed here: both sides already have the whole answer and the question
// is what walking it costs.
const read = await conn.columnar('MATCH (p:person) RETURN p.uid AS uid')
const rows = await conn.query('MATCH (p:person) RETURN p.uid AS uid')

console.log('')
console.log('summing what came back')
report(
  'over the buffer',
  await time(async () => {
    let total = 0n
    for (const value of read.columns[0].values) total += value
    return total
  }),
)
report(
  'over the rows',
  await time(async () => {
    let total = 0n
    for (const row of rows) total += row.uid
    return total
  }),
)

await conn.close()
await rm(dir, { recursive: true, force: true })
