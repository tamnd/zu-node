// A result as Arrow, in the bytes Arrow ships between processes.
//
// The translation lives in the engine and is tested there against the
// arrays it builds. What these check is the half that is this client's:
// that the bytes are a stream `apache-arrow` reads, that what comes out
// of it is what the statement produced, and that a call which cannot
// mean anything is refused with a reason rather than with a buffer.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { tableFromIPC } from 'apache-arrow'
import { connect, load } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

// The table the bytes hold, which is the whole of what a caller writes.
function read(answer) {
  return tableFromIPC(answer.ipc)
}

// One column by name, since a test asks about one of them and the order
// they were projected in is asserted where it is the question.
function column(table, name) {
  const at = table.schema.fields.findIndex((field) => field.name === name)
  assert.notEqual(at, -1, `no column called ${name}`)
  return table.getChildAt(at)
}

// What a column holds, as plain JavaScript values in row order.
function values(table, name) {
  return [...column(table, name)]
}

// The graph with edges in it, since a load is the only way a JavaScript
// program makes one: three people and the two edges between them.
async function three(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-arrow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'g.zu1')
  await load(path, {
    nodes: 'person',
    rels: 'knows',
    columns: { uid: [10, 20, 30], name: ['ada', 'grace', 'kay'] },
    edges: [
      [0, 1],
      [1, 2],
    ],
  })
  const conn = await connect(path, { readOnly: true })
  t.after(() => conn.close())
  return { conn, path }
}

test('a result is a stream apache-arrow reads without being told anything', async (t) => {
  const { conn } = await twoPeople(t)
  const answer = await conn.arrow('MATCH (p:person) RETURN p.id AS id, p.name AS name')

  assert.equal(answer.rows, 2)
  assert.ok(answer.ipc instanceof Uint8Array)
  const table = read(answer)
  assert.equal(table.numRows, 2)
  // The schema travels with the bytes, so the reader knows the columns
  // and their types without a second call and without a convention.
  assert.deepEqual(
    table.schema.fields.map((field) => [field.name, String(field.type)]),
    [
      ['id', 'Int64'],
      ['name', 'Utf8'],
    ],
  )
  assert.deepEqual(values(table, 'id'), [1n, 2n])
  assert.deepEqual(values(table, 'name'), ['ada', 'zoe'])
})

test('the columns come back in the order the statement projected them', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(await conn.arrow('MATCH (p:person) RETURN p.name AS name, p.id AS id'))
  assert.deepEqual(table.schema.fields.map((field) => field.name), ['name', 'id'])
})

test('floats and booleans are the Arrow types they are', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec('INSERT (m:measure {id: 1, ratio: 1.5, hot: true})')
  await conn.exec('INSERT (m:measure {id: 2, ratio: -0.25, hot: false})')
  const table = read(await conn.arrow('MATCH (m:measure) RETURN m.ratio AS ratio, m.hot AS hot'))

  assert.equal(String(column(table, 'ratio').type), 'Float64')
  assert.deepEqual(values(table, 'ratio'), [1.5, -0.25])
  assert.equal(String(column(table, 'hot').type), 'Bool')
  assert.deepEqual(values(table, 'hot'), [true, false])
})

test('a temporal column is the Arrow type that counts the same thing', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec(
    "INSERT (e:event {id: 1, on: DATE '2024-01-01', at: LOCAL DATETIME '2024-01-02T03:04:05', " +
      "took: DURATION 'PT1H'})",
  )
  const table = read(
    await conn.arrow('MATCH (e:event) RETURN e.on AS on, e.at AS at, e.took AS took'),
  )

  // A date is days, a datetime is nanoseconds, and a day-time duration
  // is a duration rather than an interval, which is the difference
  // between a length of time and a calendar step.
  assert.equal(String(column(table, 'on').type), 'Date32<DAY>')
  assert.equal(String(column(table, 'at').type), 'Timestamp<NANOSECOND>')
  assert.equal(String(column(table, 'took').type), 'Duration<NANOSECOND>')
})

test('a zoned datetime carries its zone in the type', async (t) => {
  const { conn } = await fresh(t)
  const table = read(
    await conn.arrow("RETURN ZONED DATETIME '2024-01-02T03:04:05+02:00' AS d"),
  )
  // Arrow says the zone on the field rather than on the value, and an
  // offset is a zone Arrow accepts as one.
  assert.match(String(column(table, 'd').type), /\+02:00/)
})

