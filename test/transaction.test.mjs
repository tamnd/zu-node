// Several statements as one unit of work.
//
// What is being asserted here is not that a write is atomic, since one
// statement is atomic on its own. It is the span: that two statements
// stand or fall together, that the word which ends them is the caller's,
// and that a span nobody ended is undone rather than kept.
//
// The last of those is the difference from the Python client and it is
// the one worth reading the tests for. A JavaScript disposal is not told
// whether the block it is leaving threw, so `await using` here rolls
// back and the commit is written out. A block that ends well and forgot
// to commit loses its work, which is a loud kind of wrong, and the
// alternative was a block that failed and committed half of it, which is
// a quiet kind.

import assert from 'node:assert/strict'
import test from 'node:test'

import { fresh, isZuError, twoPeople } from './helper.mjs'

const COUNT = 'MATCH (p:person) RETURN count(*) AS n'

// How many people are in the database, which is what every one of these
// asks after the fact.
async function people(conn) {
  const rows = await conn.query(COUNT)
  return Number(rows[0].n)
}

test('two statements committed together are both there', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction()
  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
  await conn.exec("INSERT (p:person {id: 4, name: 'eve'})")
  await tx.commit()

  assert.equal(await people(conn), 4)
  assert.equal(tx.done, true)
})

test('a rollback leaves the database as it was', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction()
  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
  // Seen from inside, because a transaction is not a queue: the
  // statements have run and the span is what has not ended.
  assert.equal(await people(conn), 3)
  await tx.rollback()

  assert.equal(await people(conn), 2)
  assert.equal(tx.done, true)
})

test('await using rolls back a transaction nobody committed', async (t) => {
  const { conn } = await twoPeople(t)

  {
    await using tx = await conn.transaction()
    await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
    assert.equal(tx.done, false)
  }

  assert.equal(await people(conn), 2)
})

test('await using keeps what the block committed', async (t) => {
  const { conn } = await twoPeople(t)

  {
    await using tx = await conn.transaction()
    await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
    await tx.commit()
  }

  // The disposal ran on a transaction that had already ended, and had
  // nothing to say about it. A second ROLLBACK there would have been an
  // error out of a block that did everything right.
  assert.equal(await people(conn), 3)
})

test('a throw inside the block rolls back and still throws', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    async () => {
      await using tx = await conn.transaction()
      await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
      assert.equal(tx.done, false)
      throw new Error('the caller changed their mind')
    },
    { message: 'the caller changed their mind' },
  )

  assert.equal(await people(conn), 2)
})

test('the connection says whether it is inside one', async (t) => {
  const { conn } = await twoPeople(t)

  assert.equal(conn.inTransaction, false)
  const tx = await conn.transaction()
  assert.equal(conn.inTransaction, true)
  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
  // Still true after a statement, which is the thing that would have
  // gone wrong if this were a tally kept here rather than the session's
  // own answer.
  assert.equal(conn.inTransaction, true)
  await tx.commit()
  assert.equal(conn.inTransaction, false)
})

test('a transaction started by hand is one the connection knows about', async (t) => {
  const { conn } = await twoPeople(t)

  // The three words are statements, and a caller who would rather write
  // them is running the same thing this class runs.
  await conn.exec('START TRANSACTION')
  assert.equal(conn.inTransaction, true)
  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
  await conn.exec('ROLLBACK')

  assert.equal(conn.inTransaction, false)
  assert.equal(await people(conn), 2)
})

test('a statement on its own is not inside a transaction of anybody else', async (t) => {
  const { conn } = await twoPeople(t)

  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")

  // Its own write was atomic and its own span is over. What
  // `inTransaction` answers is whether a span is open, and none is.
  assert.equal(conn.inTransaction, false)
  assert.equal(await people(conn), 3)
})

test('committing twice is refused rather than ignored', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction()
  await tx.commit()

  await assert.rejects(
    () => tx.commit(),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /already ended/)
      // A mistake this client caught, so there is no GQLSTATUS to
      // branch on and a caller mapping codes has to tell a missing one
      // from an unknown one.
      assert.equal(err.code, undefined)
      return true
    },
  )
})

test('rolling back a committed transaction is refused too', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction()
  await tx.commit()

  await assert.rejects(() => tx.rollback(), (err) => isZuError(err, 'ZuUsageError'))
})

test('a read only transaction refuses the statement that writes', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction({ readOnly: true })
  assert.equal(tx.readOnly, true)
  // Reading is what it is for, and reading works.
  assert.equal(await people(conn), 2)

  await assert.rejects(
    () => conn.exec("INSERT (p:person {id: 3, name: 'ida'})"),
    (err) => {
      assert.ok(isZuError(err, 'ZuTransactionError'), `${err.name}: ${err.message}`)
      return true
    },
  )

  await tx.rollback()
  assert.equal(await people(conn), 2)
})

test('a transaction inside a transaction is refused', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction()
  await assert.rejects(
    () => conn.transaction(),
    (err) => {
      // The engine's own condition, not this client's, because nesting
      // is a thing the database decides and a client that guessed would
      // be a second rule to keep in step.
      assert.ok(err.code, `${err.name}: ${err.message}`)
      return true
    },
  )
  await tx.rollback()
})

test('a transaction on a closed connection is refused as a rejection', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(
    () => conn.transaction(),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /the connection is closed/)
      return true
    },
  )
})

test('leaving the block of a transaction whose connection is gone says nothing', async (t) => {
  const { conn } = await twoPeople(t)

  // A connection closed underneath an open transaction took the
  // transaction with it, unwritten, so there is nothing left to undo
  // and the disposal has nothing to report.
  {
    await using tx = await conn.transaction()
    await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
    assert.equal(tx.done, false)
    conn.close()
  }

  assert.equal(conn.open, false)
})

test('an option that is not a boolean is refused, and says what arrived', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.transaction({ readOnly: 'yes' }),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /readOnly is a String/)
      return true
    },
  )

  // Refused before anything started, so the connection is exactly where
  // it was and the next statement runs.
  assert.equal(conn.inTransaction, false)
  assert.equal(await people(conn), 2)
})

test('an absent option is the same as an unwritten one', async (t) => {
  const { conn } = await twoPeople(t)

  const tx = await conn.transaction({ readOnly: undefined })
  assert.equal(tx.readOnly, false)
  await conn.exec("INSERT (p:person {id: 3, name: 'ida'})")
  await tx.commit()

  assert.equal(await people(conn), 3)
})

test('a rolled back transaction leaves the connection ready for the next one', async (t) => {
  const { conn } = await twoPeople(t)

  for (const keep of [false, true, false]) {
    const tx = await conn.transaction()
    await conn.exec("INSERT (p:person {id: 9, name: 'ida'})")
    if (keep) await tx.commit()
    else await tx.rollback()
  }

  assert.equal(await people(conn), 3)
  assert.equal(conn.inTransaction, false)
})
