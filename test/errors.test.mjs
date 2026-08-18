import assert from 'node:assert/strict'
import test from 'node:test'

import { fresh, twoPeople } from './helper.mjs'

test('a failed statement rejects with an Error carrying the condition', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(() => conn.query('MATCH (p:person) WHERE RETURN p.id AS id'), (err) => {
    // An ordinary Error, so every catch, logger and rejection handler
    // already knows what to do with it.
    assert.ok(err instanceof Error)
    assert.equal(err.name, 'ZuSyntaxError')
    assert.equal(err.code, '42001')
    assert.equal(err.condition, 'syntax error or access rule violation, invalid syntax')
    assert.equal(err.severity, 'exception')
    assert.equal(err.docUrl, 'https://zu.dev/docs/errors/42001')
    assert.equal(err.retryable, false)
    assert.ok(err.message.length > 0)
    assert.ok(err.stack.includes('ZuSyntaxError'))
    return true
  })
})

test('a condition that happened somewhere says where, in numbers', async (t) => {
  const { conn } = await twoPeople(t)
  const statement = 'MATCH (p:person)\nRETURN p.name AS name, ? AS x'

  await assert.rejects(() => conn.query(statement), (err) => {
    assert.equal(typeof err.line, 'number')
    assert.equal(typeof err.column, 'number')
    assert.equal(typeof err.offset, 'number')
    assert.equal(err.line, 2)
    // The column indexes into the excerpt, which is the whole line the
    // position falls on, so a caller can underline the token without
    // having kept the statement.
    assert.equal(err.excerpt, 'RETURN p.name AS name, ? AS x')
    assert.equal(err.excerpt[err.column - 1], '?')
    // The offset indexes into the statement, so a caller who did keep it
    // can point at the same character without counting lines.
    assert.equal(statement[err.offset], '?')
    return true
  })
})

test('the fields are read off the error and never parsed back out of the message', async (t) => {
  const { conn } = await twoPeople(t)

  const err = await conn.query('MATCH (p:person) WHERE RETURN p.id AS id').then(
    () => null,
    (caught) => caught,
  )

  // Own properties, on the error itself, so a structured logger picks
  // them up and a caller can destructure them.
  assert.deepEqual(
    Object.keys(err).sort(),
    ['code', 'column', 'condition', 'docUrl', 'excerpt', 'line', 'name', 'offset', 'retryable', 'severity'],
  )
})

test('a mistake this client caught carries no code', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(() => conn.query('RETURN $v AS v', { v: () => {} }), (err) => {
    assert.equal(err.name, 'ZuUsageError')
    // Absent rather than a stand-in, so a caller mapping codes to
    // branches can tell a condition with no code from one it does not
    // recognize.
    assert.equal(err.code, undefined)
    assert.equal('code' in err, false)
    assert.equal(err.retryable, false)
    return true
  })
})

test('an engine failure and a client failure are told apart by name', async (t) => {
  const { conn } = await twoPeople(t)

  const names = []
  for (const run of [
    () => conn.query('MATCH (p:person) WHERE RETURN p.id AS id'),
    () => conn.query('RETURN $v AS v', { v: Symbol('nope') }),
    () => conn.exec("INSERT (p:person {id: 3})"),
  ]) {
    names.push(await run().then(() => null, (err) => err.name))
  }

  assert.deepEqual(names, ['ZuSyntaxError', 'ZuUsageError', 'ZuUsageError'])
})

test('one failed statement does not close the connection', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(() => conn.query('MATCH (p:person) WHERE RETURN p.id AS id'))

  assert.equal(conn.open, true)
  assert.equal((await conn.query('MATCH (p:person) RETURN p.id AS id')).length, 2)
})
