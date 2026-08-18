// The package as an ES module user sees it. Nothing here runs: what is
// being asserted is that it compiles, which is the half of an API that
// a test suite in JavaScript cannot reach.

import {
  connect,
  isZuError,
  ZuDate,
  type ZuBatch,
  type ZuBigIntMode,
  type ZuError,
  type ZuRows,
  type ZuStream,
  type ZuSummary,
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
