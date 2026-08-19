// The README against a runtime that runs it.
//
// A quickstart is the most read and least executed code a client has.
// It is copied by hand out of a page, and it goes wrong quietly, a
// rename or a renamed option at a time, until somebody's first five
// minutes are spent on a stack trace. So the blocks that are whole
// programs are run here, as printed, character for character.
//
// A block is a whole program when its first line imports this package
// and nothing in it calls `require`, which is the rule the README
// follows: a block that stands on its own opens with the import, a
// block showing one call in the middle of a session opens with the
// call, and the one block that shows both module formats side by side
// is a comparison rather than a program. The count is asserted below,
// so a block that changes which kind it is fails here rather than
// slipping out of the check.
//
// Each program runs in a directory of its own with this package
// installed into it the way npm would install it, because the file it
// writes is the one a reader finds beside them afterwards and the
// import it opens with is the one a reader types.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../', import.meta.url)))

// Node runs a TypeScript file by erasing the types, and the README is
// written in TypeScript because that is what a reader of a typed client
// copies. Bun and Deno run these programs too, but they resolve a
// package by rules of their own, and what this is asking about is the
// characters on the page rather than which runtime is spawning them.
const NODE = !process.versions.bun && !process.versions.deno

async function blocks(language) {
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const found = []
  let current = null
  for (const line of text.split('\n')) {
    if (current === null) {
      if (line.trimEnd() === '```' + language) current = []
    } else if (line.trimEnd() === '```') {
      found.push(current.join('\n') + '\n')
      current = null
    } else {
      current.push(line)
    }
  }
  assert.equal(current, null, 'a fenced block the README never closes')
  return found
}

async function programs() {
  const found = await blocks('ts')
  return found.filter((block) => block.startsWith('import ') && !block.includes('require('))
}

// A directory holding one program and an installed copy of this
// package, which is a link rather than a copy because what is being
// checked is the addon that was just built.
async function installed(t, program) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-node-readme-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await mkdir(join(dir, 'node_modules'))
  // A junction rather than a symbolic link, which is what npm itself
  // makes on Windows: a symbolic link to a directory needs a privilege
  // there that a test runner does not have, and a junction needs none.
  // Every other platform ignores the word.
  await symlink(root, join(dir, 'node_modules', 'zudb'), 'junction')
  const file = join(dir, 'main.ts')
  await writeFile(file, program)
  return { dir, file }
}

test('the README prints programs and fragments and knows which is which', async () => {
  assert.equal((await programs()).length, 1, "the README's whole programs")
  assert.ok((await blocks('ts')).length > (await programs()).length, 'and its fragments')
})

test('the first minute of the README runs as printed', { skip: !NODE }, async (t) => {
  const [program] = await programs()
  assert.ok(program.includes('connect("social.zu1")'), 'the block that opens the page')

  const { dir, file } = await installed(t, program)
  const { stdout } = await run(process.execPath, [file], { cwd: dir })

  // Two rows are written and one is asked for by name. The id comes
  // back a bigint, which is what the page says two paragraphs down and
  // what `console.log` spells with an `n` on the end.
  assert.equal(stdout.trim(), '2n zoe')

  // A reader runs it in the directory they are standing in, and the
  // database is there when it finishes.
  await stat(join(dir, 'social.zu1'))
})

test('every whole program in the README runs', { skip: !NODE }, async (t) => {
  for (const program of await programs()) {
    const { dir, file } = await installed(t, program)
    await run(process.execPath, [file], { cwd: dir })
  }
})
