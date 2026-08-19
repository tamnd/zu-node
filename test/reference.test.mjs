// The generated reference, and the two things about it worth asserting.
//
// Most of what a documentation generator does is not this suite's
// business: typedoc's theme is typedoc's, and a test that counted
// headings would fail on the week it renders one differently. What is
// this package's business is that the reference covers what the package
// publishes, and this package is assembled from two languages, so the
// interesting failure is the quiet one.
//
// `conn.stream(...)` and `await using` are put on the native class from
// JavaScript, because the class is registered by the addon and there is
// nowhere in Rust to write a generator or a method whose name is a
// symbol. They reach the types through the `declare module` in
// zudb.d.cts, which is the one construct a generator can read the whole
// file and still miss: api-extractor does, which is why the reference
// is not built from its doc model. A reference missing them builds,
// looks finished, and sends a reader to the cursor.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const tool = fileURLToPath(new URL('../tools/reference.mjs', import.meta.url))

// Bun and Deno resolve a package by rules of their own, and typedoc is
// the TypeScript compiler with a theme on it either way. What is being
// asked about here is the declarations rather than which runtime is
// reading them.
const NODE = !process.versions.bun && !process.versions.deno

async function built(t) {
  const into = await mkdtemp(join(tmpdir(), 'zu-node-reference-'))
  t.after(() => rm(into, { recursive: true, force: true }))
  const { stdout } = await run(process.execPath, [tool, into], { cwd: root })
  return { into, stdout }
}

test('the reference covers every name the package exports', { skip: !NODE }, async (t) => {
  const { stdout } = await built(t)
  assert.match(stdout, /0 complaints$/m)

  // The count in the line, against the package's own idea of how many
  // names it has. The tool checks the values; this checks that it was
  // looking at the whole surface and not at an entry point that
  // resolved to nothing.
  const { default: zudb } = await import(new URL('../zudb.cjs', import.meta.url).href)
  const names = Number(stdout.match(/(\d+) names/)[1])
  assert.ok(names >= Object.keys(zudb).length, `${names} documented, ${Object.keys(zudb).length} exported`)
})

test('the reference carries the half written in JavaScript', { skip: !NODE }, async (t) => {
  const { into } = await built(t)
  const page = await readFile(join(into, 'classes', 'Connection.html'), 'utf8')

  // The two members that reach the types by augmentation, and the
  // reason this package's reference is not built from api-extractor's
  // doc model.
  assert.match(page, /\bstream\b/)
  assert.match(page, /asyncDispose/)

  // And the ones that come from the Rust, so a page holding only the
  // augmentation would fail here rather than pass the check above.
  for (const name of ['query', 'exec', 'cursor', 'close']) assert.match(page, new RegExp(`>${name}<`))
})
