// A statement read a batch at a time.
//
// The interesting cases are not the ones where every row is read. They
// are the ones where the reader stops early, which is the whole reason
// streaming is different from a query: a scan has to end, the
// connection has to come back, and the statement after it has to run
// without waiting for a database nobody was reading.

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import { isZuError, ZuStream } from 'zudb'

import { fresh, twoPeople } from './helper.mjs'

// Enough rows to arrive in more than one batch of a named size, and few
// enough that a test that reads all of them is not a benchmark.
const PEOPLE = 40

// Enough rows that a scan of them takes long enough to stop halfway,
// which is what the tests about stopping need and what a handful of
// rows cannot give them: a statement that has already finished is a
// statement no interrupt can catch.
const MANY = 60_000

async function people(t, count = PEOPLE) {
  const made = await fresh(t)
  // One statement per row is a write per row, so the rows past the
  // first are written in batches. The first is written on its own with
  // literals, because that is the insert that declares the table.
  await made.conn.exec("INSERT (p:person {id: 1, name: 'p1'})")
  for (let start = 2; start <= count; start += 500) {
    const parts = []
    for (let id = start; id < Math.min(start + 500, count + 1); id++) {
      parts.push(`(p${id}:person {id: ${id}, name: 'p${id}'})`)
    }
    await made.conn.exec(`INSERT ${parts.join(', ')}`)
  }
  return made
}

test('a stream gives every row, in order, and says what it did', async (t) => {
  const { conn } = await people(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id, p.name AS name')
  const seen = []
  for await (const row of stream) seen.push(row)

  assert.equal(seen.length, PEOPLE)
  assert.deepEqual(seen[0], { id: 1n, name: 'p1' })
  assert.deepEqual(stream.columns, ['id', 'name'])
  assert.deepEqual(stream.summary, {
    columns: ['id', 'name'],
    rows: PEOPLE,
    stopped: false,
    streamed: true,
    notices: [],
  })
})

test('a batch is an array of rows with the columns beside it', async (t) => {
  const { conn } = await people(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 15 })
  const sizes = []
  for await (const batch of stream.batches()) {
    // The same array trick a whole result uses: the names are there to
    // read and out of the way of everything that iterates.
    assert.deepEqual(batch.columns, ['id'])
    assert.deepEqual(Object.keys(batch), [...batch.keys()].map(String))
    sizes.push(batch.length)
  }

  // A size is a ceiling rather than a promise, because the engine cuts
  // batches out of the rows it has already made and the last piece of
  // one is whatever is left of it. What the size does promise is what
  // a caller wants from it: nothing bigger than this is ever held.
  assert.equal(
    sizes.reduce((total, size) => total + size, 0),
    PEOPLE,
  )
  assert.ok(
    sizes.every((size) => size > 0 && size <= 15),
    `${sizes} is not a run of batches of at most 15`,
  )
  assert.ok(sizes.length > 1, `expected more than one batch, got ${sizes.length}`)
})

test('a statement with no rows still says what it projected', async (t) => {
  const { conn } = await twoPeople(t)

  const stream = conn.stream("MATCH (p:person) WHERE p.name = 'nobody' RETURN p.name AS name")
  const seen = []
  for await (const row of stream) seen.push(row)

  assert.deepEqual(seen, [])
  // No batch ever arrived, so this is the summary talking and not a
  // batch, which is the reason the columns are on both.
  assert.deepEqual(stream.columns, ['name'])
  assert.equal(stream.summary.rows, 0)
  assert.equal(stream.summary.stopped, false)
})

test('breaking out of the loop stops the statement and gives the connection back', async (t) => {
  const { conn } = await people(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 2 })
  for await (const row of stream) {
    assert.equal(row.id, 1n)
    break
  }

  assert.equal(stream.summary.stopped, true)
  assert.ok(stream.summary.rows < PEOPLE, `${stream.summary.rows} rows is the whole scan`)
  // The point of waiting inside the break: the next statement runs
  // rather than queueing behind a scan nobody is reading.
  const rows = await conn.query('MATCH (p:person) RETURN count(*) AS n')
  assert.equal(rows[0].n, BigInt(PEOPLE))
})

test('a stream stops itself at the end of an await using block', async (t) => {
  const { conn } = await people(t)

  let stream
  {
    await using held = conn.stream('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 2 })
    stream = held
    for await (const row of held) {
      assert.equal(row.id, 1n)
      break
    }
  }

  assert.equal(stream.summary.stopped, true)
  assert.equal((await conn.query('RETURN 1 AS n'))[0].n, 1n)
})

test('cancelling twice is cancelling once, and reading afterwards is the end', async (t) => {
  const { conn } = await people(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id')
  await stream.cancel()
  await stream.cancel()

  const seen = []
  for await (const row of stream) seen.push(row)
  assert.deepEqual(seen, [])
  assert.equal((await conn.query('RETURN 1 AS n'))[0].n, 1n)
})

test('a stream is a ReadableStream when something wants one', async (t) => {
  const { conn } = await people(t)

  const web = conn.stream('MATCH (p:person) RETURN p.id AS id').toReadableStream()
  const seen = []
  for await (const row of web) seen.push(row.id)

  assert.equal(seen.length, PEOPLE)
  assert.equal(seen[0], 1n)
})

test('cancelling the ReadableStream stops the statement underneath it', async (t) => {
  const { conn } = await people(t)

  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, { batchRows: 2 })
  const web = stream.toReadableStream()
  const reader = web.getReader()
  const first = await reader.read()
  assert.equal(first.value.id, 1n)
  await reader.cancel()

  assert.equal(stream.summary.stopped, true)
  assert.equal((await conn.query('RETURN 1 AS n'))[0].n, 1n)
})

test('a signal stops a stream, and the connection is exactly as it was', async (t) => {
  const { conn } = await people(t, MANY)

  const controller = new AbortController()
  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, {
    batchRows: 1,
    signal: controller.signal,
  })
  const mine = new Error('enough')

  const caught = await (async () => {
    try {
      for await (const row of stream) {
        if (row.id === 3n) controller.abort(mine)
      }
    } catch (err) {
      return err
    }
    return null
  })()

  // The caller's own reason, which is what `fetch` does and what a
  // program that wrote the object wants back.
  assert.equal(caught, mine)
  assert.equal((await conn.query('MATCH (p:person) RETURN count(*) AS n'))[0].n, BigInt(MANY))
})

