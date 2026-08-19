// A result read down its columns.
//
// The buffers are the engine's own and they cross the boundary as a
// pointer and a length, so what these assert is both halves of that:
// that the numbers in them are the numbers the statement produced, and
// that the layout is the one every columnar reader already knows, down
// to which bit of which byte a boolean sits in.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Bool,
  DateDay,
  DurationNanosecond,
  Float64,
  Int64,
  LargeUtf8,
  makeData,
  Table,
  TimeNanosecond,
  TimestampNanosecond,
  Utf8,
  Vector,
} from 'apache-arrow'

import { fresh, isZuError, twoPeople } from './helper.mjs'

// The columns by name, since a test asks about one of them and the
// order they were projected in is asserted where it is the question.
function named(read) {
  return Object.fromEntries(read.columns.map((column) => [column.name, column]))
}

// A string column read back out of its bytes and offsets, which is the
// walk a caller writes once and the one thing about the layout worth
// showing in full.
function strings(column) {
  const text = new TextDecoder()
  const out = []
  for (let row = 0; row < column.length; row += 1) {
    const from = Number(column.offsets[row])
    const to = Number(column.offsets[row + 1])
    out.push(text.decode(column.data.subarray(from, to)))
  }
  return out
}

// Whether row `at` has a value, which is one bit of one byte and the
// same test every columnar format uses.
function valid(column, at) {
  return column.validity === null || (column.validity[at >> 3] & (1 << (at & 7))) !== 0
}

test('a column of integers is a BigInt64Array of the values', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.id AS id')

  assert.equal(read.rows, 2)
  assert.equal(read.columns.length, 1)
  const [id] = read.columns
  assert.equal(id.name, 'id')
  assert.equal(id.type, 'int')
  assert.equal(id.length, 2)
  assert.ok(id.values instanceof BigInt64Array)
  assert.deepEqual([...id.values], [1n, 2n])

  // Nothing else applies, and every one of them is present and null
  // rather than missing, so reading a column is a switch on its type.
  assert.equal(id.data, null)
  assert.equal(id.offsets, null)
  assert.equal(id.items, null)
  assert.equal(id.validity, null)
  assert.equal(id.nulls, 0)
  assert.equal(id.unit, null)
  assert.equal(id.zone, null)
})

test('the columns come back in the order the statement projected them', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.name AS name, p.id AS id')
  assert.deepEqual(read.columns.map((column) => column.name), ['name', 'id'])
})

test('a column of strings is bytes and offsets into them', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.name AS name')

  const [name] = read.columns
  assert.equal(name.type, 'string')
  assert.equal(name.values, null)
  assert.ok(name.data instanceof Uint8Array)
  // One offset more than there are rows: the last one closes the last
  // string, which is what lets row `i` be `offsets[i]` to `offsets[i+1]`
  // without a length beside it.
  assert.ok(name.offsets instanceof Int32Array)
  assert.equal(name.offsets.length, name.length + 1)
  assert.deepEqual([...name.offsets], [0, 3, 6])
  assert.deepEqual(strings(name), ['ada', 'zoe'])
})

test('a column of floats is a Float64Array', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec("INSERT (m:measure {id: 1, ratio: 1.5})")
  await conn.exec("INSERT (m:measure {id: 2, ratio: -0.25})")
  const read = await conn.columnar('MATCH (m:measure) RETURN m.ratio AS ratio')

  const [ratio] = read.columns
  assert.equal(ratio.type, 'float')
  assert.ok(ratio.values instanceof Float64Array)
  assert.deepEqual([...ratio.values], [1.5, -0.25])
})

test('a column of booleans is one bit a row, least significant first', async (t) => {
  const { conn } = await fresh(t)
  const yes = [true, false, true, false, true, true, false, true, false, true]
  for (const [ix, hot] of yes.entries()) {
    await conn.exec(`INSERT (f:flag {id: ${ix + 1}, hot: ${hot}})`)
  }
  const read = await conn.columnar('MATCH (f:flag) RETURN f.hot AS hot')

  const [hot] = read.columns
  assert.equal(hot.type, 'bool')
  assert.ok(hot.values instanceof Uint8Array)
  // Ten rows are two bytes, and the second holds two bits of value and
  // six of nothing.
  assert.equal(hot.values.length, 2)
  const bits = yes.map((_, at) => (hot.values[at >> 3] & (1 << (at & 7))) !== 0)
  assert.deepEqual(bits, yes)
})

