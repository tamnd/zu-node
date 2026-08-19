// Building a database out of columns and an edge list.
//
// A load is the only way a JavaScript program makes a graph with edges
// in it, so these check both halves: that what went in comes back out
// through statements, and that a load which cannot mean anything is
// refused where the mistake is rather than written to disk and found
// later.

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ZuDate, ZuDuration, ZuTime, ZuTimestamp, connect, load } from 'zudb'

import { isZuError } from './helper.mjs'

// A path in a directory of its own that nothing has written to yet,
// which is what a load wants: it builds a database rather than adding
// to one.
async function spot(t, name = 'g.zu1') {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-load-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, name)
}

// A connection to a database a load just wrote, closed when the test
// ends. Read-only, because nothing here writes to one afterwards and a
// read-only open is the one a reader would use.
async function opened(t, path) {
  const conn = await connect(path, { readOnly: true })
  t.after(() => conn.close())
  return conn
}

// The graph most of these ask questions about: three people and the two
// edges between them, in the order they were loaded.
async function three(t) {
  const path = await spot(t)
  await load(path, {
    nodes: 'person',
    rels: 'knows',
    columns: { uid: [10, 20, 30], name: ['ada', 'grace', 'kay'] },
    edges: [
      [0, 1],
      [1, 2],
    ],
  })
  return { path, conn: await opened(t, path) }
}

test('a load says what it wrote', async (t) => {
  const stats = await load(await spot(t), {
    nodes: 'person',
    rels: 'knows',
    columns: { uid: [1, 2, 3], name: ['ada', 'grace', 'kay'] },
    edges: [
      [0, 1],
      [1, 2],
    ],
  })
  assert.deepEqual(stats, { nodes: 3, rels: 2, columns: 2 })
})

test('the rows read back in the order they went in', async (t) => {
  const { conn } = await three(t)
  const rows = await conn.query('MATCH (p:person) RETURN p.uid AS uid, p.name AS name')
  assert.deepEqual(
    rows.map((row) => [row.uid, row.name]),
    [
      [10n, 'ada'],
      [20n, 'grace'],
      [30n, 'kay'],
    ],
  )
})

test('the edges are a table a pattern can walk', async (t) => {
  const { conn } = await three(t)
  const rows = await conn.query(
    'MATCH (a:person)-[:knows]->(b:person) RETURN a.name AS a, b.name AS b',
  )
  assert.deepEqual(
    rows.map((row) => [row.a, row.b]),
    [
      ['ada', 'grace'],
      ['grace', 'kay'],
    ],
  )
})

test('an edge comes back as a rel that knows its table', async (t) => {
  const { conn } = await three(t)
  const rows = await conn.query('MATCH ()-[r:knows]->() RETURN r AS r')
  // The ordinal is the edge's place in the load, which is where its
  // properties sit, so the second edge loaded is the second ordinal.
  assert.deepEqual(
    rows.map((row) => [row.r.table, row.r.src, row.r.dst, row.r.ord]),
    [
      ['knows', 0n, 1n, 0n],
      ['knows', 1n, 2n, 1n],
    ],
  )
})

test('a walk comes back as a path', async (t) => {
  const { conn } = await three(t)
  const rows = await conn.query(
    'MATCH q = (a:person)-[:knows]->()-[:knows]->(c:person) RETURN q AS q',
  )
  const walk = rows[0].q
  assert.deepEqual(
    walk.nodes.map((node) => node.offset),
    [0n, 1n, 2n],
  )
  assert.deepEqual(
    walk.rels.map((rel) => [rel.src, rel.dst]),
    [
      [0n, 1n],
      [1n, 2n],
    ],
  )
})

test('a load with no edges is a graph with none', async (t) => {
  const path = await spot(t)
  const stats = await load(path, { nodes: 'person', rels: 'knows', columns: { uid: [1, 2] } })
  assert.equal(stats.rels, 0)
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH ()-[r:knows]->() RETURN count(r) AS n')
  assert.equal(rows[0].n, 0n)
})

test('a load with no columns still has rows', async (t) => {
  const path = await spot(t)
  const stats = await load(path, { nodes: 'person', rels: 'knows', rows: 4, edges: [[0, 3]] })
  assert.deepEqual(stats, { nodes: 4, rels: 1, columns: 0 })
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH (p:person) RETURN count(p) AS n')
  assert.equal(rows[0].n, 4n)
})

test('the rel table is called rel when it is not named', async (t) => {
  const path = await spot(t)
  await load(path, { nodes: 'person', columns: { uid: [1, 2] }, edges: [[0, 1]] })
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH ()-[r]->() RETURN r AS r')
  assert.equal(rows[0].r.table, 'rel')
})

test('the same edge twice is one edge', async (t) => {
  const stats = await load(await spot(t), {
    nodes: 'person',
    rels: 'knows',
    columns: { uid: [1, 2] },
    edges: [
      [0, 1],
      [0, 1],
      [0, 1],
    ],
  })
  assert.equal(stats.rels, 1)
})

