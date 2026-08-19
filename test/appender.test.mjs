// Loading rows into a table that is already there.
//
// What is being asserted is the shape of a loader rather than the shape
// of a write. `INSERT` already writes a row and is already atomic; an
// appender exists because a million of them is a million commits, and
// what it trades for one commit is that the rows are in memory until the
// flush. So these tests are mostly about where a row is at each moment:
// buffered, written, refused, or thrown away.
//
// The other half is the one synchronous call in this client. `appendRow`
// throws rather than rejecting, because it reaches nothing that can
// wait, and a caller who wraps it in a `try` still catches the same
// `ZuUsageError` the promises reject with.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuDate, ZuDuration, ZuTimestamp } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

const COUNT = 'MATCH (p:person) RETURN count(*) AS n'
const PEOPLE = 'MATCH (p:person) RETURN p.id AS id, p.name AS name'

async function people(conn) {
  const rows = await conn.query(COUNT)
  return Number(rows[0].n)
}

test('rows go in on the flush and not before it', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.equal(rows.table, 'person')
  assert.equal(rows.buffered, 0)
  assert.equal(rows.committed, 0)
  assert.equal(rows.closed, false)

  rows.appendRow([3n, 'ida'])
  rows.appendRow([4n, 'eve'])
  // Buffered here rather than in the database, which is the whole
  // bargain: a query run now sees the two it started with.
  assert.equal(rows.buffered, 2)
  assert.equal(await people(conn), 2)

  assert.equal(await rows.flush(), 2)
  assert.equal(rows.buffered, 0)
  assert.equal(rows.committed, 2)
  assert.equal(await people(conn), 4)
})

test('what was appended is what comes back', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  rows.appendRows([
    [3n, 'ida'],
    [4n, 'eve'],
  ])
  await rows.close()

  const found = await conn.query(PEOPLE)
  assert.deepEqual(
    found.map((row) => row.name),
    ['ada', 'zoe', 'ida', 'eve'],
  )
  assert.deepEqual(
    found.map((row) => row.id),
    [1n, 2n, 3n, 4n],
  )
})

test('a batch is one commit and several are several', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  for (const batch of [0, 1, 2]) {
    for (let at = 0; at < 100; at += 1) rows.appendRow([BigInt(batch * 100 + at), `p${at}`])
    // Each flush answers the running total rather than what it wrote
    // itself, because the total is the number a loader reports and the
    // batch is a number it already knows.
    assert.equal(await rows.flush(), (batch + 1) * 100)
  }
  assert.equal(await rows.close(), 300)

  assert.equal(await people(conn), 302)
})

test('appendRows answers how many rows went in', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.equal(rows.appendRows([]), 0)
  assert.equal(
    rows.appendRows([
      [3n, 'ida'],
      [4n, 'eve'],
      [5n, 'ora'],
    ]),
    3,
  )
  assert.equal(rows.buffered, 3)
  await rows.close()
  assert.equal(await people(conn), 5)
})

test('a flush with nothing buffered writes nothing and says so', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  // What a loader flushing on a timer does between batches, and it had
  // better not be a commit.
  assert.equal(await rows.flush(), 0)
  assert.equal(await rows.flush(), 0)
  assert.equal(await people(conn), 2)
})

test('await using flushes what the block left buffered', async (t) => {
  const { conn } = await twoPeople(t)

  {
    await using rows = await conn.appender('person')
    rows.appendRow([3n, 'ida'])
  }

  // The opposite of what a transaction's disposal does here, because
  // the question is a different one: a buffer that left its scope
  // unwritten is a loader that read its rows and threw them away.
  assert.equal(await people(conn), 3)
})

test('discard is how a block leaves without writing', async (t) => {
  const { conn } = await twoPeople(t)

  {
    await using rows = await conn.appender('person')
    rows.appendRow([3n, 'ida'])
    rows.appendRow([4n, 'eve'])
    assert.equal(rows.discard(), 2)
    assert.equal(rows.buffered, 0)
  }

  assert.equal(await people(conn), 2)
})

test('discard leaves what an earlier flush committed', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  rows.appendRow([3n, 'ida'])
  await rows.flush()
  rows.appendRow([4n, 'eve'])
  assert.equal(rows.discard(), 1)
  await rows.close()

  assert.equal(await people(conn), 3)
  assert.equal(rows.committed, 1)
})

test('closing twice writes once', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  rows.appendRow([3n, 'ida'])

  assert.equal(await rows.close(), 1)
  assert.equal(rows.closed, true)
  // The second one is what an `await using` runs after a block that
  // closed early, and it has to be quiet rather than a failure out of
  // code that did everything right.
  assert.equal(await rows.close(), 1)
  assert.equal(await people(conn), 3)
})