test('a temporal column says what its cells count', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec(
    "INSERT (e:event {id: 1, on: DATE '2024-01-01', at: LOCAL DATETIME '2024-01-02T03:04:05', " +
      "took: DURATION 'PT1H'})",
  )
  const read = await conn.columnar(
    'MATCH (e:event) RETURN e.on AS on, e.at AS at, e.took AS took',
  )
  const { on, at, took } = named(read)

  assert.equal(on.type, 'date')
  assert.equal(on.unit, 'days')
  assert.ok(on.values instanceof Int32Array)
  assert.deepEqual([...on.values], [19_723])

  assert.equal(at.type, 'datetime')
  assert.equal(at.unit, 'nanos')
  assert.deepEqual([...at.values], [1_704_164_645_000_000_000n])

  assert.equal(took.type, 'duration')
  assert.equal(took.unit, 'nanos')
  assert.deepEqual([...took.values], [3_600_000_000_000n])
})

test('a duration of months counts months rather than nanoseconds', async (t) => {
  const { conn } = await fresh(t)
  const read = await conn.columnar("RETURN DURATION 'P14M' AS every")

  const [every] = read.columns
  assert.equal(every.type, 'duration')
  assert.equal(every.unit, 'months')
  assert.deepEqual([...every.values], [14n])
})

test('a zoned column carries its offset beside the cells', async (t) => {
  const { conn } = await fresh(t)
  const read = await conn.columnar(
    "RETURN ZONED TIME '03:04:05+02:00' AS t, ZONED DATETIME '2024-01-02T03:04:05+02:00' AS d",
  )
  const { t: at, d } = named(read)

  // The type is the physical one, since a time with an offset and a
  // time without are the same 64 bit cells, and the offset is the
  // minutes east of UTC the column was written with.
  assert.equal(at.type, 'time')
  assert.equal(at.zone, 120)
  assert.equal(d.type, 'datetime')
  assert.equal(d.zone, 120)
})

test('a null row keeps its cell and clears its bit', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar(
    'MATCH (p:person) RETURN CASE WHEN p.id = 1 THEN p.id ELSE null END AS maybe',
  )

  const [maybe] = read.columns
  assert.equal(maybe.type, 'int')
  assert.equal(maybe.nulls, 1)
  assert.ok(maybe.validity instanceof Uint8Array)
  // The null row still occupies its cell, holding the type's zero,
  // which is what lets the buffer be strided and moved rather than
  // rebuilt.
  assert.deepEqual([...maybe.values], [1n, 0n])
  assert.equal(valid(maybe, 0), true)
  assert.equal(valid(maybe, 1), false)
})

test('a column with nothing null has no bitmap at all', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.id AS id')
  // Present would mean at least one null, so a caller never has to
  // count to find out whether the bits are worth attaching.
  assert.equal(read.columns[0].validity, null)
  assert.equal(read.columns[0].nulls, 0)
})

test('a column of nothing but nulls has a length and no buffer', async (t) => {
  const { conn } = await fresh(t)
  const read = await conn.columnar('RETURN null AS nothing')

  const [nothing] = read.columns
  assert.equal(nothing.type, 'null')
  assert.equal(nothing.length, 1)
  assert.equal(nothing.values, null)
  assert.equal(nothing.items, null)
})

test('what no buffer covers arrives as the values themselves', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar(
    'MATCH (p:person) RETURN p AS who, [p.id, p.id] AS pair, {name: p.name} AS record',
  )
  const { who, pair, record } = named(read)

  assert.equal(who.type, 'value')
  assert.equal(who.values, null)
  assert.equal(who.items.length, 2)
  assert.equal(who.items[0].table, 'person')
  assert.equal(who.items[0].offset, 0n)

  assert.equal(pair.type, 'value')
  assert.deepEqual(pair.items[0], [1n, 1n])

  assert.equal(record.type, 'value')
  assert.deepEqual(record.items[1], { name: 'zoe' })
})

