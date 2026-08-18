// Two module formats, one package, and the same names out of both.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'

import * as esm from 'zudb'

import { fresh } from './helper.mjs'

const root = new URL('../', import.meta.url)
const require = createRequire(import.meta.url)
const cjs = require('../zudb.cjs')

// Everything the package promises, written out rather than derived from
// either format, because a name that goes missing from both at once is
// exactly what a test derived from one of them cannot see.
const SURFACE = [
  'connect',
  'version',
  'abiVersion',
  'isZuError',
  'Connection',
  'ZuDate',
  'ZuTime',
  'ZuTimestamp',
  'ZuDuration',
  'ZuNode',
  'ZuRel',
]

test('the same names come out of require and out of import', () => {
  assert.deepEqual(Object.keys(cjs).sort(), [...SURFACE].sort())
  // A namespace object also carries the module's own machinery, so the
  // comparison is of what the package exports rather than of every key.
  const named = Object.keys(esm).filter((name) => name !== '__esModule')
  assert.deepEqual(named.sort(), [...SURFACE].sort())

  // The same objects, not two copies of them, which is what makes
  // `instanceof` work for a program that mixes the two formats. A
  // separate load per format would give a ZuDate from one that fails
  // `instanceof ZuDate` from the other.
  for (const name of SURFACE) assert.equal(esm[name], cjs[name], `${name} is loaded twice`)
})

test('there is no default export in either format', () => {
  // A default export of the namespace is a second spelling of every
  // name, and which of the two a caller gets then depends on their
  // bundler and their `esModuleInterop`.
  assert.equal(esm.default, undefined)
  assert.equal(cjs.default, undefined)
})

test('every export condition names its types first', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

  for (const [condition, entry] of Object.entries(pkg.exports['.'])) {
    // Conditions are matched in the order they are written, and a
    // resolver takes the first one that matches. `types` after
    // `default` is a `types` nothing ever reaches, which is a package
    // that compiles here and is `any` everywhere else.
    assert.equal(Object.keys(entry)[0], 'types', `${condition} does not name its types first`)
  }

  // The two formats are told apart by extension rather than by a
  // directory, so a resolver knows what it has before it reads it.
  assert.equal(pkg.exports['.'].import.default, './zudb.mjs')
  assert.equal(pkg.exports['.'].require.default, './zudb.cjs')
  assert.equal(pkg.exports['.'].import.types, './zudb.d.mts')
  assert.equal(pkg.exports['.'].require.types, './zudb.d.cts')

  // The old fields, for a resolver that reads no conditions at all.
  assert.equal(pkg.main, './zudb.cjs')
  assert.equal(pkg.types, './zudb.d.cts')
})

test('the guard narrows a caught value to a zu failure', async (t) => {
  assert.equal(cjs.isZuError(new Error('plain')), false)
  assert.equal(cjs.isZuError('a string'), false)
  assert.equal(cjs.isZuError(null), false)
  // A signal's abort is a failure the caller caused, and a caller
  // separating their own cancellation from the database's conditions
  // needs it to answer no.
  assert.equal(cjs.isZuError(new DOMException('stopped', 'AbortError')), false)

  const { conn } = await fresh(t)
  const caught = await conn.query('MATCH (').then(() => null, (err) => err)
  assert.equal(cjs.isZuError(caught), true)
  assert.equal(caught.name, 'ZuSyntaxError')
})
