// Temporal, both ways.
//
// The file runs on a runtime that has `Temporal` and on one that does
// not, and it asserts something in both cases, because both are
// supported and the second one is most of them: Node 24 is the active
// LTS and has `Temporal` only behind `--harmony-temporal`. What a
// runtime without one has to do is refuse clearly and keep working, and
// that is as much a feature as the conversions are.
//
//   npm test              the runtime as it comes
//   npm run test:temporal the same tests with the flag on
//
// The values are asserted field by field rather than by their printed
// form, because the proposal changed under the runtimes twice and the
// fields are the part that did not move.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { connect, ZuDate, ZuDuration, ZuTime, ZuTimestamp } from 'zudb'

import { fresh, isZuError } from './helper.mjs'

const HAS_TEMPORAL = typeof globalThis.Temporal !== 'undefined'
const has = { skip: HAS_TEMPORAL ? false : 'this runtime has no Temporal' }
const hasNot = { skip: HAS_TEMPORAL ? 'this runtime has Temporal' : false }

// 2023-11-14T22:13:20.123456789Z, which is a whole second of the epoch
// with every one of the nine digits under it different, so a conversion
// that drops the microseconds or rounds the nanoseconds says so.
const INSTANT = 1700000000123456789n
const DAYS = 19723 // 2024-01-01

// What a value calls itself, which is the one way of asking that every
// version of the proposal answers the same.
function tag(value) {
  return Object.prototype.toString.call(value)
}

async function one(conn, value) {
  const rows = await conn.query('RETURN $v AS v', { v: value })
  return rows[0].v
}

test('a connection that asked for Temporal gets Temporal values', has, async (t) => {
  const { conn } = await fresh(t, { temporal: true })

  const date = await one(conn, new ZuDate(DAYS))
  assert.equal(tag(date), '[object Temporal.PlainDate]')
  assert.deepEqual([date.year, date.month, date.day], [2024, 1, 1])

  const time = await one(conn, new ZuTime(3600000000001n, null))
  assert.equal(tag(time), '[object Temporal.PlainTime]')
  assert.deepEqual([time.hour, time.minute, time.nanosecond], [1, 0, 1])

  const stamp = await one(conn, new ZuTimestamp(INSTANT, null))
  assert.equal(tag(stamp), '[object Temporal.PlainDateTime]')
  assert.deepEqual(
    [stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute, stamp.second],
    [2023, 11, 14, 22, 13, 20],
  )
  assert.deepEqual([stamp.millisecond, stamp.microsecond, stamp.nanosecond], [123, 456, 789])

  const zoned = await one(conn, new ZuTimestamp(INSTANT, -480))
  assert.equal(tag(zoned), '[object Temporal.ZonedDateTime]')
  assert.equal(zoned.epochNanoseconds, INSTANT)
  // The offset it was written at and never a named zone, because a name
  // is a rule that changes under a stored value when the zone database
  // is updated and the engine stores no name.
  assert.equal(zoned.offset, '-08:00')

  const months = await one(conn, ZuDuration.ofMonths(14n))
  assert.equal(tag(months), '[object Temporal.Duration]')
  assert.deepEqual([months.years, months.months, months.days], [0, 14, 0])

  const nanos = await one(conn, ZuDuration.ofNanos(90000000005n))
  assert.deepEqual([nanos.months, nanos.seconds, nanos.nanoseconds], [0, 90, 5])
})

test('a time with an offset keeps its class, and says why', has, async (t) => {
  const { conn } = await fresh(t, { temporal: true })

  // The one hole in the mode, and it is the standard's: PlainTime is
  // local and ZonedDateTime carries a date, so the alternatives are
  // dropping the offset or inventing a day.
  const zoned = await one(conn, new ZuTime(3600000000001n, 120))
  assert.ok(zoned instanceof ZuTime)
  assert.equal(zoned.offset, 120)
  assert.throws(
    () => zoned.toTemporal(),
    (err) => isZuError(err, 'ZuUsageError') && /no Temporal type/.test(err.message),
  )

  // And the local one beside it converts, so this is a hole and not a
  // class that stopped working.
  const local = await one(conn, new ZuTime(3600000000001n, null))
  assert.equal(tag(local), '[object Temporal.PlainTime]')
})

