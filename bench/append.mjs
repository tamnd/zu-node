// What loading rows costs, and what it costs to load them the other way.
//
// The appender exists because `INSERT` is the wrong shape for a load:
// every row is parsed, bound, planned and committed, and the commit is
// the expensive part. So the first number here is the one to read the
// rest against, and the ratio between it and the last is the whole
// argument for the class.
//
// The other thing being measured is the boundary itself. `appendRow` is
// the one synchronous call in this client, and what it does is convert a
// value per column and push it onto a vector, so its number should be
// tens of nanoseconds rather than hundreds. When it is not, something on
// the way in started allocating.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:append

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 100_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 5)
// How many rows one `INSERT` carries in the batched case. Enough to
// amortize the commit and small enough that the statement it builds is
// one a parser can still be asked to read.
const BATCH = 500
// One statement per row is slow enough that measuring the whole table
// that way would dominate the run, so that case is measured over a
// smaller table and reported per row like the others.
const SLOW = Number(process.env.ZU_BENCH_SLOW_ROWS ?? 2_000)

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-append-'))

/// A database with the table declared and nothing else in it.
///
/// A fresh one per case, because a load into a table that already holds
/// a million rows is not the same load as one into a table that holds
/// two, and what is being compared is the way in rather than the size of
/// what is already there.
async function blank() {
  const path = join(dir, `bench-${counter++}.zu1`)
  const conn = await connect(path)
  // The declaring insert is written with literals, because that is what
  // tells the engine what each column holds.
  await conn.exec("INSERT (p:person {id: 0, name: 'n0'})")
  return conn
}

let counter = 0

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
///
/// The fastest for the reason bench/query.mjs gives: everything that
/// makes a run slower than the work itself is something that happened to
/// it rather than something about it.
async function time(rows, run) {
  await run(await blank())
  let best = Infinity
  for (let round = 0; round < REPEATS; round++) {
    const conn = await blank()
    const started = performance.now()
    await run(conn)
    best = Math.min(best, performance.now() - started)
    conn.close()
  }
  return best
}

const cases = [
  {
    // One statement per row, which is a parse, a plan and a commit per
    // row. The number every other line here is asking to be read
    // against.
    name: 'INSERT, one row each',
    rows: SLOW,
    run: async (conn) => {
      for (let ix = 1; ix <= SLOW; ix++) {
        await conn.exec(`INSERT (p:person {id: ${ix}, name: 'n${ix}'})`)
      }
    },
  },
  {
    // The same statement carrying five hundred rows, which is what a
    // loader without an appender ends up writing by hand.
    name: 'INSERT, 500 rows each',
    rows: ROWS,
    run: async (conn) => {
      for (let start = 1; start <= ROWS; start += BATCH) {
        const parts = []
        for (let ix = start; ix < Math.min(start + BATCH, ROWS + 1); ix++) {
          parts.push(`(p${ix}:person {id: ${ix}, name: 'n${ix}'})`)
        }
        await conn.exec(`INSERT ${parts.join(', ')}`)
      }
    },
  },
  {
    // Every row buffered and one commit at the end, which is the shape
    // the class is for.
    name: 'appender, one flush',
    rows: ROWS,
    run: async (conn) => {
      const rows = await conn.appender('person')
      for (let ix = 1; ix <= ROWS; ix++) rows.appendRow([BigInt(ix), `n${ix}`])
      await rows.close()
    },
  },
  {
    // The same rows with a flush every ten thousand, which is what a
    // loader that cannot hold the whole file in memory writes. The
    // difference from the line above is what the extra commits cost.
    name: 'appender, flush every 10k',
    rows: ROWS,
    run: async (conn) => {
      const rows = await conn.appender('person')
      for (let ix = 1; ix <= ROWS; ix++) {
        rows.appendRow([BigInt(ix), `n${ix}`])
        if (ix % 10_000 === 0) await rows.flush()
      }
      await rows.close()
    },
  },
  {
    // Rows handed over in arrays of a hundred, which is one boundary
    // crossing per hundred rows rather than one per row. What it saves
    // is the call and the checks around it, and what it costs is the
    // arrays.
    name: 'appender, appendRows(100)',
    rows: ROWS,
    run: async (conn) => {
      const rows = await conn.appender('person')
      let batch = []
      for (let ix = 1; ix <= ROWS; ix++) {
        batch.push([BigInt(ix), `n${ix}`])
        if (batch.length === 100) {
          rows.appendRows(batch)
          batch = []
        }
      }
      if (batch.length) rows.appendRows(batch)
      await rows.close()
    },
  },
  {
    // A whole number rather than a `bigint`, which is what a caller
    // writing row literals writes. It costs a check that the number is
    // whole and saves whatever the runtime charges for a `bigint`.
    name: 'appender, number ids',
    rows: ROWS,
    run: async (conn) => {
      const rows = await conn.appender('person')
      for (let ix = 1; ix <= ROWS; ix++) rows.appendRow([ix, `n${ix}`])
      await rows.close()
    },
  },
  {
    // The buffers on their own, with the commit taken out of the
    // measurement: everything is appended and then thrown away. What is
    // left is the conversion and the push, which is what `appendRow`
    // does and all it does.
    name: 'appender, buffered only',
    rows: ROWS,
    run: async (conn) => {
      const rows = await conn.appender('person')
      for (let ix = 1; ix <= ROWS; ix++) rows.appendRow([BigInt(ix), `n${ix}`])
      rows.discard()
    },
  },
]

console.log(`${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, rows, run } of cases) {
  const ms = await time(rows, run)
  const each = (ms * 1e6) / rows
  const scale = rows === ROWS ? '' : ` (over ${rows})`
  console.log(
    `${name.padEnd(26)} ${ms.toFixed(2).padStart(9)} ms  ${Math.round(each).toString().padStart(8)} ns/row${scale}`,
  )
}

await rm(dir, { recursive: true, force: true })