test('a closed appender refuses a row and a flush', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  await rows.close()

  assert.throws(
    () => rows.appendRow([3n, 'ida']),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /this appender is closed/)
      return true
    },
  )
  // A flush is a caller asking for a write, so it is owed the answer
  // that there is nowhere to write it, where a close is not.
  await assert.rejects(() => rows.flush(), (err) => isZuError(err, 'ZuUsageError'))
})

test('a row of the wrong width is refused and names the columns', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.throws(
    () => rows.appendRow([3n]),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /carries 1 value and 'person' takes 2: id, name/)
      return true
    },
  )
  // A synchronous refusal, so there is no GQLSTATUS: nothing reached
  // the engine.
  assert.equal(rows.buffered, 0)
})

test('a value that does not fit its column is refused where it was written', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.throws(
    () => rows.appendRow(['three', 'ida']),
    (err) => {
      assert.match(err.message, /value 0 of this row is a string/)
      assert.match(err.message, /column 'id' of 'person' holds whole numbers/)
      return true
    },
  )

  // Nothing of the refused row is kept, so the column that did take its
  // value has given it back and the next row is a whole one.
  rows.appendRow([3n, 'ida'])
  assert.equal(rows.buffered, 1)
  await rows.close()

  const found = await conn.query(PEOPLE)
  assert.deepEqual(
    found.map((row) => row.name),
    ['ada', 'zoe', 'ida'],
  )
})

test('a whole number goes into an INT64 column and a fraction does not', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  // A caller writing row literals writes 3 rather than 3n, and refusing
  // that would be pedantry.
  rows.appendRow([3, 'ida'])

  assert.throws(
    () => rows.appendRow([3.5, 'eve']),
    (err) => {
      assert.match(err.message, /it is 3.5, which is not a whole number/)
      return true
    },
  )
  assert.throws(
    () => rows.appendRow([2 ** 60, 'eve']),
    (err) => {
      assert.match(err.message, /past 2\^53/)
      assert.match(err.message, /write it as a bigint/)
      return true
    },
  )

  await rows.close()
  const found = await conn.query(PEOPLE)
  assert.equal(found[2].id, 3n)
})

test('one bad row in a batch says which one it was', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.throws(
    () =>
      rows.appendRows([
        [3n, 'ida'],
        [4n, 'eve'],
        [5n, 6n],
      ]),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /^row 2 of these: /)
      assert.match(err.message, /column 'name' of 'person' holds strings/)
      return true
    },
  )

  // The rows before it stay: nothing here is a transaction until the
  // flush, and throwing away work the caller can keep would not make it
  // one. The count is where they start again.
  assert.equal(rows.buffered, 2)
  await rows.close()
  assert.equal(await people(conn), 4)
})

test('something that is not an array of rows is refused', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  assert.throws(
    () => rows.appendRows({ id: 3n, name: 'ida' }),
    (err) => {
      assert.match(err.message, /rows are an array of arrays/)
      return true
    },
  )
  assert.throws(
    () => rows.appendRow({ id: 3n, name: 'ida' }),
    (err) => {
      assert.match(err.message, /a row is an array of one value per column of 'person'/)
      return true
    },
  )
})

test('every column type the engine stores takes a value', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec(
    "INSERT (e:event {id: 1, on: DATE '2024-01-02', at: LOCAL DATETIME '2024-01-02T03:04:05', " +
      "took: DURATION 'PT1H', hot: true, ratio: 1.5})",
  )

  const rows = await conn.appender('event')
  rows.appendRow([
    2n,
    new ZuDate(20_000),
    new ZuTimestamp(1_700_000_000_000_000_000n),
    ZuDuration.ofNanos(7_200_000_000_000n),
    false,
    2.5,
  ])
  assert.equal(await rows.close(), 1)

  const found = await conn.query(
    'MATCH (e:event) RETURN e.id AS id, e.on AS on, e.at AS at, e.took AS took, e.hot AS hot, ' +
      'e.ratio AS ratio',
  )
  assert.equal(found.length, 2)
  assert.equal(found[1].on.days, 20_000)
  assert.equal(found[1].at.nanos, 1_700_000_000_000_000_000n)
  assert.equal(found[1].took.nanos, 7_200_000_000_000n)
  assert.equal(found[1].hot, false)
  assert.equal(found[1].ratio, 2.5)
})

test('a timestamp with an offset does not go in a column of local ones', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec("INSERT (e:event {id: 1, at: LOCAL DATETIME '2024-01-02T03:04:05'})")

  const rows = await conn.appender('event')
  assert.throws(
    () => rows.appendRow([2n, new ZuTimestamp(0n, 120)]),
    (err) => {
      // Saying so beats dropping the offset or writing it as though the
      // instant were local, which are the two ways to be quietly wrong.
      assert.match(err.message, /it carries an offset, and this column holds local datetimes/)
      return true
    },
  )
})

