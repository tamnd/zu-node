// What `npm i zudb` does, done for real, on the machine running this.
//
// Everything else about packaging is read off manifests, and a manifest
// can be right in every field and still install into something that
// cannot be required. So this packs the two tarballs npm would fetch,
// installs them into an empty project outside this checkout, and runs a
// statement through what came out. It also proves the part that has no
// other way of being tested: the seven platform packages that do not
// exist yet are optional, and an install that cannot fetch them is
// expected to carry on rather than fail.
//
//   node tools/install.mjs

import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { binaryOf, hostPlatform } from './platforms.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const platform = hostPlatform()

// The binary belongs to the platform package, which is where a release
// puts it and where npm would fetch it from. A checkout has it beside
// the loader instead, so say so rather than failing inside npm pack.
const binary = binaryOf(platform)
try {
  await access(join(root, 'npm', platform.dir, binary))
} catch {
  console.error(`npm/${platform.dir} holds no ${binary}: run npm run build, then cp ${binary} npm/${platform.dir}/`)
  process.exit(1)
}

// Outside the checkout, because npm walks upwards looking for a project
// to belong to and would find this one.
const where = await mkdtemp(join(tmpdir(), 'zudb-install-'))
const app = join(where, 'app')

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

try {
  // The root package, which carries the loader and no binary, and the
  // one platform package this machine can use.
  const packed = [root, join(root, 'npm', platform.dir)].map((each) =>
    join(where, npm(['pack', '--silent', '--pack-destination', where, each], root).trim()),
  )

  await mkdir(app)
  npm(['init', '-y'], app)
  npm(['install', '--no-audit', '--no-fund', ...packed], app)

  await writeFile(
    join(app, 'run.mjs'),
    [
      "import assert from 'node:assert/strict'",
      "import { connect, isZuError } from 'zudb'",
      "const conn = await connect(':memory:')",
      'await conn.exec("INSERT (:person {id: 1, name: \'ada\'})")',
      "const rows = await conn.query('MATCH (p:person) RETURN p.name AS name')",
      "assert.deepEqual(rows.columns, ['name'])",
      "assert.equal(rows[0].name, 'ada')",
      "assert.equal(isZuError(await conn.query('MATCH (').catch((err) => err)), true)",
      // The streamed path as well, because it is the one part of the
      // surface that is written in JavaScript over the addon rather
      // than by the addon, and an installed package is where a missing
      // file in `files` turns up.
      "const stream = conn.stream('MATCH (p:person) RETURN p.name AS name')",
      'const names = []',
      'for await (const row of stream) names.push(row.name)',
      "assert.deepEqual(names, ['ada'])",
      'assert.equal(stream.summary.rows, 1)',
      'await conn.close()',
    ].join('\n'),
  )
  execFileSync(process.execPath, [join(app, 'run.mjs')], { cwd: app, stdio: 'inherit' })

  // The other half of the package, resolved through the other condition.
  // The two formats reach the same loaded module, so a value made by one
  // is an instance of the class the other exports, and a program that
  // mixes them is not quietly holding two of everything.
  await writeFile(
    join(app, 'run.cjs'),
    [
      "const assert = require('node:assert/strict')",
      "const required = require('zudb')",
      "import('zudb').then(async (imported) => {",
      '  assert.equal(required.ZuDate, imported.ZuDate)',
      "  const conn = await required.connect(':memory:')",
      "  const rows = await conn.query('RETURN 1 AS n')",
      '  assert.equal(rows[0].n, 1n)',
      '  await conn.close()',
      '})',
    ].join('\n'),
  )
  execFileSync(process.execPath, [join(app, 'run.cjs')], { cwd: app, stdio: 'inherit' })

  console.log(`installed zudb and zudb-${platform.dir} into an empty project, and it ran a statement from both formats`)
} finally {
  await rm(where, { recursive: true, force: true })
}
