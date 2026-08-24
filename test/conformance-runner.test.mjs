// The runner: what it does with a case, and what it says about one that
// did not do what the case said it would.
//
// Two halves. The first is the report, which is strings and counting and
// is diffed against the reference runner's output, so it is checked word
// for word. The second runs cases against this client for real, and is
// written to turn on the runner's own behaviour rather than on the
// engine's: a case here asserts the wrong answer on purpose and the test
// is that the runner noticed and said the right thing about it. Where a
// GQLSTATUS the engine chooses would otherwise be baked in, the test
// checks the shape of the line and not the code, because the code is the
// engine's to change and this file is about the runner.
//
// The corpus itself is run by conformance.test.mjs, which needs the case
// files and skips without them. This one needs nothing but the addon.

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { read } from '../conformance/cases.mjs'
import { FAILED, PASSED, UNSUPPORTED, count, line, mark, run, summary } from '../conformance/runner.mjs'

const HEAD = 'schema: 4\nsuite: example\ndoc: what this suite is for\n'

// A suite of the cases given, each one a block of lines.
function suite(...cases) {
  return read(HEAD + 'cases:\n' + cases.flat().map((one) => `  ${one}\n`).join(''))
}

// A load, written once and put in front of a suite that needs one.
const LOAD = [
  'load:',
  '  nodes: person',
  '  edges: knows',
  '  count: 2',
  '  columns:',
  '    - name: id',
  '      type: INT64',
  '      values:',
  '        - "1"',
  '        - "2"',
  '    - name: score',
  '      type: FLOAT64',
  '      values:',
  '        - "1.0"',
  '        - "2.5"',
  '    - name: tag',
  '      type: STRING',
  '      values:',
  '        - a',
  '        - b',
  '  pairs:',
  '    - from: 0',
  '      to: 1',
]

