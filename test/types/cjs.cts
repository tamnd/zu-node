// The same package as a CommonJS user sees it, which is a different
// resolution through a different condition to a different file, and so
// is worth compiling separately rather than assuming.

import { connect, isZuError, type ZuParam, type ZuStream } from 'zudb'

export async function insert(path: string, values: Record<string, ZuParam>): Promise<void> {
  const conn = await connect(path)
  try {
    // A parameter object is wider than a result: `undefined` binds as
    // null, and a whole `number` binds as INT64.
    await conn.exec('INSERT (p:person {id: $id, name: $name})', values)
  } catch (caught) {
    if (isZuError(caught) && caught.code === '42001') return
    throw caught
  } finally {
    conn.close()
  }
}

export async function ids(path: string): Promise<bigint[]> {
  const conn = await connect(path)
  const stream: ZuStream<{ id: bigint }> = conn.stream('MATCH (p:person) RETURN p.id AS id')
  const out: bigint[] = []
  try {
    for await (const row of stream) out.push(row.id)
  } finally {
    conn.close()
  }
  return out
}
