// Frames, registered under a name a statement can match on.
//
// The point of the call is that columns a program already has become
// something a statement can read, and that reading them costs nothing:
// the engine is told where they are and reads them where they lie. So
// most of these register one and then match it, and the ones that matter
// most prove the two halves of that claim, which are that the bytes are
// never copied and that they are handed back when the name goes.
//
// `apache-arrow` is a dev dependency and not a dependency: the client
// recognizes a table by its shape rather than by its class, so what
// these tests exercise is the same path any other library that speaks
// that shape would take.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Binary,
  Bool,
  RecordBatch,
  Table,
  TimeUnit,
  Timestamp,
  Utf8,
  tableFromArrays,
  vectorFromArray,
} from 'apache-arrow'
import { ZuDate, ZuDuration, ZuTimestamp, connect } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

// The `name` column of a registered frame, in the order it went in.
async function names(conn, table) {
  const rows = await conn.query(`MATCH (f:${table}) RETURN f.name AS name`)
  return rows.map((row) => row.name)
}

test('an object of arrays is a frame', async (t) => {
  const { conn } = await fresh(t)

  // The way in for a program with no columnar library at all.
  assert.equal(await conn.register('people', { uid: [1, 2, 3], name: ['ada', 'grace', 'lynn'] }), 3)
  assert.deepEqual(await names(conn, 'people'), ['ada', 'grace', 'lynn'])
})

test('a statement reads a registered frame like any other table', async (t) => {
  const { conn } = await fresh(t)
  await conn.register('people', {
    uid: [1, 2, 3],
    name: ['ada', 'grace', 'lynn'],
    age: [36, 45, 52],
  })

  const rows = await conn.query('MATCH (p:people) WHERE p.age > 40 RETURN p.name AS name')
  assert.deepEqual(
    rows.map((row) => row.name),
    ['grace', 'lynn'],
  )
})

test('an object of typed arrays is read where it lies', async (t) => {
  const { conn } = await fresh(t)

  const uid = new BigInt64Array([1n, 2n, 3n])
  assert.equal(await conn.register('numbers', { uid }), 3)
  const before = await conn.query('MATCH (n:numbers) RETURN sum(n.uid) AS total')
  assert.equal(before[0].total, 6n)

  // Written into between two statements, and the second one answers the
  // new number. No copy taken at registration could do that.
  uid[0] = 1000n
  const after = await conn.query('MATCH (n:numbers) RETURN sum(n.uid) AS total')
  assert.equal(after[0].total, 1005n)
})

test('an arrow table goes in', async (t) => {
  const { conn } = await fresh(t)

  const table = tableFromArrays({
    uid: new BigInt64Array([1n, 2n]),
    name: vectorFromArray(['ada', 'grace'], new Utf8()),
  })
  assert.equal(await conn.register('people', table), 2)
  assert.deepEqual(await names(conn, 'people'), ['ada', 'grace'])
})

test('a record batch is a frame too', async (t) => {
  const { conn } = await fresh(t)

  const table = tableFromArrays({
    uid: new BigInt64Array([1n, 2n]),
    name: vectorFromArray(['ada', 'grace'], new Utf8()),
  })
  const [batch] = table.batches
  assert.ok(batch instanceof RecordBatch)
  assert.equal(await conn.register('people', batch), 2)
  assert.deepEqual(await names(conn, 'people'), ['ada', 'grace'])
})

test('a column of several chunks is one column', async (t) => {
  const { conn } = await fresh(t)

  // A column of a table is one run of bytes, so this is the one arrow
  // shape that costs a memcpy per column on the way in.
  const batch = (uid, name) =>
    tableFromArrays({
      uid: new BigInt64Array(uid),
      name: vectorFromArray(name, new Utf8()),
    }).batches[0]
  const joined = new Table([batch([1n, 2n], ['ada', 'grace']), batch([3n], ['lynn'])])
  assert.equal(joined.getChildAt(0).data.length, 2)

  assert.equal(await conn.register('people', joined), 3)
  assert.deepEqual(await names(conn, 'people'), ['ada', 'grace', 'lynn'])
})

