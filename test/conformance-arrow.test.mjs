// The Arrow half: what a case says an export gives, and what the export
// actually gave.
//
// This client hands out Arrow IPC bytes rather than a C Data Interface
// stream, so the schema is read out of the flatbuffer at the head of the
// buffer and turned back into the format strings a case is written in.
// That reader is the thing under test here, and it is tested against
// bytes the addon really produced rather than against bytes made up for
// the occasion, because a hand written buffer would only prove that the
// reader agrees with whoever wrote the buffer.
//
// The comparison is tested on its own, with no bytes at all, since it is
// strings and a walk and its wording goes into a report that is diffed
// against the reference runner's.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { connect, load } from 'zudb'

import { THE_RESULT, exported, schemaSays } from '../conformance/arrow.mjs'

// A field, written short because a schema is mostly nesting.
function field(name, format, ...children) {
  return { name, format, children }
}

// A connection on a database of its own, gone when the test ends.
async function open(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-arrow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const conn = await connect(join(dir, 'one.zu'))
  t.after(() => conn.close())
  return conn
}

test('a schema that matches says nothing', () => {
  const held = [field('n', 'l'), field('l', '+l', field('item', 'u'))]
  assert.equal(schemaSays(held, held), '')
  assert.equal(schemaSays([], []), '')
})

// The place a difference is in, which is the result itself at the top
// and the case's own names joined by dots underneath. A schema printed
// in full at somebody is a report nobody reads.
test('a schema that differs says where and how', () => {
  for (const [what, got, want, says] of [
    [
      'more fields than the case wants',
      [field('a', 'l'), field('b', 'l')],
      [field('a', 'l')],
      `arrow gives 2 fields in ${THE_RESULT} where the case wants 1`,
    ],
    [
      'fewer fields than the case wants',
      [],
      [field('a', 'l')],
      `arrow gives 0 fields in ${THE_RESULT} where the case wants 1`,
    ],
    [
      'a field under another name',
      [field('a', 'l')],
      [field('b', 'l')],
      `arrow field 1 in ${THE_RESULT} is named "a" where the case wants "b"`,
    ],
    [
      'a field of another type',
      [field('a', 'l')],
      [field('a', 'g')],
      'arrow field "a" is "l" where the case wants "g"',
    ],
    [
      'a list whose field is named something else',
      [field('l', '+l', field('item', 'l'))],
      [field('l', '+l', field('element', 'l'))],
      'arrow field 1 in "l" is named "item" where the case wants "element"',
    ],
    [
      'a struct with a field missing from it',
      [field('p', '+s', field('table', 'u'))],
      [field('p', '+s', field('table', 'u'), field('offset', 'l'))],
      'arrow gives 1 fields in "p" where the case wants 2',
    ],
    [
      'a field two deep',
      [field('l', '+l', field('item', '+s', field('table', 'u')))],
      [field('l', '+l', field('item', '+s', field('table', 'U')))],
      'arrow field "l.item.table" is "u" where the case wants "U"',
    ],
    [
      // The name is checked before the type, so a field that is both in
      // the wrong place and of the wrong type reports the place. Naming
      // the type first would report the same schema differently
      // depending on which field the walk reached first.
      'a field that is wrong both ways',
      [field('a', 'l')],
      [field('b', 'g')],
      `arrow field 1 in ${THE_RESULT} is named "a" where the case wants "b"`,
    ],
  ]) {
    assert.equal(schemaSays(got, want), says, `${what} was reported with the wrong words`)
  }
})

// From here down the addon produces the bytes.

test('the schema of a real export reads back as format strings', async (t) => {
  const conn = await open(t)
  for (const [query, name, format] of [
    ['RETURN 1 AS n', 'n', 'l'],
    ['RETURN 1.5 AS f', 'f', 'g'],
    ["RETURN 'text' AS s", 's', 'u'],
    ['RETURN true AS b', 'b', 'b'],
  ]) {
    const got = exported(await conn.arrow(query))
    assert.deepEqual(
      got.fields,
      [field(name, format)],
      `${query} exported ${JSON.stringify(got.fields)}`,
    )
  }
})

// A flatbuffer leaves out any field holding the schema's default for it,
// so a reader that defaults the wrong way reads a whole family of types
// as another one and says nothing about it. `is_signed` defaults to
// false, so an unsigned integer is written as an `Int` table with a
// width and nothing else, and a reader defaulting it to true reports
// every UINT64 in the export as `l`. A node's row offset is the unsigned
// column this engine actually exports, so this asserts the default
// through bytes rather than through a table of my own.
test('an unsigned column reads back unsigned', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-arrow-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'people.zu')
  await load(path, {
    nodes: 'person',
    rels: 'knows',
    rows: 2,
    columns: { name: ['ann', 'bo'] },
    edges: new Uint32Array([0, 1]),
  })
  const conn = await connect(path)
  t.after(() => conn.close())
  const got = exported(await conn.arrow("MATCH (n:person) WHERE n.name = 'ann' RETURN n"))
  assert.equal(got.fields.length, 1)
  const offset = got.fields[0].children.find((one) => one.name === 'offset')
  assert.ok(offset !== undefined, `a node exported as ${JSON.stringify(got.fields[0])}`)
  assert.equal(offset.format, 'L', 'an unsigned integer read back as a signed one')
})

// The buffer carries a row count beside the bytes and the bytes carry
// their own in the batches. A client where those two disagree has a bug
// no case asserting values would ever see, so the reader hands both back
// and the runner compares them.
test('an export counts its rows in the batches and beside them', async (t) => {
  const conn = await open(t)
  const got = exported(await conn.arrow('RETURN 1 AS n'))
  assert.equal(got.rows, 1)
  assert.equal(got.declared, 1, 'the buffer and its batches disagree about how many rows there are')
})

// A statement answering no columns at all is not a statement answering
// none of something, and the export has to come back rather than fail.
test('an export of a result with nothing in it still reads', async (t) => {
  const conn = await open(t)
  const got = exported(await conn.arrow('FINISH'))
  assert.deepEqual(got.fields, [])
  assert.equal(got.rows, 0)
  assert.equal(got.declared, 0)
})