test('a year-month duration is a month interval and not a count of nanoseconds', async (t) => {
  const { conn } = await fresh(t)
  const table = read(await conn.arrow("RETURN DURATION 'P14M' AS every"))
  assert.match(String(column(table, 'every').type), /Interval/)
})

test('a null row is a null and not a zero', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(
    await conn.arrow('MATCH (p:person) RETURN CASE WHEN p.id = 1 THEN p.id ELSE null END AS maybe'),
  )
  assert.deepEqual(values(table, 'maybe'), [1n, null])
  assert.equal(column(table, 'maybe').nullCount, 1)
})

test('a node column is a struct naming the table it came from', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(await conn.arrow('MATCH (p:person) RETURN p AS who'))

  const who = column(table, 'who')
  assert.match(String(who.type), /Struct/)
  assert.deepEqual(
    [...who].map((node) => [node.table, node.offset]),
    [
      ['person', 0n],
      ['person', 1n],
    ],
  )
})

test('an edge column is a struct with the ends it joins', async (t) => {
  const { conn } = await three(t)
  const table = read(await conn.arrow('MATCH ()-[r:knows]->() RETURN r AS r'))

  assert.deepEqual(
    [...column(table, 'r')].map((rel) => [rel.table, rel.src, rel.dst, rel.ord]),
    [
      ['knows', 0n, 1n, 0n],
      ['knows', 1n, 2n, 1n],
    ],
  )
})

test('a path is the nodes it walked and the edges it crossed', async (t) => {
  const { conn } = await three(t)
  const table = read(
    await conn.arrow('MATCH q = (a:person)-[:knows]->()-[:knows]->(c:person) RETURN q AS q'),
  )

  // Two lists rather than one alternating list, because Arrow has no
  // type for a list whose elements change shape, and a walk is one more
  // node than edge either way.
  const [walk] = [...column(table, 'q')]
  assert.deepEqual([...walk.nodes].map((node) => node.offset), [0n, 1n, 2n])
  assert.deepEqual(
    [...walk.rels].map((rel) => [rel.src, rel.dst]),
    [
      [0n, 1n],
      [1n, 2n],
    ],
  )
})

test('a list is an Arrow list and a record is an Arrow struct', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(
    await conn.arrow('MATCH (p:person) RETURN [p.id, p.id] AS pair, {name: p.name} AS held'),
  )

  assert.match(String(column(table, 'pair').type), /List/)
  assert.deepEqual([...[...column(table, 'pair')][0]], [1n, 1n])
  assert.equal([...column(table, 'held')][1].name, 'zoe')
})

test('a statement that matched nothing still says what its columns were', async (t) => {
  const { conn } = await twoPeople(t)
  const answer = await conn.arrow(
    "MATCH (p:person) WHERE p.name = 'nobody' RETURN p.id AS id, p.name AS name",
  )

  assert.equal(answer.rows, 0)
  const table = read(answer)
  assert.equal(table.numRows, 0)
  // The plan declared the types, so an empty answer has the schema a
  // full one would have had, which is what makes a table built from one
  // concatenable with a table built from the other.
  assert.deepEqual(
    table.schema.fields.map((field) => String(field.type)),
    ['Int64', 'Utf8'],
  )
})

test('a statement that projects nothing has no columns and says so', async (t) => {
  const { conn } = await fresh(t)
  const answer = await conn.arrow("INSERT (p:person {id: 1, name: 'ada'})")

  assert.equal(answer.rows, 0)
  assert.equal(read(answer).schema.fields.length, 0)
  // 00001 is the standard's own way of saying the statement completed
  // and had no result to give back.
  assert.equal(answer.gqlstatus, '00001')
})

test('the status and the notices ride beside the bytes', async (t) => {
  const { conn } = await twoPeople(t)
  const answer = await conn.arrow('MATCH (p:person) RETURN p.id AS id')
  assert.equal(answer.gqlstatus, '00000')
  assert.deepEqual(answer.notices, [])
})

test('parameters bind the same way they do for rows', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(
    await conn.arrow('MATCH (p:person) WHERE p.name = $name RETURN p.id AS id', { name: 'zoe' }),
  )
  assert.deepEqual(values(table, 'id'), [2n])
})

