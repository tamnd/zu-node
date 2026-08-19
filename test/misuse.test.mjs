// Deliberately wrong programs, and what each of them is told.
//
// DX3 asks for a misuse suite in every client: no crash, no hang, no
// leak, and a clear error for every program that is wrong on purpose.
// Clear is the hard word, so it is spelled out here as four things a
// message has to do. It names the thing the caller named, being the
// file they opened, the parameter they passed, the option they spelled.
// It says what was expected instead, wherever there is something to
// say. It is the engine's own sentence rather than a syscall's, since
// "failed to fill whole buffer" is a true statement about a read that
// tells nobody which file was not a database. And it never describes
// this crate's insides, because "Failed to convert JavaScript value
// `Number 42 ` into rust type `String`" is a message about napi to
// somebody who mistyped a variable.
//
// Clear also means the right class and the right shape. The class is
// `err.name`, and a caller branches on it: a mistake this client caught
// is a `ZuUsageError` with no `code`, a condition the engine raised is
// the class of its GQLSTATUS. The shape is that every one of these is a
// rejection and none of them is a throw, which is the last test in the
// first half: a method whose failures arrive two different ways is a
// method every caller has to wrap twice.
//
// No crash is the suite running at all. No hang is the pair of tests
// about a connection with a stream half-read on it, which is the one
// place where waiting would be forever. No leak is checked from outside
// the call that would cause one, three ways: every case is followed by
// a read on the connection it was aimed at, the failing connects are
// repeated past the descriptor limit a process starts with, and the
// descriptors themselves are counted where the operating system will
// say.
//
// The last test is the half of a misuse suite that is usually missing.
// The programs that look wrong and are not, each of which is a decision
// somebody would otherwise reverse by accident.

import assert from 'node:assert/strict'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { connect } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

const READ = 'MATCH (p:person) RETURN p.id AS id'

// A file that is not a database, written where a caller would have a
// file that is not a database.
async function junk(dir, name, contents) {
  const path = join(dir, name)
  await writeFile(path, contents)
  return path
}

// A database of its own, written, closed and opened read-only. Written
// and closed first, because asking for read-only is asking for one that
// is already there.
async function readOnly(t, dir) {
  const path = join(dir, 'reader.zu1')
  const writer = await connect(path)
  await writer.exec("INSERT (p:person {id: 1, name: 'ada'})")
  writer.close()
  const conn = await connect(path, { readOnly: true })
  t.after(() => conn.close())
  return conn
}

// A connection of its own, closed. Its own, because the case that uses
// it would otherwise close the connection every other case is checked
// against afterwards.
async function closed(dir) {
  const conn = await connect(join(dir, 'closed.zu1'))
  conn.close()
  return conn
}

// A stream on the given connection with one batch read out of it, which
// is the state that makes that connection busy: the statement has
// started, it has not ended, and what ends it is a reader.
//
// It takes a database with enough rows in it to still be scanning, since
// a stream that already reached the last row has already given the
// connection back and is not half-read at all.
async function halfRead(conn) {
  const stream = conn.stream(READ, null, { batchRows: 1 })
  await stream.batches().next()
  return stream
}

