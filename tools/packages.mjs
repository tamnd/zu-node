// Every platform package holds the binary it names.
//
// The set is what matters, which is why this is a tool and not eight
// assertions in eight jobs: a release that ships seven of eight
// packages installs on the eighth platform, resolves no binary, and
// fails at the require with a message about a package that exists.
// This is the last place that can be caught before publishing, and
// publishing is the step that cannot be taken back.
//
// It runs after `napi pre-publish`, which lays the binaries into the
// packages and writes the optional dependencies into the root manifest.
// Before that step half of what it looks at does not exist yet.
//
//   node tools/packages.mjs

import { readFile, stat } from 'node:fs/promises'

import { PLATFORMS, binaryOf } from './platforms.mjs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

const wrong = []
for (const platform of PLATFORMS) {
  const name = `zudb-${platform.dir}`
  const binary = binaryOf(platform)
  const where = new URL(`npm/${platform.dir}/`, root)

  let each
  try {
    each = JSON.parse(await readFile(new URL('package.json', where), 'utf8'))
  } catch {
    wrong.push(`${name} has no package.json`)
    continue
  }
  if (each.name !== name) wrong.push(`${platform.dir} publishes as ${each.name}`)
  // Exactly the root's version. The binary and the loader that dlopens
  // it are one build cut in two, and a range here is two builds npm
  // would mix quietly.
  if (each.version !== pkg.version) {
    wrong.push(`${name} is ${each.version} and the root package is ${pkg.version}`)
  }
  // Written by pre-publish rather than checked in, so this is also the
  // check that pre-publish ran at all.
  if (pkg.optionalDependencies?.[name] !== pkg.version) {
    wrong.push(`${name} is not an optional dependency at ${pkg.version}`)
  }

  try {
    const { size } = await stat(new URL(binary, where))
    // A zero length file is what a failed copy leaves, and it packs and
    // publishes exactly as well as a real one.
    if (size === 0) wrong.push(`${name} holds an empty ${binary}`)
  } catch {
    wrong.push(`${name} holds no ${binary}`)
  }
}

if (wrong.length) {
  for (const line of wrong) console.error(line)
  process.exit(1)
}
console.log(`${PLATFORMS.length} platform packages, each with its binary`)
