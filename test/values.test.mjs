import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuDate, ZuDecimal, ZuDuration, ZuTime, ZuTimestamp } from 'zudb'
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

  // Negative zero is whole and is still a float, because there is no
  // integer that is negative zero and binding it as one throws away the
  // sign the caller went out of their way to write.
  const zero = await roundTrip(conn, -0)
  assert.equal(typeof zero, 'number')
  assert.ok(Object.is(zero, -0), `-0 came back as ${zero}`)
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

test('a decimal comes back with the digits it was written with', async (t) => {
  const { conn } = await fresh(t)

  // CAST is the only way to reach one today: a literal has no decimal
  // spelling yet and no column is declared DECIMAL, so this is where a
  // decimal comes from and the reason the test asks for one this way.
  const rows = await conn.query("RETURN CAST('1.20' AS DECIMAL(5, 2)) AS v")
  const v = rows[0].v

  assert.ok(v instanceof ZuDecimal, `a decimal came back as ${v?.constructor?.name}`)
  assert.equal(v.unscaled, 120n)
  assert.equal(v.scale, 2)
  // Both places, which is the whole point. A float would have had
  // neither the value nor the count of digits.
  assert.equal(v.toString(), '1.20')
})

test('a decimal keeps its sign and its noughts', async (t) => {
  const { conn } = await fresh(t)

  for (const [text, spelled] of [
    ['0', '0'],
    ['1.20', '1.20'],
    ['-0.05', '-0.05'],
    ['1234', '1234'],
    ['-1234.5678', '-1234.5678'],
    ['0.005', '0.005'],
    ['0.000', '0.000'],
  ]) {
    const places = text.includes('.') ? text.split('.')[1].length : 0
    const rows = await conn.query(`RETURN CAST('${text}' AS DECIMAL(38, ${places})) AS v`)
    assert.equal(rows[0].v.toString(), spelled)
    assert.equal(rows[0].v.scale, places)
  }
})

test('a decimal wider than an INT64 arrives whole', async (t) => {
  const { conn } = await fresh(t)

  // Thirty eight digits, which is the widest DECIMAL(p, s) may be
  // declared and the widest the i128 behind it holds. A bigint carries
  // it here for the reason it carries an INT64.
  const digits = '1'.repeat(38)
  const rows = await conn.query(`RETURN CAST('${digits}' AS DECIMAL(38, 0)) AS v`)

  assert.equal(rows[0].v.unscaled, BigInt(digits))
  assert.equal(rows[0].v.toString(), digits)
})

test('a decimal goes in as a parameter and comes back the same', async (t) => {
  const { conn } = await fresh(t)

  const back = await roundTrip(conn, ZuDecimal.parse('1.20'))

  assert.ok(back instanceof ZuDecimal)
  assert.equal(back.unscaled, 120n)
  assert.equal(back.scale, 2)
  assert.equal(back.toString(), '1.20')
})

test('a decimal parameter is not read as a float', async (t) => {
  const { conn } = await fresh(t)

  // Three tenths is not a double, so a decimal that had gone through
  // one would come back as something that is not three tenths.
  const back = await roundTrip(conn, ZuDecimal.parse('0.3'))

  assert.equal(back.unscaled, 3n)
  assert.equal(back.scale, 1)
  assert.equal(back.toString(), '0.3')
})

test('a decimal built from the pair is the one the text spells', async (t) => {
  const { conn } = await fresh(t)

  const built = ZuDecimal.of(120n, 2)
  assert.equal(built.toString(), '1.20')
  assert.equal((await roundTrip(conn, built)).toString(), '1.20')

  // Nothing is normalised, so the scale asked for is the scale kept
  // even where the last digit is a nought that carries no value.
  assert.equal(ZuDecimal.of(1200n, 3).toString(), '1.200')
  assert.equal(ZuDecimal.of(-5n, 2).toString(), '-0.05')
  assert.equal(ZuDecimal.of(0n, 0).toString(), '0')
})

test('an exponent moves the point rather than the value', async (t) => {
  // `1.5e3` is fifteen hundred at no places. Reading the scale off the
  // text without applying the exponent would make it `1.500`, which is
  // a thousandth of the number somebody wrote.
  assert.equal(ZuDecimal.parse('1.5e3').toString(), '1500')
  assert.equal(ZuDecimal.parse('1.5e3').scale, 0)
  assert.equal(ZuDecimal.parse('1E-3').toString(), '0.001')
  assert.equal(ZuDecimal.parse('+2.50').toString(), '2.50')
})

test('a decimal that is not a number is refused at the call', async () => {
  for (const text of ['NaN', 'Infinity', '-Infinity', 'nope', '', '1.2.3']) {
    assert.throws(
      () => ZuDecimal.parse(text),
      (err) => {
        assert.equal(err.name, 'ZuUsageError')
        assert.match(err.message, /exact number/)
        return true
      },
      `${JSON.stringify(text)} was taken for a decimal`,
    )
  }
})

test('a decimal wider than the carrier says so', async () => {
  // Thirty nine digits, one past what DECIMAL(p, s) may declare and one
  // past what the i128 behind it holds.
  assert.throws(() => ZuDecimal.parse('1'.repeat(39)), /wider than 38 digits/)
  assert.throws(() => ZuDecimal.of(10n ** 38n, 0), /wider than 38 digits/)
  assert.throws(() => ZuDecimal.parse('1e-100'), /100 digits after the point/)
  assert.throws(() => ZuDecimal.of(1n, 39), /at most 38 digits after the point/)
})

test('a decimal reads back as itself and as the nearest number', async () => {
  const d = ZuDecimal.parse('-1234.5678')

  // The text is the lossless spelling and the one `parse` reads back,
  // so a decimal round trips through it and through JSON.
  assert.equal(ZuDecimal.parse(d.toString()).toString(), '-1234.5678')
  assert.equal(JSON.stringify({ d }), '{"d":"-1234.5678"}')

  assert.equal(d.toNumber(), -1234.5678)
  // And the loss, said out loud: a tenth is not a binary fraction, so
  // the number is near the decimal rather than equal to it.
  assert.notEqual(ZuDecimal.parse('0.1').toNumber() + ZuDecimal.parse('0.2').toNumber(), 0.3)
})

test('a plain object shaped like a decimal is a record, not a decimal', async (t) => {
  const { conn } = await fresh(t)

  const back = await roundTrip(conn, { unscaled: 120n, scale: 2 })

  assert.ok(!(back instanceof ZuDecimal))
  assert.deepEqual(back, { unscaled: 120n, scale: 2n })
})
