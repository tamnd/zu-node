import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { abiVersion, connect, version } from '../index.js'
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