test('a sliced column is read from the row it starts at', async (t) => {
  const { conn } = await fresh(t)

  // A slice is a column with a row offset, which is the one thing a bare
  // pointer cannot say, so the words are pointed at further in and the
  // offsets of a string column are rebased.
  const table = tableFromArrays({
    uid: new BigInt64Array([1n, 2n, 3n, 4n]),
    name: vectorFromArray(['a', 'b', 'c', 'd'], new Utf8()),
    yes: vectorFromArray([true, false, true, false], new Bool()),
  })
  assert.equal(await conn.register('people', table.slice(1, 3)), 2)
  assert.deepEqual(await names(conn, 'people'), ['b', 'c'])

  // The numbers as well as the words, because a slice moves a column of
  // words and a column of characters in two different ways and only one
  // of them shows up in the names.
  const rows = await conn.query(
    'MATCH (p:people) RETURN p.uid AS uid, p.name AS name, p.yes AS yes',
  )
  assert.deepEqual(
    rows.map((row) => [row.uid, row.name, row.yes]),
    [
      [2n, 'b', false],
      [3n, 'c', true],
    ],
  )
})

test('a boolean column sliced partway through a byte is rebuilt', async (t) => {
  const { conn } = await fresh(t)

  // A bitmap is read from a byte boundary, so a chunk that starts at
  // row three is the one case where the bits are laid out again.
  const yes = [true, false, true, false, true, true, false, true, false, true]
  const table = tableFromArrays({ yes: vectorFromArray(yes, new Bool()) })
  assert.equal(await conn.register('flags', table.slice(3, 9)), 6)

  const rows = await conn.query('MATCH (f:flags) RETURN f.yes AS yes')
  assert.deepEqual(
    rows.map((row) => row.yes),
    yes.slice(3, 9),
  )
})

test('every kind of column a row can hold arrives as itself', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('kinds', {
    yes: [true, false],
    small: new Int8Array([1, 2]),
    wide: new Uint32Array([3, 4]),
    narrow: new Float32Array([1.5, 2.5]),
    word: ['a', 'b'],
    day: [new ZuDate(19723), new ZuDate(19754)],
    moment: [new ZuTimestamp(1_704_070_923_000_000_000n), new ZuTimestamp(0n)],
    span: [ZuDuration.ofNanos(90_000_000_000n), ZuDuration.ofNanos(0n)],
  })

  const rows = await conn.query(
    'MATCH (k:kinds) RETURN k.yes AS yes, k.small AS small, k.wide AS wide, ' +
      'k.narrow AS narrow, k.word AS word, k.day AS day, k.moment AS moment, k.span AS span',
  )
  assert.equal(rows[0].yes, true)
  assert.equal(rows[0].small, 1n)
  assert.equal(rows[0].wide, 3n)
  assert.equal(rows[0].narrow, 1.5)
  assert.equal(rows[0].word, 'a')
  assert.equal(rows[0].day.days, 19723)
  assert.equal(rows[0].moment.nanos, 1_704_070_923_000_000_000n)
  assert.equal(rows[0].span.nanos, 90_000_000_000n)
  assert.equal(rows[1].yes, false)
})

test('an arrow column of every width arrives as itself', async (t) => {
  const { conn } = await fresh(t)

  const table = tableFromArrays({
    small: new Int8Array([1, 2]),
    wide: new Uint32Array([3, 4]),
    narrow: new Float32Array([1.5, 2.5]),
    big: new Float64Array([1.25, 2.25]),
  })
  assert.equal(await conn.register('widths', table), 2)
  const rows = await conn.query(
    'MATCH (w:widths) RETURN w.small AS small, w.wide AS wide, w.narrow AS narrow, w.big AS big',
  )
  assert.equal(rows[0].small, 1n)
  assert.equal(rows[0].wide, 3n)
  assert.equal(rows[0].narrow, 1.5)
  assert.equal(rows[0].big, 1.25)
})

test('an object of plain arrays is copied because an array is not a column', async (t) => {
  const { conn } = await fresh(t)

  // The one way in that does copy, and the reason it has to.
  const name = ['ada']
  await conn.register('people', { uid: [1], name })
  name[0] = 'grace'
  assert.deepEqual(await names(conn, 'people'), ['ada'])
})

test('a column of whole numbers that meets a fractional one widens', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('numbers', { n: [1, 2, 2.5] })
  const rows = await conn.query('MATCH (x:numbers) RETURN sum(x.n) AS total')
  assert.equal(rows[0].total, 5.5)
})

test('a frame belongs to the connection that registered it', async (t) => {
  const { conn, path } = await fresh(t)
  await conn.register('people', { uid: [1], name: ['ada'] })

  // Nothing is written to the database, so another connection to the
  // same file has never heard of it.
  const other = await connect(path)
  t.after(() => other.close())
  assert.deepEqual(await other.registered(), [])
  assert.deepEqual(await names(other, 'people'), [])
})