test('a value converts itself, without a connection that asked', has, async (t) => {
  const { conn } = await fresh(t)

  // The common case: a result read for its ids and its names, with one
  // date in it that is going to be shown.
  const date = (await one(conn, new ZuDate(DAYS))).toTemporal()
  assert.deepEqual([date.year, date.month, date.day], [2024, 1, 1])

  assert.equal(tag(new ZuTime(1n, null).toTemporal()), '[object Temporal.PlainTime]')
  assert.equal(tag(new ZuTimestamp(INSTANT, null).toTemporal()), '[object Temporal.PlainDateTime]')
  assert.equal(tag(new ZuTimestamp(INSTANT, 0).toTemporal()), '[object Temporal.ZonedDateTime]')
  assert.equal(new ZuTimestamp(INSTANT, 0).toTemporal().offset, '+00:00')
  assert.equal(ZuDuration.ofNanos(90000000005n).toTemporal().seconds, 90)
  assert.equal(ZuDuration.ofMonths(14n).toTemporal().months, 14)
})

test('a Temporal value binds as a parameter on any connection', has, async (t) => {
  // Any connection, including one that never asked for Temporal on the
  // way out: recognizing one costs a property read, and a client that
  // took a value it would not give back is a client with a rule nobody
  // could guess.
  const { conn } = await fresh(t)

  const date = await one(conn, Temporal.PlainDate.from('2024-01-01'))
  assert.ok(date instanceof ZuDate)
  assert.equal(date.days, DAYS)

  const time = await one(conn, Temporal.PlainTime.from('01:00:00.000000001'))
  assert.ok(time instanceof ZuTime)
  assert.equal(time.nanos, 3600000000001n)
  assert.equal(time.offset, null)

  const stamp = await one(conn, Temporal.PlainDateTime.from('2023-11-14T22:13:20.123456789'))
  assert.ok(stamp instanceof ZuTimestamp)
  assert.equal(stamp.nanos, INSTANT)
  assert.equal(stamp.offset, null)

  const zoned = await one(conn, Temporal.ZonedDateTime.from('2023-11-14T14:13:20.123456789-08:00[-08:00]'))
  assert.equal(zoned.nanos, INSTANT)
  assert.equal(zoned.offset, -480)

  // An instant is UTC, because that is what an instant is.
  const instant = await one(conn, Temporal.Instant.from('2023-11-14T22:13:20.123456789Z'))
  assert.ok(instant instanceof ZuTimestamp)
  assert.equal(instant.nanos, INSTANT)
  assert.equal(instant.offset, 0)

  const before = await one(conn, Temporal.PlainDateTime.from('1969-12-31T23:59:59.999999999'))
  assert.equal(before.nanos, -1n)
})

test('a Temporal duration binds as the kind it is', has, async (t) => {
  const { conn } = await fresh(t)

  const months = await one(conn, Temporal.Duration.from({ years: 1, months: 2 }))
  assert.equal(months.kind, 'yearMonth')
  assert.equal(months.months, 14n)

  const nanos = await one(conn, Temporal.Duration.from({ seconds: 90, nanoseconds: 5 }))
  assert.equal(nanos.kind, 'dayTime')
  assert.equal(nanos.nanos, 90000000005n)

  // A week is seven days and a day is twenty-four hours, which is what
  // Temporal itself assumes for a duration with no date to hang on.
  const weeks = await one(conn, Temporal.Duration.from({ weeks: 1, days: 1 }))
  assert.equal(weeks.nanos, 691200000000000n)

  const negative = await one(conn, Temporal.Duration.from({ seconds: -90 }))
  assert.equal(negative.nanos, -90000000000n)

  // Zero counts neither, and a duration that counts neither is a
  // day-time one of no length rather than an error.
  const zero = await one(conn, Temporal.Duration.from({ seconds: 0 }))
  assert.equal(zero.kind, 'dayTime')
  assert.equal(zero.nanos, 0n)

  await assert.rejects(
    () => one(conn, Temporal.Duration.from({ months: 1, days: 1 })),
    (err) => isZuError(err, 'ZuUsageError') && /both months and days/.test(err.message),
  )
})

