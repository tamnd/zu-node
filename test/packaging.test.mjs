// What a user gets when they type `npm i zudb`.
//
// None of this is exercised by importing the package on the machine
// that built it, which is exactly why it is tested: an install is the
// one thing that only goes wrong on somebody else's computer, and by
// then it has gone wrong on all of them.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PLATFORMS, binaryOf } from '../tools/platforms.mjs'

const root = new URL('../', import.meta.url)

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'))
}

test('installing builds nothing, so no compiler is needed and no script runs', async () => {
  const pkg = await json('package.json')

  // The three npm runs on the user's machine at install time. A binding
  // that needs any of them is a binding that needs a compiler, a
  // network fetch, or the trust to run arbitrary code, and the whole
  // point of shipping a binary per platform is that it needs none of
  // the three.
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[hook], undefined, `${hook} runs on the user's machine`)
  }

  const named = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
  for (const gyp of ['node-gyp', 'node-gyp-build', '@mapbox/node-pre-gyp', 'prebuild-install', 'node-addon-api']) {
    assert.equal(named.includes(gyp), false, `${gyp} is a build on the user's machine`)
  }

  // The root package carries no binary. Every one of them is its own
  // package, so npm downloads exactly the one the machine can run
  // rather than all eight.
  assert.deepEqual(pkg.files, ['index.js', 'index.d.ts', 'README.md', 'LICENSE'])
})

test('every target is built, published and asked for, or none of the three', async () => {
  const pkg = await json('package.json')

  assert.deepEqual(pkg.napi.targets, PLATFORMS.map((platform) => platform.target))
  assert.deepEqual(
    (await readdir(new URL('npm/', root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    PLATFORMS.map((platform) => platform.dir).sort(),
  )
})

test('the optional dependencies are written at publish time, not checked in', async () => {
  const pkg = await json('package.json')

  // The eight platform packages are what an install resolves one of, and
  // naming them here would be the obvious way to say so. It is also a
  // lock file npm cannot complete: a package that has not been published
  // yet resolves to nothing, `npm install` records the range and no
  // entry, and every `npm ci` after it fails with "missing from lock
  // file" on all eight. `napi pre-publish` writes the block from
  // napi.targets at the version being released, which is the same list
  // this suite holds the npm directories to.
  assert.equal(pkg.optionalDependencies, undefined)

  const lock = await json('package-lock.json')
  assert.equal(lock.packages[''].optionalDependencies, undefined)
})

test('a platform package says which machine it is for and holds one file', async () => {
  const pkg = await json('package.json')

  for (const platform of PLATFORMS) {
    const each = await json(`npm/${platform.dir}/package.json`)
    const binary = binaryOf(platform)

    assert.equal(each.name, `zudb-${platform.dir}`)
    // The same version as the root package, and exactly, because the
    // binary and the loader that dlopens it are one build cut in two.
    // A range here is a mix of two builds that npm would resolve
    // quietly.
    assert.equal(each.version, pkg.version)

    assert.deepEqual(each.os, [platform.os])
    assert.deepEqual(each.cpu, [platform.cpu])
    assert.deepEqual(each.libc, platform.libc ? [platform.libc] : undefined)
    assert.equal(each.main, binary)
    assert.deepEqual(each.files, [binary])
    assert.equal(each.license, 'Apache-2.0')
    assert.deepEqual(each.engines, pkg.engines)
  }
})

test('the loader asks for the packages that are published', async () => {
  const loader = await readFile(new URL('index.js', root), 'utf8')

  // The loader is generated and the packages are generated, from the
  // same list, but not by the same command and not at the same time.
  // What goes wrong is a name that agrees with nothing: the package
  // publishes as one thing and the require asks for another, and every
  // install on that platform falls through to the error at the end of
  // the loader.
  for (const platform of PLATFORMS) {
    assert.ok(
      loader.includes(`require('zudb-${platform.dir}')`),
      `the loader never requires zudb-${platform.dir}`,
    )
  }
})

test('the built binary is the one the loader looks for first', async () => {
  const here = await readdir(fileURLToPath(root))
  const built = here.filter((name) => name.endsWith('.node'))

  // One local build, beside the loader, which is what `napi build`
  // leaves and what the tests in this suite load. It is not published:
  // it is how a checkout runs without publishing anything.
  assert.equal(built.length, 1, `expected one built addon, found ${built.join(', ') || 'none'}`)
  assert.match(built[0], /^zudb\.[a-z0-9-]+\.node$/)
})
