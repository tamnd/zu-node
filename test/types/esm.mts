// The package as an ES module user sees it. Nothing here runs: what is
// being asserted is that it compiles, which is the half of an API that
// a test suite in JavaScript cannot reach.

import { connect, isZuError, ZuDate, type ZuError, type ZuRows } from 'zudb'

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