test('a statement that matched nothing is columns of no rows', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar("MATCH (p:person) WHERE p.name = 'nobody' RETURN p.id AS id")

  assert.equal(read.rows, 0)
  assert.equal(read.columns.length, 1)
  assert.equal(read.columns[0].length, 0)
  // Nothing settled the type, so it is the type of nothing, which is
  // the one every columnar format has for exactly this.
  assert.equal(read.columns[0].type, 'null')
})

test('a statement that projects nothing has no columns and says so', async (t) => {
  const { conn } = await fresh(t)
  const read = await conn.columnar("INSERT (p:person {id: 1, name: 'ada'})")

  assert.equal(read.columns.length, 0)
  assert.equal(read.rows, 0)
  // 00001 is the standard's own way of saying the statement completed
  // and had no result to give back.
  assert.equal(read.gqlstatus, '00001')
})

test('the status and the notices ride beside the columns', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.id AS id')
  assert.equal(read.gqlstatus, '00000')
  assert.deepEqual(read.notices, [])
})

test('parameters bind the same way they do for rows', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar(
    'MATCH (p:person) WHERE p.name = $name RETURN p.id AS id',
    { name: 'zoe' },
  )
  assert.deepEqual([...read.columns[0].values], [2n])
})

test('a column that mixes two types is refused, with the row that did it', async (t) => {
  const { conn } = await twoPeople(t)
  const caught = await conn
    .columnar('MATCH (p:person) RETURN CASE WHEN p.id = 1 THEN p.id ELSE p.name END AS mixed')
    .then(() => null, (err) => err)

  // A column holds one type and a caller told which column and which
  // row can act on it, while one told neither goes looking through a
  // million rows by hand.
  assert.ok(isZuError(caught, 'ZuUsageError'))
  assert.match(caught.message, /column 'mixed' mixes integers and strings at row 1/)
})

test('the spelling of an integer is not a question a buffer answers', async (t) => {
  const { conn } = await twoPeople(t, { bigIntMode: 'number' })
  const read = await conn.columnar('MATCH (p:person) RETURN p.id AS id')

  // A columnar read has one physical layout per type, so the mode that
  // decides how a value is spelled has nothing to decide here. It still
  // decides inside `items`, where this client is making objects anyway.
  assert.ok(read.columns[0].values instanceof BigInt64Array)
  assert.deepEqual([...read.columns[0].values], [1n, 2n])
})

test('a statement can be stopped by a signal like any other', async (t) => {
  const { conn } = await twoPeople(t)
  const caught = await conn
    .columnar('MATCH (p:person) RETURN p.id AS id', null, { signal: AbortSignal.abort() })
    .then(() => null, (err) => err)

  assert.equal(caught.name, 'AbortError')
  // The connection is left exactly as it was, which is what makes a
  // stopped statement a stopped statement rather than a broken one.
  assert.equal((await conn.columnar('MATCH (p:person) RETURN p.id AS id')).rows, 2)
})

test('a closed connection refuses the call as a rejection', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.close()
  const caught = await conn
    .columnar('MATCH (p:person) RETURN p.id AS id')
    .then(() => null, (err) => err)
  assert.ok(isZuError(caught, 'ZuUsageError'))
})

test('a statement that is not a string is refused inside the promise', async (t) => {
  const { conn } = await fresh(t)
  const caught = await conn.columnar(42).then(() => null, (err) => err)
  assert.ok(isZuError(caught, 'ZuUsageError'))
  assert.match(caught.message, /the statement is a Number/)
})

test('the buffers are handed over rather than shared, so two reads are two buffers', async (t) => {
  const { conn } = await twoPeople(t)
  const first = await conn.columnar('MATCH (p:person) RETURN p.id AS id')
  const second = await conn.columnar('MATCH (p:person) RETURN p.id AS id')

  // Writing into one is writing into a buffer nothing else is reading,
  // which is what makes handing the memory over safe: the engine freed
  // its side of it when the array was made.
  first.columns[0].values[0] = 99n
  assert.deepEqual([...second.columns[0].values], [1n, 2n])
})

