import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { connect, isZuError as guard } from 'zudb'

// A database of its own per test, in a directory of its own, removed
// when the test ends. Sharing one would make the order the tests run in
// part of what they assert, and the runner is free to change it.
export async function fresh(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'test.zu1')
  const conn = await connect(path, options)
  t.after(() => conn.close())
  return { conn, path, dir }
}

// A database with two people in it, which is the smallest thing most of
// these tests can ask a question about. There is no statement that
// makes a table on its own yet, so the first insert declares one.
export async function twoPeople(t) {
  const made = await fresh(t)
  await made.conn.exec("INSERT (p:person {id: 1, name: 'ada'})")
  await made.conn.exec("INSERT (p:person {id: 2, name: 'zoe'})")
  return made
}

// What a test asserts about an error it caught, in one place, since
// every one of them wants the same first two things. The guard the
// package exports is what says it is a zu failure at all, so the tests
// exercise the same predicate a caller would write.
export function isZuError(err, name) {
  return guard(err) && err.name === name
}
