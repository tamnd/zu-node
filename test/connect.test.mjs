import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { abiVersion, connect, version } from 'zudb'
import { fresh, twoPeople } from './helper.mjs'

test('the client says which version it is and which ABI it implements', () => {
  assert.match(version(), /^\d+\.\d+\.\d+$/)
  assert.match(abiVersion(), /^\d+\.\d+$/)
})

test('connecting to a path that holds nothing makes a database there', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'made.zu1')

  const conn = await connect(path)
  t.after(() => conn.close())

  assert.equal(conn.path, path)
  assert.equal(conn.readOnly, false)
  assert.equal(conn.open, true)
  assert.ok((await stat(path)).size > 0, 'a database that was made is a file with a header in it')
})

test('connecting twice to the same path gives two connections to one database', async (t) => {
  const { path, conn } = await twoPeople(t)
  const second = await connect(path)
  t.after(() => second.close())

  assert.equal(second.path, conn.path)
  assert.equal((await second.query('MATCH (p:person) RETURN p.name AS name')).length, 2)
})

test('a connection is closed once and closing it again does nothing', async (t) => {
  const { conn } = await fresh(t)

  assert.equal(conn.open, true)
  conn.close()
  assert.equal(conn.open, false)
  conn.close()
  assert.equal(conn.open, false)
})

test('a statement on a closed connection is refused rather than crashing', async (t) => {
  const { conn } = await twoPeople(t)
  conn.close()

  await assert.rejects(() => conn.query('MATCH (p:person) RETURN p.name AS name'), (err) => {
    assert.equal(err.name, 'ZuUsageError')
    assert.match(err.message, /closed/)
    // A mistake this client caught carries no GQLSTATUS, because the
    // engine never saw the statement and there is no condition to
    // report. A caller mapping codes to branches has to be able to tell
    // that from a code it does not recognize.
    assert.equal(err.code, undefined)
    assert.equal(err.retryable, false)
    return true
  })
  await assert.rejects(() => conn.exec("INSERT (p:person {id: 3, name: 'iris'})"), {
    name: 'ZuUsageError',
  })
})

test('await using closes the connection at the end of the block', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let escaped
  {
    await using conn = await connect(join(dir, 'scoped.zu1'))
    escaped = conn
    assert.equal(conn.open, true)
  }
  assert.equal(escaped.open, false)
})

test('a read-only connection refuses to write and never makes a database', async (t) => {
  const { path, conn } = await twoPeople(t)
  conn.close()

  const reader = await connect(path, { readOnly: true })
  t.after(() => reader.close())
  assert.equal(reader.readOnly, true)
  await assert.rejects(() => reader.exec("INSERT (p:person {id: 3, name: 'iris'})"), {
    name: 'ZuUsageError',
  })

  const missing = join(path, '..', 'nothing-here.zu1')
  await assert.rejects(() => connect(missing, { readOnly: true }), (err) => {
    // A read-only open of a path that holds nothing fails as an open. An
    // empty database made here would report the same typo three calls
    // later, as a statement that matches nothing.
    assert.equal(err.name, 'ZuConnectionError')
    return true
  })
  await assert.rejects(() => stat(missing), { code: 'ENOENT' })
})

test('the executor takes the limits it was opened with', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const conn = await connect(join(dir, 'limited.zu1'), {
    memoryLimit: 256n * 1024n * 1024n,
    threads: 2,
  })
  t.after(() => conn.close())

  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  assert.equal((await conn.query('MATCH (p:person) RETURN p.name AS name')).length, 1)
})

test('connecting with no path is a database in memory that makes no file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const conn = await connect()
  t.after(() => conn.close())

  assert.equal(conn.memory, true)
  assert.equal(conn.path, ':memory:')
  assert.equal(conn.readOnly, false)
  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  assert.deepEqual([...(await conn.query('MATCH (p:person) RETURN p.name AS name'))], [{ name: 'ada' }])
  assert.deepEqual(await readdir(dir), [], 'nothing was written anywhere')
})

test('the name every embedded database spells it with means the same thing', async (t) => {
  // The bug this replaces: `':memory:'` used to make a file called
  // `:memory:` in whatever directory the caller was standing in, which
  // is why the check below is on the directory this runs from.
  const conn = await connect(':memory:')
  t.after(() => conn.close())

  assert.equal(conn.memory, true)
  assert.equal(conn.path, ':memory:')
  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  assert.equal(existsSync(':memory:'), false, 'no file is called that')
})

test('options may stand where the path would', async (t) => {
  const conn = await connect({ threads: 2, bigIntMode: 'number' })
  t.after(() => conn.close())

  assert.equal(conn.memory, true)
  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  const rows = await conn.query('MATCH (p:person) RETURN p.id AS id')
  assert.deepEqual([...rows], [{ id: 1 }], 'the options were read, so INT64 is a number')
})

test('two databases in memory share nothing', async (t) => {
  const one = await connect()
  const two = await connect()
  t.after(() => { one.close(); two.close() })

  await one.exec("INSERT (p:person {id: 1, name: 'ada'})")
  assert.equal((await one.query('MATCH (p:person) RETURN p.name AS name')).length, 1)
  assert.equal((await two.query('MATCH (p:person) RETURN p.name AS name')).length, 0)
})

test('a database in memory takes a transaction and rolls it back', async (t) => {
  const conn = await connect()
  t.after(() => conn.close())

  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  const work = await conn.transaction()
  await conn.exec("INSERT (p:person {id: 2, name: 'zoe'})")
  await work.rollback()
  assert.equal((await conn.query('MATCH (p:person) RETURN p.name AS name')).length, 1)
})

test('a database on disk is not one in memory', async (t) => {
  const { conn } = await fresh(t)
  assert.equal(conn.memory, false)
})

test('a database in memory cannot be opened read-only', async (t) => {
  await assert.rejects(() => connect({ readOnly: true }), (err) => {
    assert.equal(err.name, 'ZuUsageError')
    return true
  })
})