test('a million rows come back down one buffer and the loop stays free', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec("INSERT (n:number {id: 1, at: 1})")
  const rows = 1_000_000
  const appender = await conn.appender('number')
  for (let at = 2; at <= rows; at += 1) appender.appendRow([BigInt(at), BigInt(at)])
  await appender.close()

  let ticks = 0
  const timer = setInterval(() => (ticks += 1), 1)
  const read = await conn.columnar('MATCH (n:number) RETURN n.at AS at')
  clearInterval(timer)

  assert.equal(read.rows, rows)
  assert.equal(read.columns[0].values.length, rows)
  assert.equal(read.columns[0].values[rows - 1], BigInt(rows))
  // The whole read is on the threadpool, so the timer kept firing
  // throughout it rather than queueing behind it.
  assert.ok(ticks > 20, `the event loop ticked ${ticks} times`)
})

// The types every fixed-width column maps to, which is the whole of
// what a caller has to write to make the buffers an Arrow table.
const ARROW = {
  int: () => new Int64(),
  float: () => new Float64(),
  bool: () => new Bool(),
  string: (column) => (column.offsets instanceof Int32Array ? new Utf8() : new LargeUtf8()),
  date: () => new DateDay(),
  time: () => new TimeNanosecond(),
  datetime: () => new TimestampNanosecond(),
  duration: () => new DurationNanosecond(),
}

// The recipe the README prints, kept here so that it is run rather than
// believed. Nothing in the package imports `apache-arrow`, and this is
// what that costs a caller who wants one: eleven lines, once.
function tableOf(read) {
  const columns = {}
  for (const column of read.columns) {
    columns[column.name] = new Vector([
      makeData({
        type: ARROW[column.type](column),
        length: column.length,
        nullCount: column.nulls,
        nullBitmap: column.validity ?? undefined,
        data: column.data ?? column.values,
        valueOffsets: column.offsets ?? undefined,
      }),
    ])
  }
  return new Table(columns)
}

test('the columns become an Arrow table without being copied', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec(
    "INSERT (e:event {id: 1, name: 'ada', ratio: 1.5, hot: true, on: DATE '2024-01-01', " +
      "took: DURATION 'PT1H'})",
  )
  await conn.exec(
    "INSERT (e:event {id: 2, name: 'zoe', ratio: 2.5, hot: false, on: DATE '2024-02-01', " +
      "took: DURATION 'PT2H'})",
  )
  const read = await conn.columnar(
    'MATCH (e:event) RETURN e.id AS id, e.name AS name, e.ratio AS ratio, e.hot AS hot, ' +
      'e.on AS on, e.took AS took',
  )
  const table = tableOf(read)

  assert.equal(table.numRows, 2)
  assert.deepEqual(
    table.schema.fields.map((field) => `${field.name}:${field.type}`),
    [
      'id:Int64',
      'name:Utf8',
      'ratio:Float64',
      'hot:Bool',
      'on:Date32<DAY>',
      'took:Duration<NANOSECOND>',
    ],
  )
  assert.equal(table.getChild('id').get(1), 2n)
  assert.equal(table.getChild('name').get(0), 'ada')
  assert.equal(table.getChild('hot').get(1), false)

  // The same memory on both sides, which is the whole claim: the array
  // Arrow reads is the array the engine filled and not a copy of it.
  assert.equal(table.getChild('id').data[0].values, read.columns[0].values)
})

test('an Arrow table built this way keeps the nulls it was given', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar(
    'MATCH (p:person) RETURN CASE WHEN p.id = 1 THEN p.id ELSE null END AS maybe',
  )
  const table = tableOf(read)

  assert.equal(table.getChild('maybe').get(0), 1n)
  assert.equal(table.getChild('maybe').get(1), null)
  assert.equal(table.getChild('maybe').nullCount, 1)
})

test('the columns go straight back in as a frame', async (t) => {
  const { conn } = await twoPeople(t)
  const read = await conn.columnar('MATCH (p:person) RETURN p.id AS id')

  // The buffer that came out is a column a statement can match on,
  // which is what makes the two halves of this one shape: nothing is
  // decoded on the way out and nothing is encoded on the way back.
  assert.equal(await conn.register('ids', { id: read.columns[0].values }), 2)
  const found = await conn.query('MATCH (i:ids) WHERE i.id > 1 RETURN i.id AS id')
  assert.deepEqual(found.map((row) => row.id), [2n])
})