// A database with `count` people in it. One statement per row is a
// write per row, so the rows past the first go in batches. The first is
// written on its own, because that is the insert that declares the
// table.
async function people(t, count) {
  const made = await fresh(t)
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

// Enough rows that a stream is still scanning after one batch of one
// row has been read, which is what makes the connection busy.
const CROWD = 2000

// Every case gets a connection with two people in it, unless it asks
// for a crowd, and a directory to make a mess in. `run` returning
// normally fails the test: every program in this table is wrong. A
// stream a case pushed onto `streams` is stopped before the connection
// is asked whether it still works.
const MISUSES = [
  {
    what: 'connects to a file too small to be a database',
    run: ({ dir }) => junk(dir, 'small.zu1', 'not a database at all').then(connect),
    name: 'ZuConnectionError',
    says: ['small.zu1', '21 bytes', 'too short to be a zu1 database'],
  },
  {
    what: 'connects to a file the right size and the wrong kind',
    run: ({ dir }) => junk(dir, 'big.zu1', 'x'.repeat(40960)).then(connect),
    name: 'ZuConnectionError',
    says: ['big.zu1', 'not a zu1 file'],
  },
  {
    what: 'connects read-only to a database that is not there',
    // Read-only, because `connect` on a path with nothing at it makes a
    // database and that is the documented answer. Asking for read-only
    // is asking for one that already exists.
    run: ({ dir }) => connect(join(dir, 'nowhere.zu1'), { readOnly: true }),
    name: 'ZuConnectionError',
    says: ['nowhere.zu1'],
  },
  {
    what: 'passes a path that is not a string',
    run: () => connect(42),
    name: 'ZuUsageError',
    says: ['the path is a Number', 'a path is a string'],
  },
  {
    what: 'writes through a connection it opened read-only',
    run: async ({ dir, t }) =>
      (await readOnly(t, dir)).exec("INSERT (p:person {id: 3, name: 'zoe'})"),
    name: 'ZuUsageError',
    says: ['reader.zu1', 'read-only'],
  },
  {
    what: 'runs text that will not parse',
    run: ({ conn }) => conn.query('MATCH (p:person) RETRUN p.id'),
    name: 'ZuSyntaxError',
    code: '42001',
    says: ['42001', 'line 1, column 18', "found 'RETRUN'"],
  },
  {
    what: 'leaves out a parameter the statement reads',
    run: ({ conn }) => conn.query('MATCH (p:person) WHERE p.id = $id RETURN p.id AS id'),
    name: 'ZuSyntaxError',
    code: '42002',
    says: ['42002', 'missing parameter $id'],
  },
  {
    what: 'passes a statement that is not a string',
    run: ({ conn }) => conn.query(42),
    name: 'ZuUsageError',
    says: ['the statement is a Number', 'a statement is a string'],
  },
  {
    what: 'calls query with no arguments at all',
    run: ({ conn }) => conn.query(),
    name: 'ZuUsageError',
    says: ['the statement is undefined', 'a statement is a string'],
  },
  {
    what: 'passes a parameter of a type zu has no value for',
    run: ({ conn }) => conn.query('RETURN $x AS x', { x: () => 1 }),
    name: 'ZuUsageError',
    says: ['parameter x', 'Function', 'not a value a statement can hold'],
  },
  {
    what: 'passes a parameter that contains itself',
    run: ({ conn }) => {
      const knot = {}
      knot.self = knot
      return conn.query('RETURN $x AS x', { x: knot })
    },
    name: 'ZuUsageError',
    says: ['parameter x', 'nests deeper than 64', 'contains itself'],
  },
  {
    what: 'passes the parameters as an array',
    run: ({ conn }) => conn.query('MATCH (p:person) WHERE p.id = $id RETURN p.id AS id', [1]),
    name: 'ZuUsageError',
    says: ['the parameters are an array', 'names its parameters', 'without the $'],
  },
  {
    what: 'passes the parameters as a string',
    run: ({ conn }) => conn.query(READ, 'id=1'),
    name: 'ZuUsageError',
    says: ['the parameters are a String', 'without the $'],
  },
  {
    what: 'names a bigIntMode nobody can spell',
    run: ({ conn }) => conn.query(READ, null, { bigIntMode: 'bigInt' }),
    name: 'ZuUsageError',
    says: ['bigIntMode is "bigInt"', '"bigint" and "number"'],
  },
  {
    what: 'passes something that is not an AbortSignal as the signal',
    run: ({ conn }) => conn.query(READ, null, { signal: 'stop' }),
    name: 'ZuUsageError',
    says: ['signal is a String', 'not an AbortSignal'],
  },
  {
    what: 'asks a stream for batches of no rows',
    run: ({ conn }) => conn.stream(READ, null, { batchRows: 0 }).batches().next(),
    name: 'ZuUsageError',
    says: ['batchRows is 0', 'one at the least'],
  },
  {
    what: 'runs a statement on a connection it closed',
    run: ({ dir }) => closed(dir).then((gone) => gone.query(READ)),
    name: 'ZuUsageError',
    says: ['the connection is closed', 'nothing left to run a statement on'],
  },
  {
    what: 'runs a statement while a stream on the same connection is half-read',
    people: CROWD,
    run: async ({ conn, streams }) => {
      streams.push(await halfRead(conn))
      return conn.query(READ)
    },
    name: 'ZuUsageError',
    says: ['a stream on this connection has not finished', 'open a second connection'],
  },
  {
    what: 'opens a second stream while the first is half-read',
    people: CROWD,
    run: async ({ conn, streams }) => {
      streams.push(await halfRead(conn))
      return conn.stream(READ).batches().next()
    },
    name: 'ZuUsageError',
    says: ['a stream on this connection has not finished', 'cancel it'],
  },
  {
    what: 'divides by zero',
    run: ({ conn }) => conn.exec("INSERT (p:person {id: 1 / 0, name: 'zoe'})"),
    name: 'ZuDataError',
    code: '22012',
    says: ['22012', 'division by zero'],
  },
  {
    what: 'writes a row with a column missing',
    run: ({ conn }) => conn.exec('INSERT (p:person {id: 3})'),
    name: 'ZuUsageError',
    says: ["carries no value for column 'name'", 'every column of a new row has to hold one'],
  },
  {
    what: 'reads a property the table does not have',
    run: ({ conn }) => conn.query('MATCH (p:person) RETURN p.nope AS x'),
    name: 'ZuUsageError',
    says: ["unknown property 'nope'"],
  },
]

for (const misuse of MISUSES) {
  test(`a program that ${misuse.what} is told what is wrong`, async (t) => {
    const count = misuse.people ?? 2
    const { conn, dir } = misuse.people ? await people(t, count) : await twoPeople(t)
    const streams = []

    await assert.rejects(() => misuse.run({ conn, dir, t, streams }), (err) => {
      assert.ok(isZuError(err, misuse.name), `expected ${misuse.name}, got ${err.name}: ${err}`)
      for (const phrase of misuse.says) {
        assert.ok(err.message.includes(phrase), `the message is missing '${phrase}': ${err.message}`)
      }
      // The engine's sentence, not the read that noticed, and not this
      // crate's insides either.
      assert.doesNotMatch(err.message, /failed to fill whole buffer|rust type|napi/i)
      // A mistake this client caught carries no GQLSTATUS, since the
      // engine never saw the statement and there is no condition to
      // report, and a caller mapping codes to branches has to be able
      // to tell that from a code it does not recognize. What the engine
      // did raise carries the code the table names, and nothing
      // anywhere carries the status napi would have written.
      assert.equal(err.code, misuse.code)
      assert.equal('code' in err, misuse.code !== undefined)
      return true
    })

    // Every stream the case left running is stopped, since a connection
    // with a scan on it is busy by design and the question below is
    // whether the failure took anything with it.
    for (const stream of streams) await stream.cancel()

    // And the connection it was aimed at is still a connection: the
    // failure took nothing with it.
    assert.equal(conn.open, true)
    assert.equal((await conn.query(READ)).length, count)
  })
}

test('every mistake this client catches is a rejection and never a throw', async (t) => {
  const { conn } = await twoPeople(t)

  // The calls a wrong program makes on a connection, each of which
  // fails before the engine has seen anything. A native method that
  // throws for some of these and rejects for the rest is a method every
  // caller has to write two handlers for, and the one they leave out is
  // the one that takes the process down.
  const calls = [
    () => conn.query(42),
    () => conn.query(),
    () => conn.exec(null),
    () => conn.query(READ, [1]),
    () => conn.query(READ, null, { bigIntMode: 'nope' }),
    () => conn.query(READ, null, { signal: 'stop' }),
    () => conn.query('RETURN $x AS x', { x: Symbol('nope') }),
    () => connect(42),
  ]

  for (const call of calls) {
    let returned
    assert.doesNotThrow(() => {
      returned = call()
    }, `${call} threw where it should have rejected`)
    assert.equal(typeof returned.then, 'function', `${call} gave back something that is not a promise`)
    await assert.rejects(() => returned, (err) => isZuError(err, 'ZuUsageError'))
  }
})

test('five hundred failed connections leave nothing open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })
  const missing = join(dir, 'nowhere.zu1')
  const small = await junk(dir, 'small.zu1', 'not a database at all')

  const before = await descriptors()
  for (let n = 0; n < 500; n++) {
    await assert.rejects(() => connect(missing, { readOnly: true }), { name: 'ZuConnectionError' })
    await assert.rejects(() => connect(small), { name: 'ZuConnectionError' })
  }

  // A descriptor per failure would have run out long ago, and a
  // database made now is one that can be written and read.
  const conn = await connect(join(dir, 'after.zu1'))
  t.after(() => conn.close())
  await conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  assert.equal((await conn.query(READ)).length, 1)

  // And where the operating system will say how many are open, a
  // thousand failures cost a handful rather than a thousand.
  const after = await descriptors()
  if (before !== null && after !== null) {
    assert.ok(after - before < 20, `${after - before} descriptors were left open by 1000 failures`)
  }
})