test('batchRows cuts the stream into the batches a caller asked for', async (t) => {
  const { conn } = await twoPeople(t)
  const table = read(await conn.arrow('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 1 }))

  assert.equal(table.batches.length, 2)
  assert.deepEqual(table.batches.map((batch) => batch.numRows), [1, 1])
  // Cutting changes nothing about the answer, which is the point: the
  // arrays are built whole and a batch is a slice of them.
  assert.deepEqual(values(table, 'id'), [1n, 2n])
})

test('a batch size that could never hold a row is refused', async (t) => {
  const { conn } = await twoPeople(t)
  const caught = await conn
    .arrow('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 0 })
    .then(() => null, (err) => err)

  assert.ok(isZuError(caught, 'ZuUsageError'))
  assert.match(caught.message, /batchRows is 0/)
})

test('a column that mixes two types is refused, with the row that did it', async (t) => {
  const { conn } = await twoPeople(t)
  const caught = await conn
    .arrow('MATCH (p:person) RETURN CASE WHEN p.id = 1 THEN p.id ELSE p.name END AS mixed')
    .then(() => null, (err) => err)

  assert.ok(isZuError(caught, 'ZuUsageError'))
  assert.match(caught.message, /column 'mixed' mixes integers and strings at row 1/)
})

test('a type Arrow has nowhere to put is refused by name', async (t) => {
  const { conn } = await fresh(t)
  const caught = await conn
    .arrow("RETURN ZONED TIME '03:04:05+02:00' AS t")
    .then(() => null, (err) => err)

  // Arrow has a time and a timestamp and nothing in between, and
  // dropping the offset would move the value. The columnar read hands
  // this one over as cells and an offset beside them, which is the way
  // out for a caller who wants it.
  assert.ok(isZuError(caught, 'ZuUsageError'))
  assert.match(caught.message, /time with an offset, which Arrow has no type for/)
})

test('a statement can be stopped by a signal like any other', async (t) => {
  const { conn } = await twoPeople(t)
  const caught = await conn
    .arrow('MATCH (p:person) RETURN p.id AS id', null, { signal: AbortSignal.abort() })
    .then(() => null, (err) => err)

  assert.equal(caught.name, 'AbortError')
  assert.equal((await conn.arrow('MATCH (p:person) RETURN p.id AS id')).rows, 2)
})

test('a closed connection refuses the call as a rejection', async (t) => {
  const { conn } = await twoPeople(t)
  await conn.close()
  const caught = await conn
    .arrow('MATCH (p:person) RETURN p.id AS id')
    .then(() => null, (err) => err)
  assert.ok(isZuError(caught, 'ZuUsageError'))
})

test('a prepared statement reads as Arrow too', async (t) => {
  const { conn } = await twoPeople(t)
  await using find = await conn.prepare('MATCH (p:person) WHERE p.name = $name RETURN p.id AS id')
  const table = read(await find.arrow({ name: 'zoe' }))
  assert.deepEqual(values(table, 'id'), [2n])
})

test('the bytes are handed over rather than shared, so two reads are two buffers', async (t) => {
  const { conn } = await twoPeople(t)
  const first = await conn.arrow('MATCH (p:person) RETURN p.id AS id')
  const second = await conn.arrow('MATCH (p:person) RETURN p.id AS id')

  first.ipc[0] = 0xff
  // Writing into one is writing into a buffer nothing else is reading,
  // which is what makes handing the memory over safe.
  assert.deepEqual(values(read(second), 'id'), [1n, 2n])
})

test('a million rows are one stream and the loop stays free while it is written', async (t) => {
  const { conn } = await fresh(t)
  await conn.exec('INSERT (n:number {id: 1, at: 1})')
  const rows = 1_000_000
  const appender = await conn.appender('number')
  for (let at = 2; at <= rows; at += 1) appender.appendRow([BigInt(at), BigInt(at)])
  await appender.close()

  let ticks = 0
  const timer = setInterval(() => (ticks += 1), 1)
  const at = performance.now()
  const answer = await conn.arrow('MATCH (n:number) RETURN n.at AS at')
  const took = performance.now() - at
  clearInterval(timer)

  assert.equal(answer.rows, rows)
  const table = read(answer)
  assert.equal(table.numRows, rows)
  assert.equal(column(table, 'at').get(rows - 1), BigInt(rows))
  // The whole write is on the threadpool, so the timer kept firing
  // throughout it rather than queueing behind it. The bar is a tick
  // every ten milliseconds of the read and not a fixed count, because a
  // blocked loop fires none however long the read takes.
  assert.ok(ticks > took / 10, `the event loop ticked ${ticks} times in ${took.toFixed(0)} ms`)
})