test('a Temporal value zu has no place for is refused by name', has, async (t) => {
  const { conn } = await fresh(t)

  for (const value of [Temporal.PlainYearMonth.from('2024-01'), Temporal.PlainMonthDay.from('01-01')]) {
    await assert.rejects(
      () => one(conn, value),
      (err) => {
        assert.ok(isZuError(err, 'ZuUsageError'), `${tag(value)} was accepted`)
        assert.match(err.message, /parameter v is a Temporal\./)
        return true
      },
    )
  }

  // A calendar zu cannot store is refused rather than read as though it
  // were ISO, because a date read in the wrong calendar is a different
  // day and stores perfectly well.
  const hebrew = fromCalendar('hebrew')
  if (hebrew !== null) {
    await assert.rejects(
      () => one(conn, hebrew),
      (err) => isZuError(err, 'ZuUsageError') && /hebrew calendar/.test(err.message),
    )
  }

  // An instant past what nanoseconds in an INT64 hold, which Temporal
  // allows and zu does not.
  await assert.rejects(
    () => one(conn, Temporal.Instant.fromEpochMilliseconds(8.64e15)),
    (err) => isZuError(err, 'ZuUsageError') && /2262-04-11/.test(err.message),
  )
})

// A date in a calendar the runtime may not ship, since which calendars
// there are is the runtime's business and what this client does with
// one is not.
function fromCalendar(calendar) {
  try {
    return Temporal.PlainDate.from('2024-01-01').withCalendar(calendar)
  } catch {
    return null
  }
}

test('a Temporal value goes out the way it came in', has, async (t) => {
  const { conn } = await fresh(t, { temporal: true })

  for (const value of [
    Temporal.PlainDate.from('2024-01-01'),
    Temporal.PlainTime.from('01:00:00.000000001'),
    Temporal.PlainDateTime.from('2023-11-14T22:13:20.123456789'),
    Temporal.Duration.from({ seconds: 90, nanoseconds: 5 }),
  ]) {
    const back = await one(conn, value)
    assert.equal(tag(back), tag(value))
    assert.equal(back.toString(), value.toString())
  }
})

test('a statement and a stream spell temporal values the same way', has, async (t) => {
  const { conn } = await fresh(t, { temporal: true })
  await conn.exec("INSERT (d:day {id: 1, on: DATE '2024-01-01'})")

  const rows = await conn.query('MATCH (d:day) RETURN d.on AS on')
  assert.equal(tag(rows[0].on), '[object Temporal.PlainDate]')

  const stream = conn.stream('MATCH (d:day) RETURN d.on AS on')
  const seen = []
  for await (const row of stream) seen.push(row.on)
  assert.equal(seen.length, 1)
  assert.equal(tag(seen[0]), '[object Temporal.PlainDate]')
  assert.equal(seen[0].day, 1)
})

test('the mode is off unless it was asked for, and touches nothing else', has, async (t) => {
  for (const options of [undefined, { temporal: false }]) {
    const { conn } = await fresh(t, options)
    const date = await one(conn, new ZuDate(DAYS))
    assert.ok(date instanceof ZuDate, `${JSON.stringify(options)} gave a Temporal value`)
    assert.equal(date.days, DAYS)
  }

  const { conn } = await fresh(t, { temporal: true })
  const rows = await conn.query("RETURN 1 AS n, 1.5 AS f, 'ada' AS s, [1] AS xs")
  assert.deepEqual({ ...rows[0] }, { n: 1n, f: 1.5, s: 'ada', xs: [1n] })
})

test('a runtime without Temporal says so at the connect', hasNot, async (t) => {
  const { dir } = await fresh(t)

  const path = join(dir, 'never.zu1')
  await assert.rejects(
    () => connect(path, { temporal: true }),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'))
      // The flag, because the runtime that most often lands here is
      // Node 24 and turning it on is the whole fix.
      assert.match(err.message, /--harmony-temporal/)
      return true
    },
  )
  // At the connect means before the open, so a program that asked for
  // something this runtime cannot do leaves no database behind while
  // finding out.
  assert.equal(existsSync(path), false)
})

test('a runtime without Temporal says so on the value too', hasNot, async (t) => {
  const { conn } = await fresh(t)

  const date = await one(conn, new ZuDate(DAYS))
  assert.ok(date instanceof ZuDate)
  assert.throws(
    () => date.toTemporal(),
    (err) => isZuError(err, 'ZuUsageError') && /--harmony-temporal/.test(err.message),
  )
})
