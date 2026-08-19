// The package as an ES module user sees it. Nothing here runs: what is
// being asserted is that it compiles, which is the half of an API that
// a test suite in JavaScript cannot reach.

import {
  connect,
  isZuError,
  load,
  ZuDate,
  type Appender,
  type ZuAppendValue,
  type ZuBatch,
  type ZuBigIntMode,
  type ZuError,
  type ZuEdges,
  type ZuFrame,
  type ZuFrameColumn,
  type ZuColumn,
  type ZuColumnar,
  type Prepared,
  type ZuLoadStats,
  type ZuPlainDate,
  type ZuPlan,
  type ZuPlanNode,
  type ZuRows,
  type ZuStream,
  type ZuSummary,
  type ZuValue,
  type Transaction,
} from 'zudb'

export async function people(path: string, name: string): Promise<string[]> {
  // `await using` is the intended scoping, and it needs the connection
  // to carry `Symbol.asyncDispose` in its type as well as at runtime.
  await using conn = await connect(path, { readOnly: true })

  const rows: ZuRows<{ id: bigint; name: string }> = await conn.query(
    'MATCH (p:person) WHERE p.name = $name RETURN p.id AS id, p.name AS name',
    { name },
    { signal: AbortSignal.timeout(50) },
  )

  // The projection in the order it was written, beside the rows rather
  // than among them.
  const columns: string[] = rows.columns
  if (columns.length !== 2) throw new Error('the projection changed shape')

  // An INT64 is a bigint, which is the one rule worth learning first: a
  // `number` here would not compile, and that is the whole point of it.
  return rows.map((row) => `${row.name} ${row.id.toString()}`)
}

type Person = { id: bigint; name: string }

export async function names(path: string): Promise<number> {
  await using conn = await connect(path, { readOnly: true })

  // The row type is the stream's, so what comes out of the loop is
  // typed without a cast anywhere, and so is what comes out of a batch.
  await using stream: ZuStream<Person> = conn.stream<Person>(
    'MATCH (p:person) RETURN p.id AS id, p.name AS name',
    null,
    { batchRows: 512, signal: AbortSignal.timeout(50) },
  )

  let longest = 0
  for await (const row of stream) longest = Math.max(longest, row.name.length)

  // Both of these are null until there is something to read in them,
  // which is what makes a caller check rather than believe.
  const summary: ZuSummary | null = stream.summary
  if (summary && !summary.streamed) longest += 0

  return longest
}

export async function counted(path: string): Promise<number> {
  const conn = await connect(path)
  const stream = conn.stream<Person>('MATCH (p:person) RETURN p.id AS id, p.name AS name')
  let rows = 0
  for await (const batch of stream.batches()) {
    const typed: ZuBatch<Person> = batch
    rows += typed.length
  }
  // A Web Stream of the same rows, for anything that already speaks one.
  const web: ReadableStream<Person> = conn
    .stream<Person>('MATCH (p:person) RETURN p.id AS id')
    .toReadableStream()
  await web.cancel()
  await conn.close()
  return rows
}

export async function serialized(path: string, mode: ZuBigIntMode): Promise<string> {
  // A connection with a mode of its own, and a statement that names one
  // for itself. The row type is the caller's either way, which is the
  // part TypeScript cannot check for them: a mode is a string at
  // runtime and `id` is whatever they said it was.
  await using conn = await connect(path, { bigIntMode: mode })
  const rows: ZuRows<{ id: number; name: string }> = await conn.query(
    'MATCH (p:person) RETURN p.id AS id, p.name AS name',
    null,
    { bigIntMode: 'number' },
  )
  return JSON.stringify(rows.map((row) => ({ ...row, id: row.id + 1 })))
}

export async function moved(path: string, from: bigint, to: bigint): Promise<boolean> {
  await using conn = await connect(path)

  // `await using` on a transaction needs the same thing it needs on a
  // connection, and the transaction's disposal is declared in the same
  // place and for the same reason.
  await using tx: Transaction = await conn.transaction()
  const open: boolean = conn.inTransaction
  await conn.exec('MATCH (p:person) WHERE p.id = $from SET p.id = $to', { from, to })
  await tx.commit()

  // Both are readable after the fact, and both are plain booleans.
  return open && tx.done && !tx.readOnly
}

export async function loaded(path: string, people: [bigint, string][]): Promise<number> {
  await using conn = await connect(path)

  // `await using` on an appender needs the same declaration the other
  // two need, and this one flushes rather than undoing what it holds.
  await using rows: Appender = await conn.appender('person')
  for (const person of people) {
    // A row is an array of values and nothing wider: a null in one does
    // not compile, because a column of an appender has one type and
    // every value in it is that type.
    const row: readonly ZuAppendValue[] = person
    rows.appendRow(row)
  }

  // Synchronous, so it is a number rather than a promise, and the two
  // counts beside it are numbers too.
  const buffered: number = rows.buffered
  if (buffered !== people.length) throw new Error('a row went missing')
  const written: number = await rows.flush()
  return written + rows.committed
}

