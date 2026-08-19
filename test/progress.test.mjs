// Watching a statement that is still running.
//
// The counter is the engine's, read from the loop's thread while the
// statement holds a threadpool thread, so what these ask is whether the
// number moves during the statement rather than after it, whether the
// callback is quiet when the number is not moving, and whether a watch
// nobody stopped costs the program anything.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { connect, load } from 'zudb'

import { twoPeople } from './helper.mjs'

// Every pair of people, filtered, which is a statement that spends real
// time in the executor and reads its rows out of storage while it does.
// The filter is what keeps it honest: without one the optimizer answers
// a cross product by arithmetic and never reads a second row.
const WORK = 'MATCH (a:person), (b:person) WHERE a.uid < b.uid RETURN count(a) AS n'

// Enough people that the statement above takes a few hundred
// milliseconds and reads its rows in several pieces rather than one, so
// there is something for a watch to see more than once. The scan is
// claimed a morsel at a time and the counter moves a morsel at a time
// with it.
const PEOPLE = 3000

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms))

// A database with a crowd in it, built by a load rather than by an
// insert, because three thousand people written as one statement is a
// megabyte of GQL and most of this file's time would go on parsing it.
async function crowd(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-progress-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'crowd.zu1')
  await load(path, {
    nodes: 'person',
    columns: { uid: Array.from({ length: PEOPLE }, (_, ix) => ix + 1) },
  })
  const conn = await connect(path, { readOnly: true })
  t.after(() => conn.close())
  return { conn, path }
}

test('rows read moves while the statement reading them runs', async (t) => {
  const { conn } = await crowd(t)

  const running = conn.query(WORK)
  await sleep(50)

  // The read itself is half the claim: it happens on the loop's thread
  // while the statement holds the connection's lock, so it answers here
  // rather than after the statement has let the lock go.
  const midway = conn.rowsRead
  assert.ok(midway > 0, `a statement 50ms into its run had read ${midway} rows`)

  await running
  assert.ok(conn.rowsRead >= midway, 'the count went backwards')
})

test('rows read holds what the last statement cost and starts again at the next', async (t) => {
  const { conn } = await twoPeople(t)

  await conn.query('MATCH (p:person) RETURN p.name AS name')
  const first = conn.rowsRead
  assert.ok(first >= 2, `two people came back as ${first} rows read`)

  // Held rather than cleared, so a caller who wants to know what the
  // statement they just ran cost can ask afterwards.
  assert.equal(conn.rowsRead, first)

  // The same statement again reads the same rows, so a counter that
  // started over reads the same number and one that kept counting reads
  // twice it.
  await conn.query('MATCH (p:person) RETURN p.name AS name')
  assert.equal(conn.rowsRead, first)
})

test('rows read is a number rather than a bigint', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.query('MATCH (p:person) RETURN p.name AS name')

  // Every value a statement gives back is a bigint and every count this
  // client makes is a number. This is a count.
  assert.equal(typeof conn.rowsRead, 'number')
  assert.ok(Number.isInteger(conn.rowsRead))
})

test('a watch is called with the rows as they are read', async (t) => {
  const { conn } = await crowd(t)

  const seen = []
  const watch = conn.progress((rows) => seen.push(rows), { everyMs: 10 })
  await conn.query(WORK)
  watch.stop()

  assert.ok(seen.length >= 2, `the watch was called ${seen.length} times during the statement`)
  assert.ok(
    seen.every((rows) => typeof rows === 'number' && rows > 0),
    `a call carried something other than a count: ${seen.join(', ')}`,
  )
  // Rows read only goes up inside a statement, so counts that went down
  // would mean the watch was reading something else.
  const climbing = seen.every((rows, ix) => ix === 0 || rows >= seen[ix - 1])
  assert.ok(climbing, `the counts went backwards: ${seen.join(', ')}`)
})

test('a watch says nothing while the connection is idle', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.query('MATCH (p:person) RETURN p.name AS name')

  // The number a finished statement left behind is not news, and a
  // progress bar redrawn five times a second on a connection nobody is
  // using is what the callback is kept quiet for.
  const seen = []
  const watch = conn.progress((rows) => seen.push(rows), { everyMs: 5 })
  await sleep(60)
  watch.stop()

  assert.deepEqual(seen, [])
})

test('the interval is the one the caller named, and a long one never fires', async (t) => {
  const { conn } = await crowd(t)

  const often = []
  const rarely = []
  const first = conn.progress((rows) => often.push(rows))
  await conn.query(WORK)
  first.stop()

  const second = conn.progress((rows) => rarely.push(rows), { everyMs: 60_000 })
  await conn.query(WORK)
  second.stop()

  // The default is short enough to see a statement of a few hundred
  // milliseconds, which is the whole reason there is a default.
  assert.ok(often.length >= 1, 'the default interval saw nothing')
  assert.deepEqual(rarely, [], 'an interval longer than the statement fired anyway')
})

test('a stopped watch stops calling, and stopping twice is not an error', async (t) => {
  const { conn } = await crowd(t)

  const seen = []
  const watch = conn.progress((rows) => seen.push(rows), { everyMs: 5 })
  const running = conn.query(WORK)
  await sleep(80)
  watch.stop()
  watch.stop()
  const before = seen.length
  assert.ok(before > 0, 'the watch saw nothing before it was stopped')

  await running
  await sleep(30)
  assert.equal(seen.length, before, 'a stopped watch was called again')
})

test('leaving the scope of a using stops the watch', async (t) => {
  const { conn } = await crowd(t)
  const seen = []

  async function watched() {
    using watch = conn.progress((rows) => seen.push(rows), { everyMs: 5 })
    assert.equal(typeof watch.stop, 'function')
    await conn.query(WORK)
  }

  await watched()
  const counted = seen.length
  assert.ok(counted > 0, 'the watch saw nothing inside the block')

  // Nothing is left running past the block, which is the reason to
  // write `using` rather than a `stop()` in a `finally`.
  await conn.query(WORK)
  assert.equal(seen.length, counted, 'the watch outlived its block')
})

test('a watch wants a function, and an interval that is one', async (t) => {
  const { conn } = await twoPeople(t)

  for (const bad of [null, undefined, 42, 'later', {}]) {
    assert.throws(() => conn.progress(bad), TypeError, `a ${typeof bad} was taken as a callback`)
  }

  const noop = () => {}
  for (const everyMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100', {}]) {
    assert.throws(
      () => conn.progress(noop, { everyMs }),
      RangeError,
      `${String(everyMs)} was taken as an interval`,
    )
  }

  // The ways of saying nothing, all of which take the default.
  for (const options of [null, undefined, {}, { everyMs: undefined }]) {
    conn.progress(noop, options).stop()
  }
})

test('a watch does not hold the program open', async (t) => {
  const { path } = await crowd(t)

  // A watch nobody stopped is a timer that would otherwise run for as
  // long as the process does, which is a program that prints its answer
  // and then hangs. Only another process can be asked whether it
  // exited.
  const program = `
    const { connect } = require(${JSON.stringify(root)})
    connect(${JSON.stringify(path)}, { readOnly: true }).then(async (conn) => {
      conn.progress(() => {}, { everyMs: 5 })
      await conn.query('MATCH (p:person) RETURN count(*) AS n')
      console.log('done')
    })
  `
  const { stdout } = await run(process.execPath, ['-e', program], { timeout: 30_000 })
  assert.equal(stdout.trim(), 'done')
})
