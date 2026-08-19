// What preparing a statement costs and what it saves.
//
// The answer is not the one a driver would give, and this exists to
// print that rather than to hide it. A driver prepares to save a round
// trip; there is no round trip here, and the engine caches the plan for
// a statement by its text, so the second `conn.query` of the same string
// is already not being compiled a second time. The two lines of the
// first pair should therefore land close together, and if `prepared` is
// a shade behind that is the id being looked up and the text cloned.
//
// The line worth reading is the third: a statement whose text is
// different every time, which is what a program that pastes its values
// into the string is doing. That one pays the whole compile per run, and
// the gap between it and the other two is the size of the mistake.
//
// The last block is the prepare itself, which is the compile a program
// pays once at startup so that no request pays it.
//
// Run it against a release build, for the reason bench/query.mjs gives.
//
//   npm run build && npm run bench:prepared

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect } from 'zudb'

const ROWS = Number(process.env.ZU_BENCH_ROWS ?? 10_000)
const RUNS = Number(process.env.ZU_BENCH_RUNS ?? 2_000)
const REPEATS = Number(process.env.ZU_BENCH_REPEATS ?? 5)

const dir = await mkdtemp(join(tmpdir(), 'zu-bench-prepared-'))
const conn = await connect(join(dir, 'bench.zu1'))

await conn.exec("INSERT (p:person {uid: 1, name: 'n1'})")
{
  const rows = await conn.appender('person')
  for (let ix = 2; ix <= ROWS; ix++) rows.appendRow([BigInt(ix), `n${ix}`])
  await rows.close()
}

/// The fastest of `REPEATS` runs, in milliseconds, after one warmup.
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

function report(name, ms, each) {
  console.log(
    `${name.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  ${Math.round((ms * 1e6) / each)
      .toString()
      .padStart(7)} ns each`,
  )
}

const find = await conn.prepare('MATCH (p:person) WHERE p.name = $name RETURN p.uid AS uid')

/// A number that never repeats, for the case that wants a statement the
/// plan cache has never seen.
let stamp = 0

const cases = [
  {
    name: 'prepared, bound per run',
    run: async () => {
      for (let ix = 0; ix < RUNS; ix++) await find.query({ name: `n${(ix % ROWS) + 1}` })
    },
  },
  {
    name: 'the same text, bound per run',
    run: async () => {
      for (let ix = 0; ix < RUNS; ix++)
        await conn.query('MATCH (p:person) WHERE p.name = $name RETURN p.uid AS uid', {
          name: `n${(ix % ROWS) + 1}`,
        })
    },
  },
  {
    name: 'a new text per run',
    // The alias carries a counter that never repeats, so every one of
    // these is a text the plan cache has not seen. A statement that
    // pastes its values in rather than binding them is only this slow
    // once the values stop repeating, which in a program serving
    // requests is immediately.
    run: async () => {
      for (let ix = 0; ix < RUNS; ix++)
        await conn.query(
          `MATCH (p:person) WHERE p.name = 'n${(ix % ROWS) + 1}' RETURN p.uid AS uid${stamp++}`,
        )
    },
  },
]

console.log(`${RUNS} runs over ${ROWS} rows, fastest of ${REPEATS}`)
for (const { name, run } of cases) report(name, await time(run), RUNS)

// The compile, which is what a program pays at startup so that no
// request pays it. Every prepare is closed again, since a bench that
// leaked two thousand of them would be measuring the map they went into.
console.log('')
console.log('preparing itself')
report(
  'prepare and close',
  await time(async () => {
    for (let ix = 0; ix < 100; ix++) {
      const statement = await conn.prepare(
        'MATCH (p:person) WHERE p.name = $name RETURN p.uid AS uid',
      )
      await statement.close()
    }
  }),
  100,
)
report(
  'explain',
  await time(async () => {
    for (let ix = 0; ix < 100; ix++)
      await conn.explain('MATCH (p:person) WHERE p.name = $name RETURN p.uid AS uid')
  }),
  100,
)

await find.close()
await conn.close()
await rm(dir, { recursive: true, force: true })
