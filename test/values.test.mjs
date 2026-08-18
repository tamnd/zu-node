import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuDate, ZuDuration, ZuTime, ZuTimestamp } from '../index.js'
import { fresh, twoPeople } from './helper.mjs'

// What a parameter binds as is what comes back, so one statement that
// returns what it was given tests both directions at once.
async function roundTrip(conn, value) {
  const rows = await conn.query('RETURN $v AS v', { v: value })
  return rows[0].v
}

test('an INT64 is a bigint, going out and coming back', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id ORDER BY id')
  assert.equal(typeof rows[0].id, 'bigint')
  assert.equal(rows[0].id, 1n)

  // 2^53 + 1, which is the first integer a JavaScript number cannot
  // tell from its neighbour and the reason this is a bigint at all.
  assert.equal(await roundTrip(conn, 9007199254740993n), 9007199254740993n)
  assert.equal(await roundTrip(conn, -9223372036854775808n), -9223372036854775808n)
  assert.equal(await roundTrip(conn, 9223372036854775807n), 9223372036854775807n)
})

test('a bigint outside what INT64 holds is refused by name', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(() => roundTrip(conn, 9223372036854775808n), (err) => {
    assert.equal(err.name, 'ZuUsageError')
    assert.match(err.message, /outside what INT64 holds/)
    // Named, so a caller with twenty parameters knows which one.
    assert.match(err.message, /\bv\b/)
    return true
  })
})

test('a whole number binds as an integer and a fractional one as a float', async (t) => {
  const { conn } = await fresh(t)

  // `{ id: 1 }` is what anybody writes, and binding it as a float would
  // make it fail to match a row whose id is an integer.
  assert.equal(await roundTrip(conn, 1), 1n)
  assert.equal(typeof (await roundTrip(conn, 1)), 'bigint')
  assert.equal(await roundTrip(conn, 1.5), 1.5)
  assert.equal(typeof (await roundTrip(conn, 1.5)), 'number')
})

test('a string, a boolean, a null and an undefined bind as themselves', async (t) => {
  const { conn } = await fresh(t)

  assert.equal(await roundTrip(conn, 'ada'), 'ada')
  assert.equal(await roundTrip(conn, ''), '')
  assert.equal(await roundTrip(conn, true), true)
  assert.equal(await roundTrip(conn, false), false)
  assert.equal(await roundTrip(conn, null), null)
  // A field that is not there and a field that is null are the same
  // thing to a statement, which is what makes an optional field of a
  // plain object pass straight through.
  assert.equal(await roundTrip(conn, undefined), null)
})

test('a list and a record bind as a list and a record, however deep', async (t) => {
  const { conn } = await fresh(t)

  assert.deepEqual(await roundTrip(conn, [1n, 2n, 3n]), [1n, 2n, 3n])
  assert.deepEqual(await roundTrip(conn, []), [])
  assert.deepEqual(await roundTrip(conn, { a: 1n, b: 'x' }), { a: 1n, b: 'x' })
  assert.deepEqual(await roundTrip(conn, { a: [1n, { b: null }] }), { a: [1n, { b: null }] })
})

test('a parameter of a type nothing can bind is refused on the call that passed it', async (t) => {
  const { conn } = await fresh(t)

  for (const value of [() => {}, Symbol('nope')]) {
    await assert.rejects(() => roundTrip(conn, value), (err) => {
      assert.equal(err.name, 'ZuUsageError')
      assert.match(err.message, /\bv\b/)
      return true
    })
  }
})

test('a date is days from the epoch, both ways', async (t) => {
  const { conn } = await fresh(t)

  const back = await roundTrip(conn, new ZuDate(19723))
  assert.ok(back instanceof ZuDate)
  assert.equal(back.days, 19723)
  assert.deepEqual(back.toJSON(), { days: 19723 })

  const literal = (await conn.query("RETURN DATE '2024-01-01' AS d"))[0].d
  assert.ok(literal instanceof ZuDate)
  assert.equal(literal.days, 19723)
})

test('a time keeps its offset, and a local one keeps not having any', async (t) => {
  const { conn } = await fresh(t)

  const local = await roundTrip(conn, new ZuTime(3600000000000n, null))
  assert.ok(local instanceof ZuTime)
  assert.equal(local.nanos, 3600000000000n)
  // Not zero. Zero is UTC, which is a zone, and a local time is in none.
  assert.equal(local.offset, null)

  const zoned = await roundTrip(conn, new ZuTime(3600000000000n, 120))
  assert.equal(zoned.offset, 120)
  assert.deepEqual(zoned.toJSON(), { nanos: 3600000000000n, offset: 120 })
})

test('a timestamp keeps its instant to the nanosecond', async (t) => {
  const { conn } = await fresh(t)

  const local = await roundTrip(conn, new ZuTimestamp(1700000000123456789n, null))
  assert.ok(local instanceof ZuTimestamp)
  assert.equal(local.nanos, 1700000000123456789n)
  assert.equal(local.offset, null)

  const zoned = await roundTrip(conn, new ZuTimestamp(1700000000123456789n, -480))
  assert.equal(zoned.offset, -480)
})

test('a duration is months or nanoseconds and never both', async (t) => {
  const { conn } = await fresh(t)

  const months = await roundTrip(conn, ZuDuration.ofMonths(14n))
  assert.ok(months instanceof ZuDuration)
  assert.equal(months.kind, 'yearMonth')
  assert.equal(months.months, 14n)
  assert.equal(months.nanos, 0n)

  const nanos = await roundTrip(conn, ZuDuration.ofNanos(90000000000n))
  assert.equal(nanos.kind, 'dayTime')
  assert.equal(nanos.months, 0n)
  assert.equal(nanos.nanos, 90000000000n)
})

test('a plain object shaped like a date is a record, not a date', async (t) => {
  const { conn } = await fresh(t)

  const back = await roundTrip(conn, { days: 19723 })

  assert.ok(!(back instanceof ZuDate))
  assert.deepEqual(back, { days: 19723n })
})