test('a thousand connections opened and closed leave nothing behind', async (t) => {
  const { path } = await twoPeople(t)

  const before = await descriptors()
  for (let n = 0; n < 1000; n++) {
    const conn = await connect(path)
    await conn.dispose()
  }
  const after = await descriptors()

  if (before !== null && after !== null) {
    assert.ok(after - before < 20, `${after - before} descriptors were left open by 1000 connections`)
  }
})

test('a hundred streams stopped halfway leave the connection as it was', async (t) => {
  const { conn } = await twoPeople(t)

  for (let n = 0; n < 100; n++) {
    for await (const row of conn.stream(READ, null, { batchRows: 1 })) {
      assert.equal(typeof row.id, 'bigint')
      break
    }
  }

  // Each of those left a statement to be stopped and a thread to be
  // joined, and the connection they all ran on still runs statements.
  assert.equal((await conn.query(READ)).length, 2)
})

test('a statement that failed wrote nothing and left the connection alone', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(() => conn.exec("INSERT (p:person {id: 1 / 0, name: 'zoe'})"), {
    name: 'ZuDataError',
  })
  assert.equal((await conn.query(READ)).length, 2)

  // And the statement after the failed one is an ordinary statement:
  // the write that failed took no lock and left no half-written row.
  await conn.exec("INSERT (p:person {id: 3, name: 'iris'})")
  assert.equal((await conn.query(READ)).length, 3)
})

