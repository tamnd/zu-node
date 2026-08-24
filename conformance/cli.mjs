#!/usr/bin/env node
/* Runs the shared cross-client corpus against this client and prints
 * what happened.
 *
 *     node conformance/cli.mjs ../zu/conformance/cases
 *
 * The report is the reference runner's, line for line, so a disagreement
 * between two clients is a diff and not a reading exercise. It exits
 * zero when nothing failed and one when something did or when the corpus
 * will not read, which is also the reference runner's rule.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { readDir } from './cases.mjs'
import { FAILED, PASSED, UNSUPPORTED, count, line, run, summary } from './runner.mjs'

const usage = [
  'usage: corpus [flags] <dir>',
  'run the shared corpus cases against this client',
  '  --strict     an unsupported case fails the run, which is what a release branch wants',
  '  --quiet      print the summary and nothing else',
  '  --work=<dir> a directory to make the case databases under, kept rather than removed',
].join('\n')

process.exitCode = await main()

async function main() {
  let options
  let positionals
  try {
    ;({ values: options, positionals } = parseArgs({
      options: {
        strict: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        work: { type: 'string', default: '' },
      },
      allowPositionals: true,
    }))
  } catch (err) {
    console.error(err.message)
    console.error(usage)
    return 2
  }
  if (positionals.length !== 1) {
    console.error(usage)
    return 2
  }

  let suites
  try {
    suites = await readDir(positionals[0])
  } catch (err) {
    // One rather than two, because the reference runner exits one for a
    // corpus it cannot read and a report that is compared line for line
    // is worth less if the two disagree about what the run came to.
    console.error('zu corpus:', err.message)
    return 1
  }

  let directory = options.work
  let temporary = ''
  try {
    if (directory === '') {
      // Removed when the run ends, and each case removes its own as it
      // finishes, so what is left in here at the end is the databases of
      // the cases that failed. A run with --work keeps them.
      temporary = await mkdtemp(join(tmpdir(), 'zu-corpus-'))
      directory = temporary
    } else {
      await mkdir(directory, { recursive: true })
    }
  } catch (err) {
    console.error('zu corpus:', err.message)
    return 1
  }

  try {
    const ran = await run(suites, directory, (one) => {
      if (!options.quiet && one.outcome !== PASSED) console.log(line(one))
    })
    console.log(summary(ran))
    if (count(ran, FAILED) > 0) return 1
    if (options.strict && count(ran, UNSUPPORTED) > 0) return 1
    return 0
  } finally {
    if (temporary !== '') await rm(temporary, { recursive: true, force: true })
  }
}
