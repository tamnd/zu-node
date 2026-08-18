import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuNode } from '../index.js'
import { twoPeople } from './helper.mjs'

test('the rows come back as an array of objects keyed by column', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id, p.name AS name ORDER BY id')

  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { id: 1n, name: 'ada' })
  assert.deepEqual([...rows], [
    { id: 1n, name: 'ada' },
    { id: 2n, name: 'zoe' },
  ])
})

test('the projection, the condition and the notices ride along beside the rows', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p.name AS name, p.id AS id')

  // In the order they were written, not the order they were read.
  assert.deepEqual(rows.columns, ['name', 'id'])
  assert.equal(rows.gqlstatus, '00000')
  assert.deepEqual(rows.notices, [])
  // Beside the elements rather than among them, so the array is still
  // exactly as long as the statement had rows and still looks like an
  // array to everything that walks one.
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows), ['0', '1'])
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map((row) => row.name))), ['ada', 'zoe'])
  assert.equal(Object.keys({ ...rows }).length, 2)
})

test('a statement that matched nothing is a success with no rows', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query("MATCH (p:person) WHERE p.name = 'nobody' RETURN p.name AS name")

  assert.equal(rows.length, 0)
  assert.deepEqual(rows.columns, ['name'])
  // 00000 is successful completion and says nothing about how many rows
  // there were. A caller asking whether anything matched asks the
  // length.
  assert.equal(rows.gqlstatus, '00000')
})

test('a statement with no projection completes with 00001', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query("INSERT (p:person {id: 3, name: 'iris'})")

  assert.equal(rows.length, 0)
  assert.deepEqual(rows.columns, [])
  assert.equal(rows.gqlstatus, '00001')
})

test('exec runs the statement and gives back nothing', async (t) => {
  const { conn } = await twoPeople(t)

  assert.equal(await conn.exec("INSERT (p:person {id: 3, name: 'iris'})"), undefined)
  assert.equal((await conn.query('MATCH (p:person) RETURN p.id AS id')).length, 3)
})

test('parameters are named, and a name the statement does not use is refused', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) WHERE p.name = $name RETURN p.id AS id', {
    name: 'zoe',
  })
  assert.deepEqual([...rows], [{ id: 2n }])

  await assert.rejects(
    () => conn.query('MATCH (p:person) WHERE p.name = $name RETURN p.id AS id', { nmae: 'zoe' }),
    (err) => {
      assert.match(err.message, /name/)
      return true
    },
  )
})

test('a node comes back as a node, with the table named rather than numbered', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.query('MATCH (p:person) RETURN p AS p ORDER BY p.id')

  assert.ok(rows[0].p instanceof ZuNode)
  assert.equal(rows[0].p.table, 'person')
  assert.equal(rows[0].p.offset, 0n)
  assert.equal(rows[1].p.offset, 1n)
  // The fields are getters, so that a 64-bit one can be a bigint, and a
  // getter is invisible to JSON.stringify. This is what puts them back.
  assert.deepEqual(rows[0].p.toJSON(), { table: 'person', offset: 0n })
})

test('statements run one after another on one connection', async (t) => {
  const { conn } = await twoPeople(t)

  // Started together and awaited together. The connection runs them in
  // order behind its lock, so what this asserts is that the second one
  // waits rather than corrupting the first.
  const [first, second, third] = await Promise.all([
    conn.query('MATCH (p:person) RETURN p.id AS id ORDER BY id'),
    conn.query("MATCH (p:person) WHERE p.name = 'ada' RETURN p.name AS name"),
    conn.query('MATCH (p:person) RETURN count(*) AS n'),
  ])

  assert.deepEqual([...first], [{ id: 1n }, { id: 2n }])
  assert.deepEqual([...second], [{ name: 'ada' }])
  assert.deepEqual([...third], [{ n: 2n }])
})

test('a statement runs off the event loop', async (t) => {
  const { conn } = await twoPeople(t)

  let ticked = false
  const running = conn.query('MATCH (p:person) RETURN count(*) AS n')
  // The promise was handed back before the statement finished, so this
  // callback gets to run first. A synchronous native call would have
  // finished the statement before this line was reached.
  queueMicrotask(() => {
    ticked = true
  })
  const rows = await running

  assert.equal(ticked, true)
  assert.deepEqual([...rows], [{ n: 2n }])
})
