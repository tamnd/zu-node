// A statement compiled once and run many times.
//
// The interesting part is not that it answers rows, which is the same
// answer `conn.query` gives and is asserted here mostly so that the
// three ways of asking are known to be the same three. It is the
// lifetime: what a prepared statement is before it is closed, what it
// says after, what happens to one whose connection went first, and
// whether the names it reports are the names the statement wants.

import assert from 'node:assert/strict'
import test from 'node:test'

import { connect, Prepared } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

const BY_NAME = 'MATCH (p:person) WHERE p.name = $name RETURN p.id AS id'

test('a prepared statement reports its text and the names it wants', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)

  assert.ok(find instanceof Prepared)
  assert.equal(find.statement, BY_NAME)
  assert.deepEqual(find.params, ['name'])
  assert.equal(find.closed, false)
})

test('a statement that takes no parameters reports none', async (t) => {
  const { conn } = await twoPeople(t)

  await using all = await conn.prepare('MATCH (p:person) RETURN p.name AS name')

  assert.deepEqual(all.params, [])
})

test('it runs as often as it is asked to, with different bindings', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)

  assert.deepEqual([...(await find.query({ name: 'ada' }))], [{ id: 1n }])
  assert.deepEqual([...(await find.query({ name: 'zoe' }))], [{ id: 2n }])
  assert.deepEqual([...(await find.query({ name: 'nobody' }))], [])
  assert.deepEqual([...(await find.query({ name: 'ada' }))], [{ id: 1n }])
})

test('the rows carry the same three properties a query gives back', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)
  const rows = await find.query({ name: 'ada' })

  assert.deepEqual(rows.columns, ['id'])
  assert.equal(rows.gqlstatus, '00000')
  assert.deepEqual(rows.notices, [])
})

test('exec runs it and answers nothing', async (t) => {
  const { conn } = await twoPeople(t)

  await using insert = await conn.prepare('INSERT (p:person {id: 3, name: $name})')

  assert.equal(await insert.exec({ name: 'ida' }), undefined)
  assert.equal(await insert.exec({ name: 'eve' }), undefined)

  const rows = await conn.query('MATCH (p:person) RETURN p.name AS name')
  assert.deepEqual(
    rows.map((row) => row.name),
    ['ada', 'zoe', 'ida', 'eve'],
  )
})

test('columnar reads it down its columns', async (t) => {
  const { conn } = await twoPeople(t)

  await using all = await conn.prepare('MATCH (p:person) RETURN p.id AS id')
  const read = await all.columnar()

  assert.equal(read.rows, 2)
  assert.equal(read.columns[0].type, 'int')
  assert.deepEqual([...read.columns[0].values], [1n, 2n])
})

test('a statement that does not compile fails at the prepare', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.prepare('MATCH ('),
    (err) => isZuError(err, 'ZuSyntaxError'),
  )
})

test('a name the caller did not bind fails at the run', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)

  await assert.rejects(
    () => find.query(),
    (err) => isZuError(err, 'ZuSyntaxError') && err.message.includes('$name'),
  )
  // And the statement is still there to be run properly, since nothing
  // about a missing binding is about the statement.
  assert.deepEqual([...(await find.query({ name: 'ada' }))], [{ id: 1n }])
})

test('closing it twice is not an error', async (t) => {
  const { conn } = await twoPeople(t)

  const find = await conn.prepare(BY_NAME)
  await find.close()
  assert.equal(find.closed, true)
  await find.close()
  assert.equal(find.closed, true)
})

test('a closed prepared statement says so at every one of the three runs', async (t) => {
  const { conn } = await twoPeople(t)

  const find = await conn.prepare(BY_NAME)
  await find.close()

  const closed = (err) => isZuError(err, 'ZuUsageError') && err.message.includes('closed')
  await assert.rejects(() => find.query({ name: 'ada' }), closed)
  await assert.rejects(() => find.exec({ name: 'ada' }), closed)
  await assert.rejects(() => find.columnar({ name: 'ada' }), closed)
})

test('await using closes it at the end of the block', async (t) => {
  const { conn } = await twoPeople(t)

  let held
  {
    await using find = await conn.prepare(BY_NAME)
    held = find
    assert.equal(held.closed, false)
  }
  assert.equal(held.closed, true)
})

test('a prepared statement whose connection closed says the connection is closed', async (t) => {
  const { conn } = await twoPeople(t)

  const find = await conn.prepare(BY_NAME)
  conn.close()

  await assert.rejects(
    () => find.query({ name: 'ada' }),
    (err) => isZuError(err, 'ZuUsageError') && err.message.includes('the connection is closed'),
  )
  // Closing it is still fine, and still does nothing: the session that
  // was holding the id went when the connection did.
  await find.close()
  assert.equal(find.closed, true)
})

test('a read-only connection prepares and runs a statement that reads', async (t) => {
  const { conn, path } = await twoPeople(t)
  conn.close()

  const reader = await connect(path, { readOnly: true })
  t.after(() => reader.close())
  await using all = await reader.prepare('MATCH (p:person) RETURN p.name AS name')

  assert.equal((await all.query()).length, 2)
})

test('a signal stops a run of a prepared statement', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)
  const control = new AbortController()
  control.abort(new Error('changed my mind'))

  await assert.rejects(
    () => find.query({ name: 'ada' }, { signal: control.signal }),
    (err) => err.message === 'changed my mind',
  )
  assert.deepEqual([...(await find.query({ name: 'ada' }))], [{ id: 1n }])
})

test('bigIntMode on a run says how that run spells its integers', async (t) => {
  const { conn } = await twoPeople(t)

  await using find = await conn.prepare(BY_NAME)

  assert.deepEqual([...(await find.query({ name: 'ada' }, { bigIntMode: 'number' }))], [{ id: 1 }])
  assert.deepEqual([...(await find.query({ name: 'ada' }))], [{ id: 1n }])
})

test('a connection prepares as many statements as it likes', async (t) => {
  const { conn } = await twoPeople(t)

  const prepared = await Promise.all([
    conn.prepare(BY_NAME),
    conn.prepare('MATCH (p:person) RETURN count(*) AS n'),
    conn.prepare('MATCH (p:person) RETURN p.name AS name'),
  ])

  assert.deepEqual([...(await prepared[0].query({ name: 'zoe' }))], [{ id: 2n }])
  assert.equal((await prepared[1].query())[0].n, 2n)
  assert.equal((await prepared[2].query()).length, 2)

  for (const statement of prepared) await statement.close()
})

test('preparing on a closed connection is refused', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(
    () => conn.prepare('MATCH (p:person) RETURN p.name AS name'),
    (err) => isZuError(err, 'ZuUsageError') && err.message.includes('the connection is closed'),
  )
})

test('a statement that is not a string is refused with what arrived', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(
    () => conn.prepare(42),
    (err) => isZuError(err, 'ZuUsageError') && err.message === 'the statement is a Number, and a statement is a string',
  )
})