export async function built(path: string, uid: BigInt64Array): Promise<number> {
  // Both spellings of an edge list are the one type, so a program that
  // has its edges flat and a program that has them in pairs both
  // compile without either of them saying which they meant.
  const pairs: ZuEdges = [
    [0, 1],
    [1, 2],
  ]
  const flat: ZuEdges = new Uint32Array([0, 1, 1, 2])

  const stats: ZuLoadStats = await load(path, {
    nodes: 'person',
    rels: 'knows',
    columns: { uid, name: ['ada', 'grace', 'kay'] },
    edges: uid.length === 3 ? pairs : flat,
  })

  // Numbers rather than bigints, which is the one place in this package
  // a count is not a `bigint`, since these are counts the client made
  // rather than an INT64 a statement gave back.
  return stats.nodes + stats.rels + stats.columns
}

export async function matched(path: string, ages: Int32Array): Promise<number> {
  await using conn = await connect(path)

  // An object of columns is a frame, and a typed array is a column, so
  // this compiles without the caller reaching for a cast. An Arrow table
  // is the other half of the union and is structural, so a table from
  // `apache-arrow` is one without this package importing that package.
  const column: ZuFrameColumn = ages
  const frame: ZuFrame = { age: column, name: ['ada', 'grace'] }

  // A count of rows rather than nothing, so a caller can check that what
  // went in is what they meant.
  const rows: number = await conn.register('people', frame)

  const found = await conn.query<{ n: bigint }>(
    'MATCH (p:people) WHERE p.age > 40 RETURN count(*) AS n',
  )

  // A method rather than a getter, because it takes the lock like the
  // rest of them, so it needs the `await` to typecheck.
  const names: string[] = await conn.registered()
  await conn.unregister('people')

  return rows + names.length + Number(found[0]?.n ?? 0n)
}

export function retryable(caught: unknown): boolean {
  // `catch` gives `unknown`, and the guard is what narrows it. Reading
  // `caught.retryable` without it does not compile.
  if (!isZuError(caught)) return false
  const err: ZuError = caught
  return err.retryable
}

export function epoch(): ZuDate {
  return new ZuDate(0)
}

export async function days(path: string): Promise<unknown[]> {
  // The temporal mode is on the connection and only there, which is
  // what the options type says: a statement naming it does not compile.
  await using conn = await connect(path, { temporal: true })
  const rows = await conn.query<{ on: ZuValue }>('MATCH (d:day) RETURN d.on AS on')
  return rows.map((row) => row.on)
}

export function converted(): ZuPlainDate {
  // The real `Temporal.PlainDate` on a program whose `lib` declares one
  // and `unknown` on a program whose `lib` does not, and it compiles
  // either way, which is the whole reason the type is written as a
  // question about `globalThis` rather than as an import.
  return new ZuDate(0).toTemporal()
}

export function width(value: ZuValue): number {
  // A value out of a result still narrows on a program with no
  // `Temporal` types, which is what the empty fallback is for: a member
  // that fell back to `unknown` instead would swallow the union and
  // this function would stop compiling for everybody.
  if (typeof value === 'string') return value.length
  if (typeof value === 'bigint') return value.toString().length
  if (Array.isArray(value)) return value.length
  return 0
}

export async function totals(path: string): Promise<bigint> {
  await using conn = await connect(path, { readOnly: true })

  // The buffers themselves, so summing them is a loop over a typed
  // array and not over a million objects. Which field carries the
  // values follows from the type, and narrowing on `type` is what makes
  // `values` a `BigInt64Array` here rather than the union it starts as.
  const read: ZuColumnar = await conn.columnar('MATCH (p:person) RETURN p.id AS id')
  const column: ZuColumn = read.columns[0]!
  if (column.type !== 'int') throw new Error('the projection changed shape')

  let total = 0n
  for (const value of column.values as BigInt64Array) total += value

  // The counts beside them are numbers, which is the one place a count
  // in this package is not a bigint, and the status is the statement's.
  const rows: number = read.rows
  if (read.gqlstatus !== '00000') throw new Error(read.gqlstatus)
  return total + BigInt(rows) + BigInt(column.nulls)
}

export async function repeated(path: string, names: string[]): Promise<bigint[]> {
  await using conn = await connect(path, { readOnly: true })

  // A prepared statement is disposable too, and the row type goes on
  // the run rather than on the prepare, because one statement answers
  // whatever the projection says and the projection is in the text.
  await using find: Prepared = await conn.prepare(
    'MATCH (p:person) WHERE p.name = $name RETURN p.id AS id',
  )

  // The names it wants, which is the half of a prepared statement that
  // is not just a faster `query`.
  const wanted: string[] = find.params
  if (wanted.length !== 1) throw new Error('the statement changed shape')

  const out: bigint[] = []
  for (const name of names) {
    const rows = await find.query<{ id: bigint }>({ name })
    for (const row of rows) out.push(row.id)
  }
  return out
}

export async function scans(path: string): Promise<boolean> {
  await using conn = await connect(path, { readOnly: true })
  const plan: ZuPlan = await conn.explain('MATCH (p:person) RETURN p.id AS id')

  // The root is nullable, since a statement can compile to no operator
  // at all, so walking the tree without asking does not compile.
  const walk = (node: ZuPlanNode): boolean =>
    node.op === 'ScanNodes' || node.children.some(walk)
  return plan.root === null ? false : walk(plan.root)
}
