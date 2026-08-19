// What a result costs as Arrow, against the two other ways out.
//
// Three calls over the same statement. `query` builds an object a row
// and a value a cell. `columnar` moves one buffer a column and leaves
// the reader to put a type around them. `arrow` writes those same
// buffers into an IPC stream, which costs a copy of the values and a
// header a batch, and buys a result every Arrow implementation reads.
//
// So the pair worth reading is `arrow` against `columnar`: the
// difference between them is what the framing costs, and it is the
// number that says whether a caller should take the bytes or take the
// buffers. The line after each is the reader's side, since bytes nobody
// decodes are not a result: `tableFromIPC` against the eleven lines the
// README prints for wrapping the buffers.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:arrow

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { tableFromIPC } from 'apache-arrow'
import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 1_000_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 5)

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-arrow-'))
const conn = await connect(join(dir, 'bench.zu1'))

await conn.exec("INSERT (p:person {uid: 1, score: 1.5, name: 'n1'})")
{
  const rows = await conn.appender('person')
  for (let ix = 2; ix <= ROWS; ix++) rows.appendRow([BigInt(ix), ix / 3, `n${ix}`])
  await rows.close()
}

// The fastest of `REPEATS` runs, in milliseconds, after one warmup, for
// the reason bench/query.mjs gives: everything that makes a run slower
// than the work itself is something that happened to it rather than
// something about it.
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

const ONE = 'MATCH (p:person) RETURN p.uid AS uid'
const THREE = 'MATCH (p:person) RETURN p.uid AS uid, p.score AS score, p.name AS name'

const cases = [
  { name: 'one integer column, arrow', run: () => conn.arrow(ONE) },
  { name: 'one integer column, columnar', run: () => conn.columnar(ONE) },
  { name: 'one integer column, rows', run: () => conn.query(ONE) },
  { name: 'three columns, arrow', run: () => conn.arrow(THREE) },
  { name: 'three columns, columnar', run: () => conn.columnar(THREE) },
  { name: 'three columns, rows', run: () => conn.query(THREE) },
]

console.log(`reading ${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, run } of cases) report(name, await time(run))

// What a caller does next, which is the half the calls above do not
// include. The bytes are read once here and decoded every round, so what
// is timed is the decode and not the statement.
const bytes = (await conn.arrow(THREE)).ipc

console.log('')
console.log('turning what came back into a table')
report('tableFromIPC over the bytes', await time(async () => tableFromIPC(bytes)))

// A batch is a slice of arrays that are already built, so the size is
// about what the reader holds at once rather than about the write. This
// says by how much, which is the answer to whether it is worth tuning.
console.log('')
console.log('the batch size the stream is cut into')
for (const batchRows of [4_096, 65_536, 1_000_000]) {
  report(`batchRows ${batchRows}`, await time(() => conn.arrow(THREE, null, { batchRows })))
}

await conn.close()
await rm(dir, { recursive: true, force: true })