test('an edge list is read out of a flat typed array too', async (t) => {
  // Two elements an edge, which is the shape a program that built its
  // edges in memory already has, and it means the same graph as the
  // arrays of pairs above.
  const path = await spot(t)
  const stats = await load(path, {
    nodes: 'person',
    rels: 'knows',
    columns: { uid: [1, 2, 3] },
    edges: new Uint32Array([0, 1, 1, 2]),
  })
  assert.equal(stats.rels, 2)
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH (a:person)-[:knows]->(b:person) RETURN b.uid AS uid')
  assert.deepEqual(
    rows.map((row) => row.uid),
    [2n, 3n],
  )
})

test('a column is read out of a typed array as the numbers it holds', async (t) => {
  const path = await spot(t)
  await load(path, {
    nodes: 'person',
    rels: 'knows',
    columns: {
      small: new Int8Array([-1, 2]),
      wide: new BigInt64Array([1n << 40n, -5n]),
      ratio: new Float32Array([0.5, 1.25]),
      exact: new Float64Array([0.1, 2.5]),
    },
  })
  const conn = await opened(t, path)
  const rows = await conn.query(
    'MATCH (p:person) RETURN p.small AS small, p.wide AS wide, p.ratio AS ratio, p.exact AS exact',
  )
  assert.deepEqual(
    rows.map((row) => [row.small, row.wide, row.ratio, row.exact]),
    [
      [-1n, 1n << 40n, 0.5, 0.1],
      [2n, -5n, 1.25, 2.5],
    ],
  )
})

test('a column of every kind reads back as what it was', async (t) => {
  const path = await spot(t)
  const columns = {
    count: [1, -2],
    ratio: [1.5, -0.25],
    flag: [true, false],
    name: ['ada', 'grace'],
    born: [new ZuDate(-56_312), new ZuDate(-23_032)],
    woke: [new ZuTime(23_400_000_000_000n), new ZuTime(86_399_000_000_000n)],
    seen: [new ZuTimestamp(1_704_164_645_000_006_000n), new ZuTimestamp(0n)],
    took: [ZuDuration.ofNanos(86_402_000_000_000n), ZuDuration.ofNanos(0n)],
    aged: [ZuDuration.ofMonths(14n), ZuDuration.ofMonths(-1n)],
  }
  await load(path, { nodes: 'person', rels: 'knows', columns })
  const conn = await opened(t, path)
  const names = Object.keys(columns)
  const rows = await conn.query(
    `MATCH (p:person) RETURN ${names.map((name) => `p.${name} AS ${name}`).join(', ')}`,
  )
  assert.equal(rows[0].count, 1n)
  assert.equal(rows[0].ratio, 1.5)
  assert.equal(rows[0].flag, true)
  assert.equal(rows[0].name, 'ada')
  assert.equal(rows[0].born.days, -56_312)
  assert.equal(rows[0].woke.nanos, 23_400_000_000_000n)
  assert.equal(rows[0].seen.nanos, 1_704_164_645_000_006_000n)
  assert.equal(rows[0].took.nanos, 86_402_000_000_000n)
  assert.equal(rows[0].aged.months, 14n)
  assert.deepEqual(
    [rows[1].count, rows[1].ratio, rows[1].flag, rows[1].name],
    [-2n, -0.25, false, 'grace'],
  )
})

test('a column of whole numbers that meets a fractional one widens', async (t) => {
  const path = await spot(t)
  await load(path, { nodes: 'person', rels: 'knows', columns: { n: [1, 2, 2.5] } })
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH (p:person) RETURN p.n AS n')
  assert.deepEqual(
    rows.map((row) => row.n),
    [1, 2, 2.5],
  )
})

test('a load never writes over a database that is there', async (t) => {
  const path = await spot(t)
  await load(path, { nodes: 'person', rels: 'knows', columns: { uid: [1] } })
  await assert.rejects(
    () => load(path, { nodes: 'person', rels: 'knows', columns: { uid: [2] } }),
    (err) => isZuError(err, 'ZuConnectionError') || isZuError(err, 'ZuIOError'),
  )
  const conn = await opened(t, path)
  const rows = await conn.query('MATCH (p:person) RETURN p.uid AS uid')
  assert.deepEqual(
    rows.map((row) => row.uid),
    [1n],
  )
})

