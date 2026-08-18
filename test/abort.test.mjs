// Stopping a statement with the signal every JavaScript program already
// has.

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import { fresh, isZuError, twoPeople } from './helper.mjs'

// A statement that is still running a moment after it was asked for,
// which is the only kind there is anything to interrupt. Every triple of
// people, which is a cross product rather than anything a person would
// write, because the point is to spend time in the executor and not to
// mean something.
const HEAVY = 'MATCH (a:person), (b:person), (c:person) RETURN count(a.name + b.name) AS n'

// Enough of them that the statement above takes hundreds of milliseconds
// even where the engine is fastest, since a statement that finishes in
// the time a timer takes to fire is one no test can catch in the middle.
// It is cubed, so this is a bigger number than it looks.
const PEOPLE = 450

async function crowd(t) {
  const made = await fresh(t)
  await made.conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  const rest = Array.from(
    { length: PEOPLE - 1 },
    (_, ix) => `(p${ix}:person {id: ${ix + 2}, name: 'p${ix}'})`,
  ).join(', ')
  await made.conn.exec(`INSERT ${rest}`)
  return made
}

// How long the heavy statement takes when nobody stops it, measured here
// rather than written down, because a debug build on a busy laptop and a
// release build on a quiet machine are two orders of magnitude apart and
// a number chosen for one of them is a test that fails on the other.
// What the tests then assert is a ratio: asked to stop a tenth of the way
// through, a statement comes back long before it would have finished.
async function pace(conn) {
  const started = process.hrtime.bigint()
  await conn.query(HEAVY)
  return Number(process.hrtime.bigint() - started) / 1e6
}

function ms(started) {
  return Number(process.hrtime.bigint() - started) / 1e6
}

// A tenth of the way through, in whole milliseconds, since that is what
// a timer takes.
function early(plain) {
  return Math.max(5, Math.round(plain / 10))
}

test('a signal that has already fired stops the statement before the engine sees it', async (t) => {
  const { conn } = await twoPeople(t)

  const err = await conn
    .query('MATCH (p:person) RETURN p.name AS name', null, { signal: AbortSignal.abort() })
    .then(() => null, (caught) => caught)

  assert.ok(err instanceof Error)
  assert.equal(err.name, 'AbortError')
})

test('the promise rejects with the reason the signal was given', async (t) => {
  const { conn } = await twoPeople(t)
  const mine = new Error('the request went away')
  const controller = new AbortController()
  controller.abort(mine)

  const err = await conn
    .query('MATCH (p:person) RETURN p.name AS name', null, { signal: controller.signal })
    .then(() => null, (caught) => caught)

  // The caller's own object, not a description of it, which is what
  // makes an existing `catch` work unchanged.
  assert.equal(err, mine)
})

test('a signal that fires during a statement stops it, and the connection carries on', async (t) => {
  const { conn } = await crowd(t)
  const plain = await pace(conn)
  const controller = new AbortController()

  const started = process.hrtime.bigint()
  const running = conn.query(HEAVY, null, { signal: controller.signal })
  setTimeout(() => controller.abort(), early(plain))
  const err = await running.then(() => null, (caught) => caught)
  const took = ms(started)

  assert.equal(err?.name, 'AbortError')
  assert.ok(took < plain / 2, `took ${took}ms of the ${plain}ms it takes to run, so it ran on`)

  // The interrupt belongs to the connection rather than to the statement,
  // so the statement after an abort is the one that would suffer if it
  // were left standing.
  const rows = await conn.query('MATCH (p:person) RETURN count(*) AS n')
  assert.equal(rows[0].n, BigInt(PEOPLE))
})

test('a timeout is a signal like any other', async (t) => {
  const { conn } = await crowd(t)
  const plain = await pace(conn)

  const started = process.hrtime.bigint()
  const err = await conn
    .query(HEAVY, null, { signal: AbortSignal.timeout(early(plain)) })
    .then(() => null, (caught) => caught)
  const took = ms(started)

  // What `AbortSignal.timeout` puts on the signal, arriving unchanged,
  // which is the whole of what a statement timeout has to be in this
  // client.
  assert.equal(err?.name, 'TimeoutError')
  assert.ok(took < plain / 2, `took ${took}ms of the ${plain}ms it takes to run, so it ran on`)

  const rows = await conn.query('MATCH (p:person) RETURN count(*) AS n')
  assert.equal(rows[0].n, BigInt(PEOPLE))
})

test('exec takes a signal on the same terms', async (t) => {
  const { conn } = await crowd(t)
  const plain = await pace(conn)

  const started = process.hrtime.bigint()
  const err = await conn
    .exec(HEAVY, null, { signal: AbortSignal.timeout(early(plain)) })
    .then(() => null, (caught) => caught)

  assert.equal(err?.name, 'TimeoutError')
  assert.ok(ms(started) < plain / 2)
})

test('a signal that never fires is left as it was found', async (t) => {
  const { conn } = await twoPeople(t)
  const controller = new AbortController()

  // A request handler's signal outlives the statements run under it,
  // often by a whole request, so a listener left behind is a leak that
  // grows with the traffic rather than with the code.
  for (let round = 0; round < 8; round += 1) {
    await conn.query('MATCH (p:person) RETURN p.name AS name', null, { signal: controller.signal })
    await conn.exec('MATCH (p:person) RETURN p.name AS name', null, { signal: controller.signal })
  }

  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('a statement that fails on its own is not mistaken for one that was stopped', async (t) => {
  const { conn } = await twoPeople(t)
  const controller = new AbortController()

  const err = await conn
    .query('MATCH (p:person) RETURN p.nope +', null, { signal: controller.signal })
    .then(() => null, (caught) => caught)

  assert.ok(isZuError(err, 'ZuSyntaxError'))
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('options without a signal, and a signal that is not one, are told apart', async (t) => {
  const { conn } = await twoPeople(t)
  const statement = 'MATCH (p:person) RETURN p.name AS name'

  // The ways of saying nothing, all of which run the statement.
  for (const options of [null, undefined, {}, { signal: null }, { signal: undefined }]) {
    const rows = await conn.query(statement, null, options)
    assert.equal(rows.length, 2)
  }

  for (const signal of [42, 'later', {}, new Date()]) {
    const err = await conn
      .query(statement, null, { signal })
      .then(() => null, (caught) => caught)
    assert.ok(isZuError(err, 'ZuUsageError'), `a ${typeof signal} signal was accepted`)
    assert.match(err.message, /AbortSignal/)
  }
})
