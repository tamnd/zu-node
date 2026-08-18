// The addon a build row produced is the one that row was for.
//
// `napi build` names the file after the target it built, so a row that
// built the wrong thing produces a file with the wrong name and an
// upload that succeeds. This is what turns that into a failure on the
// row that did it, rather than a platform package that is quietly empty
// three jobs later.
//
//   node tools/binary.mjs x86_64-unknown-linux-musl

import { access } from 'node:fs/promises'

import { binaryOf, platformOf } from './platforms.mjs'

const [target] = process.argv.slice(2)
if (!target) {
  console.error('usage: node tools/binary.mjs <target triple>')
  process.exit(2)
}

const binary = binaryOf(platformOf(target))
try {
  await access(new URL(`../${binary}`, import.meta.url))
} catch {
  console.error(`${target} built no ${binary}`)
  process.exit(1)
}
console.log(`${target} built ${binary}`)