test('a signal that has already fired stops a stream before the engine sees it', async (t) => {
  const { conn } = await people(t)

  const controller = new AbortController()
  controller.abort()
  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, {
    signal: controller.signal,
  })

  await assert.rejects(
    async () => {
      for await (const row of stream) assert.fail(`read ${row.id} from a stopped stream`)
    },
    (err) => err.name === 'AbortError',
  )
})

test('a stream leaves no listener on the signal it was given', async (t) => {
  const { conn } = await people(t)

  const controller = new AbortController()
  for (let round = 0; round < 8; round++) {
    const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, {
      signal: controller.signal,
      batchRows: 4,
    })
    // Half read to the end, half stopped early, because the two end a
    // stream in different places and both have to take the listener off.
    if (round % 2 === 0) {
      for await (const _ of stream) void _
    } else {
      for await (const _ of stream) break
    }
  }

  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [])
})

test('a statement that will not compile fails at the first read', async (t) => {
  const { conn } = await fresh(t)

  // Not at the call, which is the point: a stream is asked for and
  // read, and everything a statement can do it does where the caller
  // has an await to catch it.
  const stream = conn.stream('MATCH (')
  await assert.rejects(
    async () => {
      for await (const row of stream) void row
    },
    (err) => isZuError(err) && err.name === 'ZuSyntaxError',
  )
})

test('a closed connection refuses a stream where every other statement is refused', async (t) => {
  const { conn } = await twoPeople(t)
  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id')
  conn.close()

  await assert.rejects(
    async () => {
      for await (const row of stream) void row
    },
    (err) => isZuError(err) && err.name === 'ZuUsageError',
  )
})

test('a batch size that is not one is refused as the caller\'s mistake', async (t) => {
  const { conn } = await twoPeople(t)

  for (const batchRows of [0, 'lots', {}, -1]) {
    const stream = conn.stream('MATCH (p:person) RETURN p.id AS id', null, { batchRows })
    await assert.rejects(
      async () => {
        for await (const row of stream) void row
      },
      (err) => isZuError(err) && err.name === 'ZuUsageError' && /batchRows/.test(err.message),
      `batchRows: ${JSON.stringify(batchRows)} was accepted`,
    )
  }
})

test('a stream is the class the package exports', async (t) => {
  const { conn } = await twoPeople(t)
  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id')
  assert.ok(stream instanceof ZuStream)
  await stream.cancel()
})

test('the first row arrives long before the last one is made', async (t) => {
  const { conn } = await people(t, MANY)

  const scan = 'MATCH (p:person) RETURN p.id AS id, p.name AS name'
  const whole = process.hrtime.bigint()
  const rows = await conn.query(scan)
  const plain = Number(process.hrtime.bigint() - whole) / 1e6
  assert.equal(rows.length, MANY)

  const early = process.hrtime.bigint()
  const stream = conn.stream(scan, null, { batchRows: 256 })
  for await (const row of stream) {
    void row
    break
  }
  const first = Number(process.hrtime.bigint() - early) / 1e6

  // The whole point of streaming, measured rather than asserted about:
  // a client that buffered the result would take as long to hand over
  // the first row as to hand over all of them. A fifth is a wide margin
  // around a first batch that arrives in about a hundredth of the scan,
  // because a loaded machine slows the first batch and the whole scan
  // by different amounts.
  assert.ok(
    first < plain / 5,
    `the first row took ${first.toFixed(1)}ms of the ${plain.toFixed(1)}ms whole scan`,
  )
  assert.equal(stream.summary.stopped, true)
  assert.equal(stream.summary.streamed, true)
  assert.ok(stream.summary.rows < MANY / 10, `${stream.summary.rows} rows is most of the scan`)
})

test('a statement that has to run whole is read the same way and says so', async (t) => {
  const { conn } = await people(t)

  // Sorting is the clearest of them: the last row is the one that
  // decides where the first goes, so there is nothing to hand over
  // until it has all been made. The engine runs it whole and hands the
  // result over in batches, which is a different thing from streaming
  // and the reason the summary tells them apart.
  const stream = conn.stream('MATCH (p:person) RETURN p.id AS id ORDER BY id DESC', null, {
    batchRows: 8,
  })
  const seen = []
  for await (const row of stream) seen.push(row.id)

  assert.equal(seen.length, PEOPLE)
  assert.equal(seen[0], BigInt(PEOPLE))
  assert.equal(stream.summary.streamed, false)
  assert.equal(stream.summary.stopped, false)
})
