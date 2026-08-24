// The shared cross-client corpus, run against this client.
//
// The cases live in the engine's repository and are versioned with it,
// so this test says where they are with an environment variable and
// skips without one. That is what zu-python does with ZU_CASES and what
// makes a checkout of this repository alone still `npm test` green: a
// client whose test suite cannot run without a second repository beside
// it is one nobody clones to fix a typo.
//
// CI sets the variable, having checked the engine out at the revision
// the addon was built from. Anything else compares a client against a
// corpus that is not the one it was built against, which reports the
// engine catching up to its own cases as this client failing.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readDir } from '../conformance/cases.mjs'
import { FAILED, PASSED, UNSUPPORTED, count, line, run, summary } from '../conformance/runner.mjs'

// Where the case files are, or undefined when nobody said.
const cases = process.env.ZU_CASES

// A directory to make the case databases under, removed when the test
// ends. What is left in it at the end is the databases of the cases that
// failed, which is the point of keeping it until then.
async function work(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-corpus-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('the corpus reads', { skip: cases ? false : 'ZU_CASES does not point at the case files' },
  async (t) => {
    const suites = await readDir(cases)
    const total = suites.reduce((sum, suite) => sum + suite.cases.length, 0)
    assert.ok(total > 0, `${suites.length} suites and no cases in any of them`)
    t.diagnostic(`${suites.length} suites, ${total} cases`)
  })

// The run, which is the whole point of the directory.
//
// A case the engine has not caught up to is unsupported and is not a
// failure, because the corpus is the contract and the engine catches up
// to it. A case that fails is this client answering a question wrongly,
// and there is no allowance for one.
test('every case in the corpus passes or is ahead of the engine',
  { skip: cases ? false : 'ZU_CASES does not point at the case files' },
  async (t) => {
    const suites = await readDir(cases)
    const ran = await run(suites, await work(t))
    const failed = ran.filter((one) => one.outcome === FAILED).map(line)
    t.diagnostic(summary(ran))
    // The ones ahead of the engine are listed rather than counted, so
    // that a release branch has something to read and so that a case
    // quietly becoming unsupported is visible in the log. The corpus is
    // run once and read twice, because running it is minutes.
    for (const one of ran) {
      if (one.outcome === UNSUPPORTED) t.diagnostic(`  ${line(one)}`)
    }
    assert.deepEqual(failed, [])
    // A run where nothing passed is a run that did not happen, which is
    // what a corpus read from the wrong directory or an addon that
    // answers nothing looks like from here.
    assert.ok(
      count(ran, PASSED) > 0,
      'no case passed, and a run where nothing passes is a run that did not happen',
    )
  })