test('registered says what is registered here', async (t) => {
  const { conn } = await fresh(t)

  assert.deepEqual(await conn.registered(), [])
  await conn.register('second', { a: [1] })
  await conn.register('first', { a: [1] })
  assert.deepEqual(await conn.registered(), ['first', 'second'])
})

test('registering a name again replaces what it stands for', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('people', { uid: [1, 2], name: ['ada', 'grace'] })
  assert.equal(await conn.register('people', { uid: [3], name: ['lynn'] }), 1)
  assert.deepEqual(await names(conn, 'people'), ['lynn'])
})

test('a name registered again may hold a different shape', async (t) => {
  const { conn } = await fresh(t)

  // A frame is not a table, so nothing about the first registration
  // survives the second.
  await conn.register('people', { uid: [1], name: ['ada'] })
  await conn.register('people', { name: ['grace'], age: [45] })
  const rows = await conn.query('MATCH (p:people) RETURN p.name AS name, p.age AS age')
  assert.equal(rows[0].name, 'grace')
  assert.equal(rows[0].age, 45n)
})

test('unregister takes the name away', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('people', { uid: [1, 2], name: ['ada', 'grace'] })
  await conn.unregister('people')
  assert.deepEqual(await conn.registered(), [])
  assert.deepEqual(await names(conn, 'people'), [])
})

test('a name that was unregistered can be registered again', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('people', { uid: [1], name: ['ada'] })
  await conn.unregister('people')
  assert.equal(await conn.register('people', { uid: [2], name: ['grace'] }), 1)
  assert.deepEqual(await names(conn, 'people'), ['grace'])
})

test('unregistering twice is refused', async (t) => {
  const { conn } = await fresh(t)

  await conn.register('people', { a: [1] })
  await conn.unregister('people')
  await assert.rejects(conn.unregister('people'), (err) => {
    assert.ok(isZuError(err, 'ZuUsageError'))
    assert.match(err.message, /nothing is registered here/)
    return true
  })
})

test('unregistering a table nobody registered is refused', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(conn.unregister('person'), (err) => {
    assert.match(err.message, /nothing is registered here/)
    return true
  })
})

test('registering over a table of the database is refused', async (t) => {
  const { conn } = await twoPeople(t)

  // A statement naming it would mean the stored one.
  await assert.rejects(conn.register('person', { uid: [1] }), (err) => {
    assert.match(err.message, /already a table of this database/)
    return true
  })
})

test('nothing writes to a registered frame', async (t) => {
  const { conn } = await fresh(t)

  // It is the caller's memory, read where it lies, and a statement that
  // wrote into it would be writing into the caller's array.
  await conn.register('people', { uid: [1], name: ['ada'] })
  await assert.rejects(conn.exec("INSERT (p:people {uid: 2, name: 'grace'})"), (err) => {
    assert.match(err.message, /never written/)
    return true
  })
  await assert.rejects(conn.exec('MATCH (p:people) DETACH DELETE p'), (err) => {
    assert.match(err.message, /never written/)
    return true
  })
})

test('a null anywhere is refused by column and row', async (t) => {
  const { conn } = await fresh(t)

  // A property that is null is one no row of this engine can hold.
  const table = tableFromArrays({
    uid: new BigInt64Array([1n, 2n, 3n]),
    name: vectorFromArray(['ada', null, 'lynn'], new Utf8()),
  })
  await assert.rejects(conn.register('people', table), (err) => {
    assert.match(err.message, /column 'name' has no value at row 1/)
    return true
  })
})

test('a frame with no rows registers and matches nothing', async (t) => {
  const { conn } = await fresh(t)

  // A frame knows what its columns are without being told by a row, so
  // a filter that came back empty is still a table to match on.
  assert.equal(await conn.register('people', { uid: new BigInt64Array(0) }), 0)
  const rows = await conn.query('MATCH (p:people) RETURN count(*) AS n')
  assert.equal(rows[0].n, 0n)
})

test('a frame with no columns is refused', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('people', {}), (err) => {
    assert.match(err.message, /no columns/)
    return true
  })
})

test('an empty column says nothing about what it would hold', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('people', { uid: [] }), (err) => {
    assert.match(err.message, /column 'uid' is empty/)
    return true
  })
})