test('a rel table takes the two ends of an edge', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.exec('MATCH (a:person), (b:person) INSERT (a)-[:knows]->(b)')

  const edges = await conn.appender('knows')
  // Named for the tables the edge runs between, since that is what a
  // row of a rel table is.
  assert.equal(edges.table, 'knows')
  edges.appendRow([1n, 0n])
  assert.equal(await edges.close(), 1)

  const found = await conn.query('MATCH (a:person)-[:knows]->(b:person) RETURN a.name AS a, b.name AS b')
  assert.ok(found.some((row) => row.a === 'zoe' && row.b === 'ada'), JSON.stringify(found))
})

test('an edge to a row that is not there is refused before anything is written', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.exec('MATCH (a:person), (b:person) INSERT (a)-[:knows]->(b)')
  const before = await conn.query('MATCH ()-[r:knows]->() RETURN count(*) AS n')

  const edges = await conn.appender('knows')
  edges.appendRow([0n, 99n])
  await assert.rejects(
    () => edges.close(),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /joins row 99 of 'person', which has 2 rows in it/)
      return true
    },
  )

  // The batch was refused and the file was not touched, which is the
  // point of checking it here: the engine's own check comes after the
  // write is durable.
  const after = await conn.query('MATCH ()-[r:knows]->() RETURN count(*) AS n')
  assert.equal(after[0].n, before[0].n)
  // And the rows are still buffered, for a caller who wants to look at
  // what did not go in.
  assert.equal(edges.buffered, 1)
})

test('a negative offset is refused where it was appended', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.exec('MATCH (a:person), (b:person) INSERT (a)-[:knows]->(b)')

  const edges = await conn.appender('knows')
  assert.throws(
    () => edges.appendRow([0n, -1n]),
    (err) => {
      assert.match(err.message, /holds row offsets, which count from zero/)
      return true
    },
  )
})

test('a table that is not there is refused when the appender opens', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.appender('nobody'),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /there is no table 'nobody' in this database/)
      return true
    },
  )
})

test('an appender on a closed connection is refused as a rejection', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(
    () => conn.appender('person'),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /the connection is closed/)
      return true
    },
  )
})

test('a connection closed under an open appender refuses the row that follows', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  conn.close()

  // Refused at the append rather than at the flush, because otherwise
  // whether a row was taken would depend on whether the batch happened
  // to fill, which is a rule nobody can hold in their head.
  assert.throws(
    () => rows.appendRow([3n, 'ida']),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /the connection is closed/)
      return true
    },
  )
})

test('a table name that is not a string is refused', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.appender(7),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      return true
    },
  )
})

test('a second flush while one is running is refused rather than queued', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  for (let at = 0; at < 500; at += 1) rows.appendRow([BigInt(at), `p${at}`])

  const running = rows.flush()
  // Issued before the first has answered, so it is refused here on the
  // runtime thread rather than queued behind a commit on a threadpool
  // one. Two commits of the same buffer would be two writes whose order
  // nobody chose.
  await assert.rejects(
    () => rows.flush(),
    (err) => {
      assert.ok(isZuError(err, 'ZuUsageError'), err.message)
      assert.match(err.message, /await the flush/)
      return true
    },
  )
  // And an append is refused for the same reason a statement behind a
  // half-read stream is: waiting for it would be the event loop waiting
  // for a write to disk.
  assert.throws(() => rows.appendRow([500n, 'late']), (err) => isZuError(err, 'ZuUsageError'))

  assert.equal(await running, 500)
  // The refusal released nothing that was running, so the appender is
  // usable the moment the flush has answered.
  rows.appendRow([500n, 'late'])
  assert.equal(await rows.close(), 501)
  assert.equal(await people(conn), 503)
})

test('an appender writes what a rollback does not take back', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  const tx = await conn.transaction()
  rows.appendRow([3n, 'ida'])
  await rows.flush()
  await tx.rollback()
  await rows.close()

  // The engine's shape today rather than a decision made here: an
  // appender writes through the file rather than through the session,
  // so a load and a transaction are two different things to reach for.
  assert.equal(await people(conn), 3)
})

test('two appenders on one connection each write their own rows', async (t) => {
  const { conn } = await twoPeople(t)

  const first = await conn.appender('person')
  const second = await conn.appender('person')
  first.appendRow([3n, 'ida'])
  second.appendRow([4n, 'eve'])

  assert.equal(await first.close(), 1)
  assert.equal(await second.close(), 1)
  assert.equal(await people(conn), 4)
})

test('a statement runs between one append and the next', async (t) => {
  const { conn } = await twoPeople(t)

  const rows = await conn.appender('person')
  rows.appendRow([3n, 'ida'])
  // Nothing is held while rows are buffered, which is what the buffers
  // being on this side buys: the connection is free between flushes.
  assert.equal(await people(conn), 2)
  rows.appendRow([4n, 'eve'])
  await rows.close()

  assert.equal(await people(conn), 4)
})
