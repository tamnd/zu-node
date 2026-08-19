// What building a database out of columns costs.
//
// `load` is the other way in, and it is the only way to a graph with
// edges in it. The appender writes rows into a table that already
// exists; this writes the file, so the numbers here are not the
// appender's numbers with a different name on them and the first two
// lines are what says so.
//
// The third and fourth are about the way the columns were handed over.
// A typed array is read as the numbers it already holds, which is one
// pass over memory, and an ordinary array is read a value at a time
// through the runtime. The gap between them is the whole argument for
// reaching for a typed array on a load this size.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:load

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect, load } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 1_000_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 3)

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-load-'))

const wide = BigInt64Array.from({ length: ROWS }, (_, ix) => BigInt(ix))
const plain = Array.from({ length: ROWS }, (_, ix) => ix)
const name = Array.from({ length: ROWS }, (_, ix) => `n${ix}`)
// Out of order on purpose, because sorting them is half the work of
// building the graph and an edge list a program produced by walking
// something else is never in order.
const edges = new Uint32Array(ROWS * 2)
for (let ix = 0; ix < ROWS; ix++) {
  edges[ix * 2] = ix
  edges[ix * 2 + 1] = (ix * 7 + 1) % ROWS
}

let counter = 0

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
///
/// A fresh path every time, because a load will not write over a
/// database that is there and because a second load into a warm page
/// cache is not the load being measured.
async function time(run) {
  await run(join(dir, `warm-${counter++}.zu1`))
  let best = Infinity
  for (let round = 0; round < REPEATS; round++) {
    const path = join(dir, `bench-${counter++}.zu1`)
    const started = performance.now()
    await run(path)
    best = Math.min(best, performance.now() - started)
  }
  return best
}

const cases = [
  {
    // One column of whole numbers and nothing else, which is the floor:
    // the file, the table and one run of words.
    name: 'one column, typed array',
    run: (path) => load(path, { nodes: 'person', columns: { uid: wide } }),
  },
  {
    // The same column written as an ordinary array, which is a runtime
    // call per value on the way in.
    name: 'one column, plain array',
    run: (path) => load(path, { nodes: 'person', columns: { uid: plain } }),
  },
  {
    // A column of strings, which is where the bytes are.
    name: 'two columns, with names',
    run: (path) => load(path, { nodes: 'person', columns: { uid: wide, name } }),
  },
  {
    // The graph: the same columns and an edge per row, sorted and built
    // into the CSRs a pattern walks.
    name: 'two columns and an edge each',
    run: (path) => load(path, { nodes: 'person', rels: 'knows', columns: { uid: wide, name }, edges }),
  },
  {
    // The other way in, for the one case both can do: rows into a table
    // that a first insert declared. No edges, since no statement makes
    // a rel table.
    name: 'the appender, for contrast',
    run: async (path) => {
      const conn = await connect(path)
      await conn.exec("INSERT (p:person {uid: 0, name: 'n0'})")
      const rows = await conn.appender('person')
      for (let ix = 1; ix < ROWS; ix++) rows.appendRow([wide[ix], name[ix]])
      await rows.close()
      conn.close()
    },
  },
]

console.log(`${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, run } of cases) {
  const ms = await time(run)
  const each = (ms * 1e6) / ROWS
  console.log(
    `${name.padEnd(30)} ${ms.toFixed(1).padStart(9)} ms  ${Math.round(each).toString().padStart(6)} ns/row`,
  )
}

await rm(dir, { recursive: true, force: true })
