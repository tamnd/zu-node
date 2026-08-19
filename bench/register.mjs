// What registering a frame costs, and what reading one costs after.
//
// The claim the call makes is that nothing is copied, so the first block
// here is the one that has to hold: registering ten rows and registering
// ten million should cost the same, because what happens is that the
// engine is told where the columns are. A line in that block that scales
// with the rows is a line that copied them.
//
// Three cases do copy and all three are here rather than hidden. A string
// column is walked once, to check every offset at registration so that
// reading it afterwards cannot fail. A table that arrived as several
// batches is concatenated, because a column of a frame is one run of
// bytes and two batches are two of them. A plain JavaScript array is read
// into a buffer of this client's own, because an array holds values
// rather than numbers and there is nothing in it to point at.
//
// The second block is the reason to register at all: a statement reading
// a frame against the same statement reading a table of the database.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:register

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Table, Utf8, tableFromArrays, vectorFromArray } from 'apache-arrow'
import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 1_000_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 5)
// The small frame, for the pair of lines that says registration does not
// scale with the rows. Ten is small enough that anything proportional to
// the rows disappears from it.
const FEW = 10

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-register-'))

const uid = BigInt64Array.from({ length: ROWS }, (_, ix) => BigInt(ix))
const score = Float64Array.from({ length: ROWS }, (_, ix) => ix / 3)
const name = Array.from({ length: ROWS }, (_, ix) => `n${ix}`)
const plain = Array.from({ length: ROWS }, (_, ix) => ix)

const wide = { uid, score }
const small = { uid: uid.subarray(0, FEW), score: score.subarray(0, FEW) }
const words = tableFromArrays({ name: vectorFromArray(name, new Utf8()) })
const arrow = tableFromArrays({ uid, score })
const halves = (() => {
  const cut = ROWS >> 1
  const first = tableFromArrays({ uid: uid.slice(0, cut) }).batches[0]
  const second = tableFromArrays({ uid: uid.slice(cut) }).batches[0]
  return new Table([first, second])
})()

let counter = 0

/// A connection with nothing in it.
async function blank() {
  return await connect(join(dir, `bench-${counter++}.zu1`))
}

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
///
/// The fastest for the reason bench/query.mjs gives: everything that
/// makes a run slower than the work itself is something that happened to
/// it rather than something about it.
async function time(conn, run) {
  await run(conn)
  let best = Infinity
  for (let round = 0; round < REPEATS; round++) {
    const started = performance.now()
    await run(conn)
    best = Math.min(best, performance.now() - started)
  }
  return best
}

/// One registration, and what it costs is one promise round trip as well
/// as the work, because nothing here runs on the thread that called it.
/// The rounds after the first replace the name rather than taking it
/// away, which is the same description being built again and is what a
/// program rerunning the same cell does anyway.
function once(frame) {
  return async (conn) => {
    await conn.register('frame', frame)
  }
}

const registering = [
  // The floor, which is a call that takes the lock and answers a list of
  // one name. Every line under it carries the same round trip, so this
  // is what to subtract before believing any of them.
  { name: 'the round trip alone', rows: 1, run: (conn) => conn.registered() },
  { name: `typed arrays, ${FEW} rows`, rows: FEW, run: once(small) },
  { name: 'typed arrays', rows: ROWS, run: once(wide) },
  { name: 'arrow table', rows: ROWS, run: once(arrow) },
  { name: 'arrow, two batches', rows: ROWS, run: once(halves) },
  { name: 'arrow strings', rows: ROWS, run: once(words) },
  { name: 'plain array', rows: ROWS, run: once({ n: plain }) },
]

const conn = await blank()
console.log(`registering ${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, rows, run } of registering) {
  const ms = await time(conn, run)
  if (rows === 1) {
    console.log(`${name.padEnd(24)} ${ms.toFixed(3).padStart(9)} ms`)
    continue
  }
  const each = (ms * 1e6) / rows
  const scale = rows === ROWS ? '' : ` (over ${rows})`
  console.log(
    `${name.padEnd(24)} ${ms.toFixed(3).padStart(9)} ms  ${Math.round(each).toString().padStart(7)} ns/row${scale}`,
  )
}
conn.close()

// The same rows twice, once as a frame the caller holds and once as a
// table the database holds, so that the two lines of each pair are the
// same statement over the same values.
const stored = await blank()
{
  await stored.exec("INSERT (p:person {uid: 0, name: 'n0'})")
  const rows = await stored.appender('person')
  for (let ix = 1; ix < ROWS; ix++) rows.appendRow([uid[ix], name[ix]])
  await rows.close()
}
await stored.register('frame', {
  uid,
  name,
})

const hunted = `n${ROWS - 1}`
const reading = [
  {
    name: 'sum an integer column',
    frame: 'MATCH (p:frame) RETURN sum(p.uid) AS total',
    table: 'MATCH (p:person) RETURN sum(p.uid) AS total',
  },
  {
    name: 'find a row by string',
    frame: `MATCH (p:frame) WHERE p.name = '${hunted}' RETURN p.uid AS uid`,
    table: `MATCH (p:person) WHERE p.name = '${hunted}' RETURN p.uid AS uid`,
  },
]

console.log(`\nreading ${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, frame, table } of reading) {
  const asFrame = await time(stored, (conn) => conn.query(frame))
  const asTable = await time(stored, (conn) => conn.query(table))
  console.log(
    `${name.padEnd(24)} ${asFrame.toFixed(3).padStart(9)} ms frame  ${asTable.toFixed(3).padStart(9)} ms table`,
  )
}

stored.close()
await rm(dir, { recursive: true, force: true })
