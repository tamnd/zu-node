// How INT64 is spelled on the way out.
//
// The default is a `bigint` and that is not in question here. What is
// in question is the other mode: that a program has to ask for it, that
// asking is possible at the two places a program would look for it, and
// that the integer it cannot hold is refused rather than rounded, which
// is the whole of the difference between an opt-in and a trap.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { connect } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

// 2^53 - 1, the largest integer a JavaScript number tells from the next
// one, and the first two past it.
const EXACT = 9007199254740991n
const OVER = 9007199254740992n
const FURTHER = 9007199254740993n

async function one(conn, value, options) {
  const rows = await conn.query('RETURN $v AS v', { v: value }, options)
  return rows[0].v
}

test('an INT64 is a bigint when nobody says otherwise', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id ORDER BY id')
  assert.equal(typeof rows[0].id, 'bigint')
  // Named explicitly, which is the same thing and worth being able to
  // write down: a program can say what it is relying on.
  assert.equal(typeof (await one(conn, 1n, { bigIntMode: 'bigint' })), 'bigint')
})

test('a statement that asks for numbers gets numbers', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id ORDER BY id', null, {
    bigIntMode: 'number',
  })
  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2],
  )
  assert.equal(typeof rows[0].id, 'number')
  // The statement beside it is unaffected, because the mode belongs to
  // the call and not to the connection it was made on.
  assert.equal(typeof (await one(conn, 1n)), 'bigint')
})

test('a connection opened for numbers gives them to every statement', async (t) => {
  const { conn } = await fresh(t, { bigIntMode: 'number' })
  await conn.exec("INSERT (p:person {id: 7, name: 'ada'})")

  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id')
  assert.equal(rows[0].id, 7)
  assert.equal(typeof rows[0].id, 'number')

  // And a statement on it can still ask for the other one, which is the
  // direction that matters: the one query that counts something large
  // should not have to be run on a connection of its own.
  assert.equal(await one(conn, EXACT + 10n, { bigIntMode: 'bigint' }), 9007199254741001n)
})

test('an integer a number cannot hold is refused, not rounded', async (t) => {
  const { conn } = await fresh(t)

  assert.equal(await one(conn, EXACT, { bigIntMode: 'number' }), 9007199254740991)
  assert.equal(await one(conn, -EXACT, { bigIntMode: 'number' }), -9007199254740991)

  for (const value of [OVER, FURTHER, -OVER, 9223372036854775807n]) {
    await assert.rejects(
      () => one(conn, value, { bigIntMode: 'number' }),
      (err) => {
        assert.ok(isZuError(err, 'ZuUsageError'), `${err.name} for ${value}`)
        // The column and the value, because a caller with twelve
        // columns has to know which one to widen and a caller deciding
        // whether to widen at all has to know by how much.
        assert.match(err.message, /column v holds/)
        assert.match(err.message, new RegExp(String(value)))
        assert.match(err.message, /bigIntMode/)
        return true
      },
    )
  }

  // The mistake is the mode and not the connection, so the next
  // statement runs.
  assert.equal(await one(conn, FURTHER), 9007199254740993n)
})

test('the mode reaches the integers inside a list and a record', async (t) => {
  const { conn } = await fresh(t)

  const rows = await conn.query('RETURN [1, 2] AS xs, {a: 3} AS r', null, {
    bigIntMode: 'number',
  })
  assert.deepEqual(rows[0].xs, [1, 2])
  assert.deepEqual(rows[0].r, { a: 3 })

  await assert.rejects(
    () => conn.query('RETURN [$v] AS xs', { v: FURTHER }, { bigIntMode: 'number' }),
    (err) => isZuError(err, 'ZuUsageError') && /column xs holds/.test(err.message),
  )
})

test('a float is a number in both modes, and a string is a string', async (t) => {
  const { conn } = await fresh(t)

  for (const bigIntMode of ['bigint', 'number']) {
    const rows = await conn.query("RETURN 1.5 AS f, 'ada' AS s, true AS b", null, { bigIntMode })
    assert.deepEqual({ ...rows[0] }, { f: 1.5, s: 'ada', b: true })
  }
})

test('a node keeps its bigint offset in either mode', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p AS p ORDER BY p.id', null, {
    bigIntMode: 'number',
  })
  // The classes are registered once by the addon and their getters
  // cannot change shape per statement, so this is the documented edge
  // of the mode rather than an oversight.
  assert.equal(typeof rows[0].p.offset, 'bigint')
})

test('a stream spells its integers the way it was asked to', async (t) => {
  const { conn } = await twoPeople(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id ORDER BY id', null, {
    bigIntMode: 'number',
  })
  const seen = []
  for await (const row of stream) seen.push(row.id)
  assert.deepEqual(seen, [1, 2])

  // And the refusal arrives where every other failure of a stream
  // arrives, which is the read that found the row.
  const over = conn.stream('RETURN $v AS v', { v: FURTHER }, { bigIntMode: 'number' })
  await assert.rejects(
    async () => {
      for await (const row of over) void row
    },
    (err) => isZuError(err, 'ZuUsageError') && /column v holds/.test(err.message),
  )
})

test('rows of numbers are what JSON.stringify can take', async (t) => {
  const { conn } = await twoPeople(t)

  // The reason a program asks for this mode as often as any other: a
  // `bigint` has no JSON spelling at all, so a row holding one throws
  // on the way out of a request handler.
  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id, p.name AS name ORDER BY id', null, {
    bigIntMode: 'number',
  })
  assert.equal(JSON.stringify(rows), '[{"id":1,"name":"ada"},{"id":2,"name":"zoe"}]')
  const bigints = await conn.query('RETURN 1 AS n')
  assert.throws(() => JSON.stringify(bigints), TypeError)
})

test('a mode nobody can spell is refused wherever it was named', async (t) => {
  const { conn, dir } = await twoPeople(t)

  for (const bigIntMode of ['string', 'BigInt', '', 5, {}]) {
    await assert.rejects(
      () => conn.query('RETURN 1 AS n', null, { bigIntMode }),
      (err) => {
        assert.ok(isZuError(err, 'ZuUsageError'), `${JSON.stringify(bigIntMode)} was accepted`)
        assert.match(err.message, /bigIntMode/)
        return true
      },
    )
  }

  const path = join(dir, 'never.zu1')
  await assert.rejects(
    () => connect(path, { bigIntMode: 'strings' }),
    (err) => isZuError(err, 'ZuUsageError') && /bigIntMode/.test(err.message),
  )
  // The mode is read before the database is opened, so a typo in the
  // options does not leave a database behind that nobody asked for.
  assert.equal(existsSync(path), false)
})
