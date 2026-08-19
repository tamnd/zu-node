// The API reference, generated from the types this package publishes.
//
// A reference written by hand beside the code is wrong by the second
// release, and wrong in the way that costs the most: it looks
// maintained. So this one is generated, and the release generates it
// from the same declarations the published package carries rather than
// from a page somebody remembered to edit.
//
//   node tools/reference.mjs <directory>
//
// typedoc rather than api-documenter, which is the other half of the
// api-extractor toolchain and would have been the obvious pick since
// api-extractor already runs here for the stability report. It reads
// the doc model api-extractor builds, and that model does not carry
// `conn.stream(...)` or `await using`: both arrive on `Connection`
// through the `declare module` in zudb.d.cts, which api-extractor does
// not follow. A reference missing the streaming entry point is a
// reference that sends a reader to the cursor, so the generator that
// reads the declarations with the TypeScript compiler is the one to
// use, and the check below is what says it still does.
//
// The entry point is zudb.d.cts and not zudb.d.mts, for the reason
// api-extractor.json gives: the CommonJS declarations are the ones
// written, the ESM file re-exports them, and a public API in two copies
// is two copies that drift.

import { readFile } from 'node:fs/promises'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Application, ReflectionKind, TSConfigReader } from 'typedoc'

const root = new URL('../', import.meta.url)

// An entry point is a glob, and in a glob a backslash escapes whatever
// comes after it. So on Windows the path this file computes for its own
// sibling is read as `zudb.d.cts` with three escapes in it, matches
// nothing, and typedoc says so and carries on to generate an empty
// reference. Separators forward, which is what typedoc asks for and what
// every path option here takes on either platform.
const posix = (url) => fileURLToPath(url).replaceAll('\\', '/')

// The members `zudb.cjs` puts on the native class from JavaScript,
// which is where anything with a generator or a symbol for a name has
// to live: the class is registered by the addon and there is nowhere in
// Rust to write either. They are the reason this file uses typedoc, so
// a reference that lost them is the failure worth naming, and naming
// them here means a new one shows up as a mismatch rather than as a
// page nobody notices is thin.
const AUGMENTED = ['stream', '[asyncDispose]']

async function build(into) {
  const app = await Application.bootstrapWithPlugins(
    {
      entryPoints: [posix(new URL('zudb.d.cts', root))],
      tsconfig: posix(new URL('tools/api-extractor.tsconfig.json', root)),
      // The declarations are read rather than checked. Checking them is
      // what `npm run check:types` is for, against the tsconfig a user's
      // own compiler would use, and a generator that also type-checks is
      // a second opinion nobody asked for on the week the two disagree.
      skipErrorChecking: true,
      name: 'zudb',
      readme: 'none',
      githubPages: false,
    },
    [new TSConfigReader()],
  )
  const project = await app.convert()
  if (!project) throw new Error('typedoc read the declarations and made nothing of them')
  // A file it could not find is an error it prints and then carries on
  // from, with a project that has nothing in it. The complaints below
  // would report that as thirteen missing pages, which is a true answer
  // to the wrong question, so it is said here in one line instead.
  if (app.logger.hasErrors()) throw new Error('typedoc reported an error, so what is above it is not a reference')
  await app.generateDocs(project, into)
  return project
}

// What the reference has to cover, and the two ways it could quietly
// stop covering it.
function complaints(project, exported) {
  const wrong = []
  const documented = new Map((project.children ?? []).map((each) => [each.name, each]))

  // A name a program can `require` and the reference does not carry is
  // a name whose types went missing, which is a worse failure than a
  // thin page: it compiles nowhere.
  for (const name of exported) {
    const found = documented.get(name)
    if (!found) wrong.push(`${name} is exported and the reference has no page for it`)
    else if (!found.kindOf([ReflectionKind.Class, ReflectionKind.Function, ReflectionKind.Variable]))
      wrong.push(
        `${name} is exported as a value and documented as ${ReflectionKind.singularString(found.kind)}`,
      )
  }

  // And the other direction, on the one class that is assembled from
  // two languages. Every method a connection answers to has to be on
  // the page, including the ones that are there by augmentation, which
  // is the thing this generator was chosen for.
  const connection = documented.get('Connection')
  const members = new Set((connection?.children ?? []).map((each) => each.name))
  for (const name of AUGMENTED) {
    if (!members.has(name)) {
      wrong.push(
        `${name} is on Connection at runtime and not in the reference, ` +
          'so the generator has stopped following the augmentation in zudb.d.cts',
      )
    }
  }

  return wrong
}

const into = argv[2]
if (!into) {
  console.error('usage: node tools/reference.mjs <directory>')
  exit(2)
}

const project = await build(into)
// Read after the build rather than imported at the top, because the
// loader dlopens the addon for this machine and a machine with no
// binary built should be told that by the require and not by a stack
// trace out of typedoc.
const { default: zudb } = await import(new URL('zudb.cjs', root).href)
const wrong = complaints(project, Object.keys(zudb))

for (const each of wrong) console.error(each)
const version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version
console.log(`zudb ${version}: ${project.children?.length ?? 0} names in ${into}, ${wrong.length} complaints`)
exit(wrong.length ? 1 : 0)