test('a connection closed under a stream ends it rather than hanging on it', async (t) => {
  const { conn } = await twoPeople(t)

  const stream = conn.stream(READ, null, { batchRows: 1 })
  const batches = stream.batches()
  await batches.next()
  // Closing does not wait for a reader that may never come back, and
  // reading does not wait for a connection that has gone. Both of those
  // waiting for each other is the one failure worse than an error.
  conn.close()

  let read = 1
  for (;;) {
    const step = await batches.next()
    if (step.done) break
    read += 1
    assert.ok(read < 10, 'the stream never ended')
  }
  assert.equal(conn.open, false)
})

test('the programs that look like misuse and are not', async (t) => {
  const { conn, path } = await twoPeople(t)

  // A parameter the statement does not read is not an error. A caller
  // that passes one object to several statements is doing something
  // reasonable, and refusing it would make that object the union of
  // what every statement wants.
  assert.equal((await conn.query(READ, { unread: 1 })).length, 2)

  // A label nothing carries matches nothing. A pattern with no answer
  // is the ordinary answer to a question about a graph, and the other
  // reading gives a query that fails on the day the last row of a label
  // is deleted.
  assert.deepEqual(await conn.query('MATCH (p:nobody) RETURN p.id AS id'), [])

  // A stream made and never read has not started, so the statement
  // after it runs rather than being told the connection is busy. This
  // is the reason a stream starts at its first read.
  conn.stream(READ)
  assert.equal((await conn.query(READ)).length, 2)

  // Reading a cursor that was cancelled is the end of the stream rather
  // than a failure, and cancelling one twice is cancelling it once. A
  // caller cleaning up in a `finally` is allowed to ask twice.
  const cursor = conn.cursor(READ)
  await cursor.cancel()
  await cursor.cancel()
  assert.equal(await cursor.next(), null)

  // Closing twice is not an error either, and neither is disposing of
  // something already closed, which is what an explicit `close` inside
  // an `await using` block leaves behind.
  const twice = await connect(path)
  twice.close()
  twice.close()
  await twice.dispose()
  assert.equal(twice.open, false)
})

// How many files this process has open, or `null` where the system will
// not say. Linux and macOS both publish it as a directory, and Windows
// publishes nothing, which is why every use of this is guarded rather
// than skipped: a descriptor leak is not platform-specific and the two
// platforms that can see one are enough to find it.
async function descriptors() {
  for (const where of ['/proc/self/fd', '/dev/fd']) {
    try {
      return (await readdir(where)).length
    } catch {
      continue
    }
  }
  return null
}