test('a name a statement could not carry is refused', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('two words', { a: [1] }), (err) => {
    assert.match(err.message, /not a name a statement can carry/)
    return true
  })
  await assert.rejects(conn.register('people', { 'two words': [1] }), (err) => {
    assert.match(err.message, /a column of a registered frame/)
    return true
  })
})

test('a zoned timestamp is refused with what to do about it', async (t) => {
  const { conn } = await fresh(t)

  const table = tableFromArrays({
    when: vectorFromArray(
      [new Date(1_700_000_000_000)],
      new Timestamp(TimeUnit.MILLISECOND, 'UTC'),
    ),
  })
  await assert.rejects(conn.register('moments', table), (err) => {
    assert.match(err.message, /nowhere to keep/)
    return true
  })
})

test('a dictionary is a layout rather than a type', async (t) => {
  const { conn } = await fresh(t)

  // What `tableFromArrays` makes of a plain array of strings, which is
  // the mistake a caller is most likely to make by accident.
  const table = tableFromArrays({ name: ['ada', 'grace'] })
  await assert.rejects(conn.register('people', table), (err) => {
    assert.match(err.message, /a dictionary is a layout rather than a type/)
    return true
  })
})

test('a column of bytes is refused', async (t) => {
  const { conn } = await fresh(t)

  // Naming one would be naming data no statement reads back.
  const table = tableFromArrays({ raw: vectorFromArray([new Uint8Array([1])], new Binary()) })
  await assert.rejects(conn.register('blobs', table), (err) => {
    assert.match(err.message, /column of bytes/)
    return true
  })
})

test('an integer too large for a column is refused by row', async (t) => {
  const { conn } = await fresh(t)

  // Checked once, at registration, so that reading a frame cannot fail:
  // the engine's lane is signed and this value is not in it.
  await assert.rejects(
    conn.register('numbers', { big: new BigUint64Array([1n, 1n << 63n]) }),
    (err) => {
      assert.match(err.message, /at row 1/)
      return true
    },
  )
})

test('a column that is as long as the one before it', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('people', { uid: [1, 2], name: ['ada'] }), (err) => {
    assert.match(err.message, /a table is as wide as it is long/)
    return true
  })
})

test('something that is not a frame at all is refused with the list', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('people', [1, 2, 3]), (err) => {
    assert.match(err.message, /a frame is an Arrow table/)
    return true
  })
  await assert.rejects(conn.register('people', 'ada'), (err) => {
    assert.match(err.message, /a frame is an Arrow table/)
    return true
  })
})

test('a column that is neither an array nor a typed array is refused', async (t) => {
  const { conn } = await fresh(t)

  await assert.rejects(conn.register('people', { uid: 1 }), (err) => {
    assert.match(err.message, /column 'uid' is a number/)
    return true
  })
})

test('registering inside a transaction is refused', async (t) => {
  const { conn } = await fresh(t)

  // A frame is registered on the session, which is the thing a
  // transaction is running on, and a rollback has nothing to say about
  // memory the caller owns.
  await using tx = await conn.transaction()
  assert.ok(tx)
  await assert.rejects(conn.register('people', { a: [1, 2] }), (err) => {
    assert.match(err.message, /not inside a transaction/)
    return true
  })
})

test('a closed connection registers nothing', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(conn.register('people', { a: [1] }), (err) => {
    assert.ok(isZuError(err, 'ZuUsageError'))
    assert.match(err.message, /closed/)
    return true
  })
  await assert.rejects(conn.unregister('people'), (err) => {
    assert.match(err.message, /closed/)
    return true
  })
  await assert.rejects(conn.registered(), (err) => {
    assert.match(err.message, /closed/)
    return true
  })
})

test('registering costs the same whatever the frame holds', async (t) => {
  const { conn } = await fresh(t)

  // Nothing is copied, so nothing about the call is per row. Five
  // million rows against ten, and the budget is loose by a wide margin:
  // it is here to catch a way in that started walking the rows rather
  // than to hold a number.
  const best = {}
  for (const rows of [10, 5_000_000]) {
    const n = new BigInt64Array(rows)
    best[rows] = Infinity
    for (let round = 0; round < 5; round += 1) {
      const started = process.hrtime.bigint()
      await conn.register('numbers', { n })
      best[rows] = Math.min(best[rows], Number(process.hrtime.bigint() - started) / 1e6)
    }
  }
  assert.ok(best[5_000_000] < 2, `registering 5m rows took ${best[5_000_000].toFixed(2)} ms`)
})