// A directory to make the case databases under, gone when the test ends.
async function work(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zu-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// Runs a suite and gives back its cases by name, so that a test names
// what it is asserting rather than counting positions.
async function ranBy(t, held) {
  const ran = await run([held], await work(t))
  const by = new Map(ran.map((one) => [one.case, one]))
  assert.equal(by.size, ran.length, 'two cases came back under one name')
  return by
}

test('a report spells an outcome the way the reference runner does', () => {
  assert.equal(mark(PASSED), 'ok')
  assert.equal(mark(FAILED), 'FAILED')
  assert.equal(mark(UNSUPPORTED), 'unsupported')
})

test('a line is the suite, the case, the line and what happened', () => {
  const one = { suite: 'string', case: 'utf8-length', line: 42, outcome: PASSED, detail: '' }
  assert.equal(line(one), 'string/utf8-length line 42 ok')
  // The detail goes after a colon, and a case with none has no colon at
  // all rather than one with nothing behind it.
  assert.equal(
    line({ ...one, outcome: FAILED, detail: '1 rows where the case wants 2' }),
    'string/utf8-length line 42 FAILED: 1 rows where the case wants 2',
  )
  assert.equal(
    line({ ...one, outcome: UNSUPPORTED, detail: '42601 syntax error' }),
    'string/utf8-length line 42 unsupported: 42601 syntax error',
  )
})

test('a summary counts each outcome and the run as a whole', () => {
  const ran = [
    { outcome: PASSED }, { outcome: PASSED }, { outcome: FAILED }, { outcome: UNSUPPORTED },
  ]
  assert.equal(count(ran, PASSED), 2)
  assert.equal(count(ran, FAILED), 1)
  assert.equal(count(ran, UNSUPPORTED), 1)
  assert.equal(summary(ran), '4 cases, 2 passed, 1 failed, 1 unsupported')
  assert.equal(summary([]), '0 cases, 0 passed, 0 failed, 0 unsupported')
})

// From here down the addon runs statements for real.

test('a case whose answer is what the engine gives passes', async (t) => {
  const by = await ranBy(
    t,
    suite([
      '- name: one',
      '  doc: a value comes back as itself',
      '  query: RETURN 1 AS n',
      '  columns:',
      '    - n',
      '  rows:',
      '    - values:',
      '        - type: INT64',
      '          value: "1"',
    ]),
  )
  const one = by.get('one')
  assert.equal(one.outcome, PASSED, one.detail)
  assert.equal(one.detail, '')
  assert.equal(one.suite, 'example')
  assert.equal(one.line, 5)
})

// The wordings a failing case prints. Every one of these is driven by a
// statement the engine certainly answers, so what is under test is the
// runner's comparison and not the engine's opinion.
test('a case whose answer differs says what differs and stops there', async (t) => {
  const by = await ranBy(
    t,
    suite(
      [
        '- name: wrong-value',
        '  doc: the value is not the one the engine gives',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "2"',
      ],
      [
        '- name: wrong-name',
        '  doc: the column is not the one the engine names',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - m',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "1"',
      ],
      [
        '- name: wrong-count',
        '  doc: there are fewer rows than the case wants',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "1"',
        '    - values:',
        '        - type: INT64',
        '          value: "1"',
      ],
      [
        '- name: wrong-type',
        '  doc: the value is the right number under the wrong type',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: FLOAT64',
        '          value: "1.0"',
      ],
    ),
  )
  for (const [name, want] of [
    ['wrong-value', 'row 1 column n is INT64 "1" where the case wants INT64 "2"'],
    ['wrong-name', 'columns ["n"] where the case wants ["m"]'],
    ['wrong-count', '1 rows where the case wants 2'],
    // The type is part of the answer, so a whole 1 that came back as an
    // integer does not satisfy a case wanting a float. This is the one
    // comparison a runner written with == would get wrong in four
    // languages out of five.
    ['wrong-type', 'row 1 column n is INT64 "1" where the case wants FLOAT64 "1.0"'],
  ]) {
    const one = by.get(name)
    assert.equal(one.outcome, FAILED, `${name} did not fail`)
    assert.equal(one.detail, want, name)
  }
})

// A condition is checked by its code. The code the engine picks for a
// broken statement is the engine's to change, so what is asserted here
// is that the runner compared the code it was given and reported the
// comparison, not which code that was.
test('a case that raises is checked against the code and not the message', async (t) => {
  const by = await ranBy(
    t,
    suite(
      [
        '- name: rows-where-a-condition-was-wanted',
        '  doc: the statement answered where the case wants it to fail',
        '  query: RETURN 1 AS n',
        '  raises: 22003',
      ],
      [
        '- name: another-code',
        '  doc: the statement failed with a code that is not the one wanted',
        '  query: THIS IS NOT A STATEMENT',
        '  raises: 22003',
      ],
    ),
  )
  const rows = by.get('rows-where-a-condition-was-wanted')
  assert.equal(rows.outcome, FAILED)
  assert.equal(rows.detail, 'returned rows where the case wants 22003')

  const other = by.get('another-code')
  assert.equal(other.outcome, FAILED, other.detail)
  assert.match(
    other.detail,
    /^raised [0-9A-Z]{5} where the case wants 22003: /,
    'a mismatched condition did not print the code it got and the code it wanted',
  )
})

// A case the engine has not caught up to is not a failure. The corpus is
// the contract and the engine catches up to it, so a statement it cannot
// parse or has not implemented comes back as unsupported and a release
// branch is what decides whether that is allowed.
test('a case ahead of the engine is unsupported rather than failed', async (t) => {
  const by = await ranBy(
    t,
    suite([
      '- name: ahead',
      '  doc: a statement the engine does not parse',
      '  query: THIS IS NOT A STATEMENT',
      '  columns:',
      '    - n',
      '  rows:',
    ]),
  )
  const one = by.get('ahead')
  assert.equal(one.outcome, UNSUPPORTED, one.detail)
  assert.notEqual(one.detail, '', 'an unsupported case said nothing about why')
})

// The other kind of unsupported, which is this client's own limit rather
// than the engine's. A row comes back keyed by column name, so a result
// naming two columns the same is one this client cannot read
// positionally, and the corpus writes a case for exactly that. Reporting
// it unsupported names what the mapping costs, where failing it would
// read as the engine having answered wrongly and passing it would mean
// comparing against a row invented for the occasion.
test('a result this client cannot hold is unsupported rather than failed', async (t) => {
  const by = await ranBy(
    t,
    suite([
      '- name: twice',
      '  doc: two columns of one name',
      '  query: RETURN 1 AS a, 2 AS a',
      '  columns:',
      '    - a',
      '    - a',
      '  rows:',
      '    - values:',
      '        - type: INT64',
      '          value: "1"',
      '        - type: INT64',
      '          value: "2"',
    ]),
  )
  const one = by.get('twice')
  assert.equal(one.outcome, UNSUPPORTED, one.detail)
  assert.match(one.detail, /two columns of one name/)
})

test('a setup statement runs before the case and its failure is not a pass', async (t) => {
  const by = await ranBy(
    t,
    suite(
      [
        '- name: ran',
        '  doc: the setup ran and the case did too',
        '  setup:',
        '    - RETURN 1',
        '  query: RETURN 2 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "2"',
      ],
      [
        '- name: broken-setup',
        '  doc: the setup did not run, so the case says nothing about the statement',
        '  setup:',
        '    - THIS IS NOT A STATEMENT',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "1"',
      ],
    ),
  )
  assert.equal(by.get('ran').outcome, PASSED, by.get('ran').detail)
  const broken = by.get('broken-setup')
  // Never a pass, whichever way the setup went wrong, and the line says
  // which of the setup statements it was.
  assert.notEqual(broken.outcome, PASSED)
  assert.match(broken.detail, /^setup 1[: ]/, broken.detail)
})

// A transaction is only observable from outside it, so a case that has
// something to say about one needs a second connection to say it to. The
// second is a duplicate of the first rather than a second open of the
// file, which is what makes the two share the write side.
test('a case may name a second connection and the two see one database', async (t) => {
  const by = await ranBy(
    t,
    suite([
      '- name: two-connections',
      '  doc: a statement on a connection the case named',
      '  setup:',
      '    - on: other',
      '      query: RETURN 1',
      '  on: other',
      '  query: RETURN 1 AS n',
      '  columns:',
      '    - n',
      '  rows:',
      '    - values:',
      '        - type: INT64',
      '          value: "1"',
    ]),
  )
  const one = by.get('two-connections')
  assert.equal(one.outcome, PASSED, one.detail)
})

// The bulk load is the other half of the corpus question: everything
// else asserts what a value means on the way out, and a load is a value
// going in by the path that builds the file rather than by a statement.
//
// What is asserted here is that the load went in, not what a statement
// then made of it: a suite whose load failed reports it with a detail
// that opens "the suite's load", and no case in a suite whose load
// failed says anything about the engine.
test('a suite with a load puts it in before the case runs', async (t) => {
  const by = await ranBy(
    t,
    read(
      HEAD +
        [...LOAD, 'cases:',
          '  - name: loaded',
          '    doc: the load went in',
          '    query: THIS IS NOT A STATEMENT',
          '    columns:',
          '      - n',
          '    rows:',
          ''].join('\n'),
    ),
  )
  const one = by.get('loaded')
  assert.ok(
    !one.detail.startsWith("the suite's load"),
    `the load did not go in: ${one.detail}`,
  )
})

// A case may say what the export gives as well as what the rows are.
// What is under test here is that the runner exported at all and lined
// the fields up by name, since the Arrow type the engine picks for a
// column is the engine's and is asserted by the corpus itself.
test('a case may say what its export gives and the two are lined up by name', async (t) => {
  const by = await ranBy(
    t,
    suite([
      '- name: wrong-field-name',
      '  doc: the export gives a field the case named something else',
      '  query: RETURN 1 AS n',
      '  columns:',
      '    - n',
      '  rows:',
      '    - values:',
      '        - type: INT64',
      '          value: "1"',
      '  arrow:',
      '    - name: wrong',
      '      format: l',
    ]),
  )
  const one = by.get('wrong-field-name')
  assert.equal(one.outcome, FAILED, one.detail)
  assert.equal(one.detail, 'arrow field 1 in the result is named "n" where the case wants "wrong"')
})

// A failure leaves its database behind, because that is the one thing
// somebody reading the report will want to open. Everything else goes as
// it finishes, since a corpus of fourteen hundred cases is fourteen
// hundred files and holding them all until the run ends is gigabytes of
// a disk that has other work to do.
test('a run keeps the database of a case that failed and removes the rest', async (t) => {
  const dir = await work(t)
  const ran = await run(
    [suite(
      [
        '- name: passes',
        '  doc: a case that passes',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "1"',
      ],
      [
        '- name: fails',
        '  doc: a case that does not',
        '  query: RETURN 1 AS n',
        '  columns:',
        '    - n',
        '  rows:',
        '    - values:',
        '        - type: INT64',
        '          value: "2"',
      ],
    )],
    dir,
  )
  assert.equal(count(ran, FAILED), 1, summary(ran))
  const left = (await readdir(dir)).sort()
  assert.ok(left.includes('example-fails.zu'), `${left.join(', ')} was left behind`)
  assert.ok(!left.includes('example-passes.zu'), `${left.join(', ')} was left behind`)
  // And the log beside it, since a log left under a name the next run
  // creates again is a log that run would adopt.
  assert.ok(!left.includes('example-passes.zu.wal'), `${left.join(', ')} was left behind`)
})

// The order is the order the cases were written in, because a report
// that is diffed against another runner's has to walk them the same way.
test('a run reports its cases in the order the file writes them', async (t) => {
  const ran = await run(
    [suite(
      ['- name: first', '  doc: d', '  query: RETURN 1', '  raises: 42601'],
      ['- name: second', '  doc: d', '  query: RETURN 1', '  raises: 42601'],
      ['- name: third', '  doc: d', '  query: RETURN 1', '  raises: 42601'],
    )],
    await work(t),
  )
  assert.deepEqual(ran.map((one) => one.case), ['first', 'second', 'third'])
  // And each one is handed over as it finishes rather than at the end,
  // which is what makes a run of fourteen hundred cases print as it goes.
  const seen = []
  await run(
    [suite(
      ['- name: first', '  doc: d', '  query: RETURN 1', '  raises: 42601'],
      ['- name: second', '  doc: d', '  query: RETURN 1', '  raises: 42601'],
    )],
    await work(t),
    (one) => seen.push(one.case),
  )
  assert.deepEqual(seen, ['first', 'second'])
})
