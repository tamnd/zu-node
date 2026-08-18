// What a statement costs on the JavaScript side of the boundary.
//
// The engine's own numbers live in tamnd/zu and are measured there.
// What this measures is what this package adds to them: the promise, the
// lock, the row objects, and one JavaScript value per column per row.
// That last one is the whole cost of a large result and the reason the
// numbers below are per row rather than per statement.
//
// Run it against a release build. A debug build of the engine is an
// order of magnitude slower and the ratio between these rows is not the
// same one, so a debug number is not a slow measurement of the right
// thing.
//
//   npm run build && npm run bench

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 50_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 9)
// One statement per row is a write per row, and this is not a write
// benchmark. A batch big enough to amortize that and small enough to
// parse quickly is what gets the fixture built.
const BATCH = 500

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-'))
const conn = await connect(join(dir, 'bench.zu1'))

// The declaring insert is written with literals, because that is what
// tells the engine what each column holds.
await conn.exec("INSERT (p:person {id: 0, name: 'n0'})")
for (let start = 1; start < ROWS; start += BATCH) {
  const end = Math.min(start + BATCH, ROWS)
  const parts = []
  for (let ix = start; ix < end; ix++) parts.push(`(p${ix}:person {id: ${ix}, name: 'n${ix}'})`)
  await conn.exec(`INSERT ${parts.join(', ')}`)
}

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
///
/// The fastest rather than the mean or the median, because everything
/// that makes a run slower than the statement itself is something that
/// happened to it: a collection, another process, a core that clocked
/// down. On this machine the mean of nine runs moves by a factor of
/// three between invocations and the fastest moves by a tenth, so the
/// fastest is the number a change can be compared across.
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

// A signal nobody ever fires, which is the shape almost every signal
// passed to a database has.
const idle = new AbortController()

const cases = [
  {
    name: 'scan, two columns',
    per: 'row',
    run: () => conn.query('MATCH (p:person) RETURN p.id AS id, p.name AS name'),
  },
  {
    name: 'scan, one INT64 column',
    per: 'row',
    run: () => conn.query('MATCH (p:person) RETURN p.id AS id'),
  },
  {
    // The same column spelled as a number instead of a `bigint`, which
    // is the cost the other mode is usually asked for: a `bigint` is an
    // allocation and a double is not, so the difference between these
    // two is what a program buys with the hazard it takes on.
    name: 'scan, one INT64 as a number',
    per: 'row',
    run: () =>
      conn.query('MATCH (p:person) RETURN p.id AS id', null, { bigIntMode: 'number' }),
  },
  {
    name: 'scan, whole nodes',
    per: 'row',
    run: () => conn.query('MATCH (p:person) RETURN p AS p'),
  },
  {
    name: 'scan, rows dropped',
    per: 'row',
    run: () => conn.exec('MATCH (p:person) RETURN p.id AS id, p.name AS name'),
  },
  {
    // The same rows through the streaming path, which is the number to
    // read the two scans above against: what streaming costs is a
    // thread, a queue and a promise per batch, and what it saves is
    // holding the whole result. A stream read to the end is the worst
    // case for it, since nothing was saved and everything was paid.
    name: 'stream, two columns',
    per: 'row',
    run: async () => {
      const stream = conn.stream('MATCH (p:person) RETURN p.id AS id, p.name AS name')
      for await (const row of stream) void row
    },
  },
  {
    // A batch at a time rather than a row at a time, which is the same
    // rows with one less iterator between them and the loop.
    name: 'stream, batch at a time',
    per: 'row',
    run: async () => {
      const stream = conn.stream('MATCH (p:person) RETURN p.id AS id, p.name AS name')
      for await (const batch of stream.batches()) void batch
    },
  },
  {
    // What a reader that stops after one batch pays, which is what a
    // stream is for: the scan under it ends, so this is a statement
    // whose cost is the batch rather than the table. Per statement,
    // because the rows it read are a batch and not the table.
    name: 'stream, first batch only',
    per: 'statement',
    run: async () => {
      const stream = conn.stream('MATCH (p:person) RETURN p.id AS id, p.name AS name')
      for await (const batch of stream.batches()) {
        void batch
        break
      }
    },
  },
  {
    name: 'aggregate, one row out',
    per: 'statement',
    run: () => conn.query('MATCH (p:person) RETURN count(*) AS n'),
  },
  {
    // What watching a signal costs a statement nobody stops, which is
    // every statement in a server that passes the request's signal down.
    // A listener added and taken off again, once per statement and not
    // once per row, so the number to read this against is the one above.
    name: 'aggregate, one signal in',
    per: 'statement',
    run: () => conn.query('MATCH (p:person) RETURN count(*) AS n', null, { signal: idle.signal }),
  },
  {
    name: 'aggregate, one parameter in',
    per: 'statement',
    run: () => conn.query('MATCH (p:person) WHERE p.name = $name RETURN count(*) AS n', {
      name: 'n1',
    }),
  },
]

console.log(`${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, per, run } of cases) {
  const ms = await time(run)
  const each = per === 'row' ? (ms * 1e6) / ROWS : ms * 1e6
  console.log(
    `${name.padEnd(28)} ${ms.toFixed(2).padStart(9)} ms  ${Math.round(each).toString().padStart(9)} ns/${per}`,
  )
}

conn.close()
await rm(dir, { recursive: true, force: true })
