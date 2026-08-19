// The same package as a CommonJS user sees it, which is a different
// resolution through a different condition to a different file, and so
// is worth compiling separately rather than assuming.

import {
  connect,
  isZuError,
  ZuTimestamp,
  type ZuAppendValue,
  type ZuParam,
  type ZuStream,
  type ZuTransactionOptions,
} from 'zudb'

export async function total(path: string): Promise<number> {
  // The mode is on the statement here, so the rows it gives back are
  // numbers and adding them up needs no conversion. A `bigint` row type
  // over the same call would not compile, which is the point of writing
  // it down.
  const conn = await connect(path, { bigIntMode: 'bigint' })
  const rows = await conn.query<{ n: number }>('MATCH (p:person) RETURN count(*) AS n', null, {
    bigIntMode: 'number',
  })
  conn.close()
  return rows.reduce((sum, row) => sum + row.n, 0)
}

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

export async function moment(path: string, at: bigint): Promise<unknown> {
  // A `Temporal` value binds as a parameter on a connection that never
  // asked for temporal mode, so this one is opened without the option
  // and the value it binds is made from a class instead.
  const conn = await connect(path)
  try {
    await conn.exec('INSERT (e:event {id: 1, at: $at})', { at: new ZuTimestamp(at) })
    return new ZuTimestamp(at, 120).toTemporal()
  } finally {
    conn.close()
  }
}

export async function span(path: string, options: ZuTransactionOptions): Promise<number> {
  // The options are an object of their own, so a caller can build one
  // and pass it around. A `try` and a `finally` is the other spelling
  // of the block below, for a program that cannot write `await using`,
  // and the rollback in it is the same word the disposal would run.
  const conn = await connect(path)
  const tx = await conn.transaction(options)
  try {
    const rows = await conn.query<{ n: number }>('MATCH (p:person) RETURN count(*) AS n', null, {
      bigIntMode: 'number',
    })
    await tx.commit()
    return rows[0]?.n ?? 0
  } finally {
    if (!tx.done) await tx.rollback()
    conn.close()
  }
}

export async function bulk(path: string, batch: readonly ZuAppendValue[][]): Promise<number> {
  // The `try` and `finally` spelling again, and the word in the
  // `finally` is `close` rather than `discard`, since a load that got
  // this far means to keep what it read.
  const conn = await connect(path)
  const rows = await conn.appender('person')
  try {
    const taken: number = rows.appendRows(batch)
    if (taken !== batch.length) throw new Error('a row went missing')
    return await rows.flush()
  } finally {
    if (!rows.closed) await rows.close()
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