// Every way of writing a load that cannot mean anything, refused before
// anything is written. The file is checked afterwards in each case,
// because a refusal that left a database behind would be a refusal that
// made the next call fail for a reason the caller could not see.
const refusals = [
  [{ nodes: '', rels: 'knows', rows: 1 }, /not a name a statement can carry/],
  [{ nodes: 'person', rels: '', rows: 1 }, /not a name a statement can carry/],
  [{ nodes: 'person', rels: 'knows' }, /has to be told how many/],
  [{ nodes: 'person', rels: 'knows', columns: { a: [1, 2], b: [3] } }, /as wide as it is long/],
  [{ nodes: 'person', rels: 'knows', columns: { a: [] } }, /is empty/],
  [{ nodes: 'person', rels: 'knows', columns: { a: [1, 2] }, rows: 3 }, /against the 3 rows/],
  [
    { nodes: 'person', rels: 'knows', columns: { a: [1, 2] }, edges: [[0, 5]] },
    /row 5 of a table with 2 rows/,
  ],
  [
    { nodes: 'person', rels: 'knows', columns: { a: [1, 2] }, edges: [[0, -1]] },
    /row -1 of a table/,
  ],
  [
    { nodes: 'person', rels: 'knows', columns: { a: [1, 2] }, edges: [[0, 1], 7] },
    /edge 1 is a number, and an edge is a pair of row numbers/,
  ],
  [
    { nodes: 'person', rels: 'knows', columns: { a: [1, 2] }, edges: new Uint32Array([0, 1, 1]) },
    /flat array of 3 row numbers/,
  ],
  [{ nodes: 'person', rels: 'knows', columns: { '2legs': [1] } }, /not a name a statement can carry/],
  [{ rels: 'knows', rows: 1 }, /names the node table/],
  [{ nodes: 'person', rels: 'knows', columns: { a: [new Uint8Array([1])] } }, /byte strings/],
  [{ nodes: 'person', rels: 'knows', columns: { a: 7 } }, /a column is an array or a typed array/],
  [{ nodes: 'person', rels: 'knows', rows: 1.5 }, /not a whole one/],
]

for (const [options, message] of refusals) {
  test(`a load that cannot mean anything is refused: ${message.source}`, async (t) => {
    const path = await spot(t)
    await assert.rejects(
      () => load(path, options),
      (err) => isZuError(err, 'ZuUsageError') && message.test(err.message),
    )
    await assert.rejects(() => stat(path), { code: 'ENOENT' })
  })
}

// A column holds one kind of value, and the first value is what says
// which kind. The message names the column and the row, because a
// million row load that stops at row 700_000 is worth telling where.
const mixed = [
  [[1, true], /column 'a' holds whole numbers and row 1 is a boolean/],
  [[true, 1], /column 'a' holds booleans and row 1 is a number/],
  [[1, 'ada'], /column 'a' holds whole numbers and row 1 is a string/],
  [[1.5, 'ada'], /column 'a' holds floats and row 1 is a string/],
  [['ada', 1], /column 'a' holds strings and row 1 is a number/],
  [
    [new ZuDate(0), new ZuTimestamp(0n)],
    /column 'a' holds dates and row 1 is a ZuTimestamp/,
  ],
  [
    [ZuDuration.ofMonths(1n), ZuDuration.ofNanos(1n)],
    /column 'a' holds year-month durations and row 1 is a ZuDuration/,
  ],
  [[null], /starts at row 0 with null/],
  [[{}], /starts at row 0 with an Object/],
]

for (const [values, message] of mixed) {
  test(`a column holds one kind of value: ${message.source}`, async (t) => {
    const path = await spot(t)
    await assert.rejects(
      () => load(path, { nodes: 'person', rels: 'knows', columns: { a: values } }),
      (err) => isZuError(err, 'ZuUsageError') && message.test(err.message),
    )
  })
}

test('a whole number past what INT64 holds is refused by the row that holds it', async (t) => {
  const path = await spot(t)
  await assert.rejects(
    () =>
      load(path, {
        nodes: 'person',
        rels: 'knows',
        columns: { a: new BigUint64Array([1n, 1n << 63n]) },
      }),
    (err) => isZuError(err, 'ZuUsageError') && /at row 1, which is past what INT64 holds/.test(err.message),
  )
})

test('the path is a string and the options are an object', async (t) => {
  const path = await spot(t)
  await assert.rejects(
    () => load(7, { nodes: 'person', rows: 1 }),
    (err) => isZuError(err, 'ZuUsageError') && /the path is a Number/.test(err.message),
  )
  await assert.rejects(
    () => load(path, 'person'),
    (err) => isZuError(err, 'ZuUsageError') && /the options are a string/.test(err.message),
  )
})

test('the event loop keeps turning while a load runs', async (t) => {
  // Big enough that the write takes long enough to watch, and shaped so
  // the edges are out of order and have to be sorted, which is the other
  // half of the work the threadpool is for.
  const rows = 200_000
  const uid = BigInt64Array.from({ length: rows }, (_, ix) => BigInt(ix))
  const name = Array.from({ length: rows }, (_, ix) => `p${ix}`)
  const edges = new Uint32Array(rows * 2)
  for (let ix = 0; ix < rows; ix++) {
    edges[ix * 2] = ix
    edges[ix * 2 + 1] = (ix * 7 + 1) % rows
  }

  let ticks = 0
  const tick = () => {
    ticks++
    return new Promise((resolve) => setImmediate(resolve))
  }
  const writing = load(await spot(t, 'big.zu1'), {
    nodes: 'person',
    rels: 'knows',
    columns: { uid, name },
    edges,
  })
  let done = false
  writing.then(() => {
    done = true
  })
  while (!done) await tick()

  const stats = await writing
  assert.equal(stats.nodes, rows)
  // An event loop held for the length of the write would get no turns
  // at all, since the whole of it happens inside the one call.
  assert.ok(ticks > 50, `the loop only got ${ticks} turns`)
})
