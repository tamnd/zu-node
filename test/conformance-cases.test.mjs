// What a case file is allowed to say, and what it is not.
//
// A case is read once and run against every client, so a file that reads
// two ways is worse than a file that does not read at all. Most of this
// is therefore refusals, and each of them is a mistake somebody would
// otherwise make quietly: a case whose row has one value too few, a load
// whose column has one value too many, a name that is spelled two ways in
// two clients, a case that says both what it returns and what it raises.
//
// The messages are checked in full, for the reason they are in the reader
// test: they are diffed against the reference runner's report and a
// wording that drifted is a difference in the report that is not a
// difference in the answer.

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CorpusError, quote } from '../conformance/reader.mjs'
import { MAIN, SCHEMA, read, readDir } from '../conformance/cases.mjs'
import { same, show } from '../conformance/values.mjs'

// The head of a file that reads, so that a test about one key is a test
// about that key.
const HEAD = `schema: ${SCHEMA}\nsuite: example\ndoc: what this suite is for\n`

// A file holding one case, with the lines given put under `cases:`.
function suite(...lines) {
  return HEAD + 'cases:\n' + lines.map((one) => `  ${one}\n`).join('')
}

// The one case a file of one case holds.
function only(text) {
  const held = read(text)
  assert.equal(held.cases.length, 1, 'the file held more than one case')
  return held.cases[0]
}

// The message a file was refused with, and a failure when it was read.
function refused(text) {
  try {
    read(text)
    assert.fail('this file was read, and it should have been refused')
  } catch (err) {
    assert.ok(err instanceof CorpusError, `read gave a ${err.name}, and everything here is a CorpusError`)
    return err.message
  }
}

test('a suite is a header, an optional load and its cases', () => {
  const held = read(
    HEAD +
      ['cases:', '  - name: one', '    doc: the first', '    query: RETURN 1', '    columns:', '      - n',
        '    rows:', '      - values:', '          - type: INT64', '            value: "1"',
        '  - name: two', '    doc: the second', '    query: RETURN 2', '    raises: 42601', ''].join('\n'),
  )
  assert.equal(held.name, 'example')
  assert.equal(held.doc, 'what this suite is for')
  assert.equal(held.load, null, 'a suite with no `load:` came back with one')
  assert.deepEqual(held.cases.map((one) => one.name), ['one', 'two'])
  assert.deepEqual(held.cases[0].columns, ['n'])
  assert.ok(same([[1n]], held.cases[0].rows))
  assert.equal(held.cases[0].raises, '')
  assert.equal(held.cases[1].raises, '42601')
  assert.equal(held.cases[1].hasColumns, false)
  // The line a report cites is the line the case opened on, which is what
  // makes a failure something to open a file at.
  assert.equal(held.cases[0].line, 5)
  assert.equal(held.cases[1].line, 14)
})

// The version exists so that a corpus unpacked from an old release says
// what it is instead of failing somewhere in the middle of a suite.
test('a file says which schema it is and is refused when it is another', () => {
  assert.equal(
    refused(`schema: ${SCHEMA + 1}\nsuite: example\ndoc: d\ncases:\n  - name: one\n`),
    `this is schema ${SCHEMA + 1} and the runner reads schema ${SCHEMA}`,
  )
  assert.equal(refused('suite: example\ndoc: d\n'), 'the file does not open with `schema:`')
  assert.equal(refused('schema: four\nsuite: example\ndoc: d\n'), '"four" is not a schema version')
})

test('a suite says what it is and what is in it', () => {
  for (const [what, text, want] of [
    ['no suite name', `schema: ${SCHEMA}\ndoc: d\n`, 'line 1: no `suite:`'],
    ['no doc', `schema: ${SCHEMA}\nsuite: example\n`, 'line 1: no `doc:`'],
    ['no cases', HEAD, 'a suite with no `cases:`'],
    ['an empty cases', `${HEAD}cases:\n`, '`cases:` is a sequence'],
    ['a key nothing knows', `${HEAD}extra: 1\n`, 'line 1: a suite has no key "extra"'],
  ]) {
    assert.equal(refused(text), want, `${what} was refused with the wrong words`)
  }
})

test('a case says what it is, what it runs and what that produces', () => {
  const body = ['doc: d', 'query: RETURN 1', 'columns:', '  - n', 'rows:']
  for (const [what, lines, want] of [
    ['no name', ['- doc: d', '  query: RETURN 1'], 'line 5: no `name:`'],
    ['no doc', ['- name: one', '  query: RETURN 1'], 'line 5: no `doc:`'],
    ['no query', ['- name: one', '  doc: d'], 'line 5: no `query:`'],
    [
      'no expectation at all',
      ['- name: one', '  doc: d', '  query: RETURN 1'],
      'line 5: a case says what it produces, with `columns:` and `rows:` or with `raises:`',
    ],
    [
      'both an expectation and a condition',
      ['- name: one', ...body.map((l) => `  ${l}`), '  raises: 42601'],
      'line 5: a case that raises has no rows, and one that returns rows does not raise',
    ],
    [
      'columns with no rows',
      ['- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - n'],
      'line 5: `columns:` with no `rows:`. A case expecting nothing back writes `rows:` with an ' +
        'empty sequence under it.',
    ],
    ['a key nothing knows', ['- name: one', '  doc: d', '  qeury: RETURN 1'], 'line 5: a case has no key "qeury"'],
    [
      'a case that is not a mapping',
      ['- just a scalar'],
      'line 5: a case is a mapping, and this is a scalar',
    ],
  ]) {
    assert.equal(refused(suite(...lines)), want, `${what} was refused with the wrong words`)
  }
})

// A name is what a report cites and what a binding's skip list names, so
// it is spelled one way and only one way.
test('a name is lower case words joined by dashes', () => {
  for (const name of ['one', 'a-b-c', 'utf8-length', 'a1']) {
    assert.equal(only(suite(`- name: ${name}`, '  doc: d', '  query: RETURN 1', '  raises: 42601')).name, name)
  }
  for (const name of ['One', 'a_b', 'a b', 'a.b', "'"]) {
    assert.equal(
      refused(suite(`- name: ${quote(name)}`, '  doc: d', '  query: RETURN 1', '  raises: 42601')),
      `line 5: ${quote(name)} is a case name, which is lower case words joined by dashes`,
      name,
    )
  }
})

test('two cases of one name are refused', () => {
  const one = ['- name: one', '  doc: d', '  query: RETURN 1', '  raises: 42601']
  assert.equal(refused(suite(...one, ...one)), 'two cases are called "one"')
})

// The code and not the message, because the code is the contract and the
// message is prose that will improve.
test('a condition is a GQLSTATUS and is checked for its shape', () => {
  assert.equal(only(suite('- name: one', '  doc: d', '  query: RETURN 1', '  raises: 42601')).raises, '42601')
  for (const code of ['4260', '426011', '4260a', 'syntax error', '42-01']) {
    assert.equal(
      refused(suite('- name: one', '  doc: d', '  query: RETURN 1', `  raises: ${quote(code)}`)),
      `line 8: ${quote(code)} is not the shape of a GQLSTATUS, which is five characters of digits ` +
        'and capitals',
      code,
    )
  }
})

// FINISH answers no columns at all, which is not the same as a query
// whose columns held no rows, so both spellings have to read.
test('a case with no columns and a case with no rows are both cases', () => {
  const noColumns = only(suite('- name: one', '  doc: d', '  query: FINISH', '  columns:', '  rows:'))
  assert.equal(noColumns.hasColumns, true, 'an empty `columns:` was taken for an absent one')
  assert.deepEqual(noColumns.columns, [])
  assert.deepEqual(noColumns.rows, [])

  const noRows = only(suite('- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - n', '  rows:'))
  assert.deepEqual(noRows.columns, ['n'])
  assert.deepEqual(noRows.rows, [])
})

test('a row that does not fit its columns is refused where it is written', () => {
  assert.equal(
    refused(
      suite(
        '- name: one', '  doc: d', '  query: RETURN 1, 2', '  columns:', '    - a', '    - b',
        '  rows:', '    - values:', '        - type: INT64', '          value: "1"',
      ),
    ),
    'line 5: a row of 1 against 2 columns',
  )
  for (const [what, lines, want] of [
    [
      'a row that is not a values',
      ['- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - a', '  rows:', '    - 1'],
      'line 11: a row is a `values:` and the values under it',
    ],
    [
      'a row with a key nothing knows',
      ['- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - a', '  rows:', '    - value:'],
      'line 11: a row has no key "value"',
    ],
  ]) {
    assert.equal(refused(suite(...lines)), want, `${what} was refused with the wrong words`)
  }
})

// A statement runs on `main` unless the case says otherwise, which is
// every case but the handful about transactions. Those need a second
// connection, because a transaction is only observable from outside it.
test('a case runs on main unless it names a connection', () => {
  const plain = only(suite('- name: one', '  doc: d', '  query: RETURN 1', '  raises: 42601'))
  assert.equal(plain.on, MAIN)
  assert.deepEqual(plain.setup, [])

  const held = only(
    suite(
      '- name: one', '  doc: d', '  setup:', '    - CREATE NODE TABLE person (id INT64)',
      '    - on: other', '      query: INSERT (:person {id: 1})', '  on: other',
      '  query: RETURN 1', '  raises: 42601',
    ),
  )
  assert.equal(held.on, 'other')
  assert.deepEqual(held.setup, [
    { on: MAIN, query: 'CREATE NODE TABLE person (id INT64)' },
    { on: 'other', query: 'INSERT (:person {id: 1})' },
  ])
})

test('a setup statement is a line or a connection and a line', () => {
  for (const [what, lines, want] of [
    [
      'a mapping with no connection on it',
      ['- name: one', '  doc: d', '  setup:', '    - query: RETURN 1', '  query: RETURN 1', '  raises: 42601'],
      'line 8: a setup statement written as a mapping names the connection it runs on',
    ],
    [
      'a mapping with a key nothing knows',
      ['- name: one', '  doc: d', '  setup:', '    - on: other', '      qeury: RETURN 1', '  query: RETURN 1',
        '  raises: 42601'],
      'line 8: a setup statement has no key "qeury"',
    ],
    [
      'a setup that is not a sequence',
      ['- name: one', '  doc: d', '  setup: RETURN 1', '  query: RETURN 1', '  raises: 42601'],
      'line 5: `setup:` is a sequence of statements',
    ],
    [
      'a connection named the wrong way',
      ['- name: one', '  doc: d', '  on: Other', '  query: RETURN 1', '  raises: 42601'],
      'line 7: "Other" is a connection name, which is lower case words joined by dashes',
    ],
  ]) {
    assert.equal(refused(suite(...lines)), want, `${what} was refused with the wrong words`)
  }
})

// The other direction the encoding travels. A client that decodes a date
// correctly and encodes it a day early passes every case with no
// parameters in it, so the cases with parameters are the ones that catch
// it.
test('a parameter is a name and a value in the encoding', () => {
  const held = only(
    suite(
      '- name: one', '  doc: d', '  params:', '    - name: n', '      type: INT64', '      value: "1"',
      '    - name: s', '      type: STRING', '      value: text', '  query: RETURN $n', '  raises: 42601',
    ),
  )
  assert.deepEqual(held.params.map((one) => one.name), ['n', 's'])
  assert.ok(same(1n, held.params[0].value), `n came to ${show(held.params[0].value)}`)
  assert.ok(same('text', held.params[1].value))

  for (const [what, lines, want] of [
    [
      'a name a statement could not write',
      ['- name: one', '  doc: d', '  params:', '    - name: n one', '      type: INT64', '      value: "1"',
        '  query: RETURN $n', '  raises: 42601'],
      'line 8: "n one" is a parameter name, which is what a statement writes after the `$`',
    ],
    [
      'two parameters of one name',
      ['- name: one', '  doc: d', '  params:', '    - name: n', '      type: INT64', '      value: "1"',
        '    - name: n', '      type: INT64', '      value: "2"', '  query: RETURN $n', '  raises: 42601'],
      'line 11: two parameters are called "n"',
    ],
    [
      'a parameter with a key nothing knows',
      ['- name: one', '  doc: d', '  params:', '    - nmae: n', '      type: INT64', '      value: "1"',
        '  query: RETURN $n', '  raises: 42601'],
      'line 8: a parameter has no key "nmae"',
    ],
    [
      'a params that is not a sequence',
      ['- name: one', '  doc: d', '  params: n', '  query: RETURN $n', '  raises: 42601'],
      'line 7: `params:` is a sequence',
    ],
  ]) {
    assert.equal(refused(suite(...lines)), want, `${what} was refused with the wrong words`)
  }
})

// Everything else in the corpus is an expression, and an expression says
// what a value means on the way out and nothing about how it got in. A
// load is the other half.
test('a load is a table, its columns and the edges between its rows', () => {
  const held = read(
    HEAD +
      ['load:', '  nodes: person', '  edges: knows', '  count: 2', '  columns:', '    - name: id',
        '      type: INT64', '      values:', '        - "1"', '        - "2"', '    - name: tag',
        '      type: STRING', '      values:', '        - a', '        - b', '  pairs:', '    - from: 0',
        '      to: 1', 'cases:', '  - name: one', '    doc: d', '    query: RETURN 1',
        '    raises: 42601', ''].join('\n'),
  )
  const load = held.load
  assert.equal(load.nodes, 'person')
  assert.equal(load.edges, 'knows')
  assert.equal(load.count, 2)
  assert.deepEqual(load.columns.map((one) => [one.name, one.type]), [['id', 'INT64'], ['tag', 'STRING']])
  assert.ok(same([1n, 2n], load.columns[0].values))
  assert.ok(same(['a', 'b'], load.columns[1].values))
  assert.deepEqual(load.pairs, [[0, 1]])
})

test('a load that does not add up is refused where it is written', () => {
  const head = ['load:', '  nodes: person', '  edges: knows', '  count: 2']
  const tail = ['cases:', '  - name: one', '    doc: d', '    query: RETURN 1', '    raises: 42601']
  const file = (...lines) => `${HEAD}${[...head, ...lines, ...tail].join('\n')}\n`
  const column = ['  columns:', '    - name: id', '      type: INT64', '      values:', '        - "1"', '        - "2"']

  for (const [what, lines, want] of [
    [
      'a column with the wrong number of values',
      ['  columns:', '    - name: id', '      type: INT64', '      values:', '        - "1"'],
      'line 9: column "id" holds 1 values against the 2 rows the load declares',
    ],
    [
      'a type nothing knows',
      ['  columns:', '    - name: id', '      type: INTEGER', '      values:', '        - 1', '        - 2'],
      'line 9: INTEGER is not a type this encoding knows',
    ],
    ['no columns at all', [], 'line 5: a load has `columns:`'],
    [
      'two columns of one name',
      [...column, '    - name: id', '      type: STRING', '      values:', '        - a', '        - b'],
      'line 5: two columns are called "id"',
    ],
    [
      'an edge past the end of the table',
      [...column, '  pairs:', '    - from: 0', '      to: 2'],
      'line 15: `to: 2` against a table of 2 rows, which are numbered 0 to 1',
    ],
    [
      'an edge with one end',
      [...column, '  pairs:', '    - from: 0'],
      'line 15: an edge has a `to:` row number',
    ],
    [
      'an edge with a key nothing knows',
      [...column, '  pairs:', '    - form: 0', '      to: 1'],
      'line 15: an edge has no key "form"',
    ],
    [
      'a load with a key nothing knows',
      [...column, '  paris:', '    - from: 0'],
      'line 5: a load has no key "paris"',
    ],
  ]) {
    assert.equal(refused(file(...lines)), want, `${what} was refused with the wrong words`)
  }

  // A load of no rows is a load nothing can be read back from, which is a
  // suite whose every case would pass by returning nothing.
  assert.equal(
    refused(
      `${HEAD}${['load:', '  nodes: person', '  edges: knows', '  count: 0', ...column, ...tail].join('\n')}\n`,
    ),
    'line 5: a load of no rows is a load nothing can be read back from',
  )
  assert.equal(
    refused(`${HEAD}${['load:', '  nodes: person', '  edges: knows', ...column, ...tail].join('\n')}\n`),
    'line 5: a load says how many rows it has, with `count:`',
  )
  // A name a statement could not write, since the load goes in through a
  // table the cases then name in their statements.
  assert.equal(
    refused(
      `${HEAD}${['load:', '  nodes: a person', '  edges: knows', '  count: 2', ...column, ...tail].join('\n')}\n`,
    ),
    'line 5: "a person" is not a table name',
  )
})

// A case may say what the export gives as well as what the rows are, and
// the two are checked against one statement.
test('a case may say what its export gives', () => {
  const held = only(
    suite(
      '- name: one', '  doc: d', '  query: RETURN 1 AS n', '  columns:', '    - n', '  rows:',
      '  arrow:', '    - name: n', '      format: l',
    ),
  )
  assert.deepEqual(held.arrow, { refused: false, fields: [{ name: 'n', format: 'l', children: [] }] })

  // A result Arrow has no type for, which is a contract of its own and
  // not a case that has nothing to say.
  const no = only(suite('- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - n', '  rows:',
    '  arrow: refused'))
  assert.deepEqual(no.arrow, { refused: true, fields: [] })

  // A list names the field under it, rather than leaving it implied, so
  // that a client naming it something else is a case that fails.
  const nested = only(
    suite(
      '- name: one', '  doc: d', '  query: RETURN [1] AS l', '  columns:', '    - l', '  rows:',
      '  arrow:', '    - name: l', '      format: +l', '      children:', '        - name: item',
      '          format: l',
    ),
  )
  assert.deepEqual(nested.arrow.fields[0].children, [{ name: 'item', format: 'l', children: [] }])

  for (const [what, lines, want] of [
    [
      'a nested type with nothing under it',
      ['- name: one', '  doc: d', '  query: RETURN [1] AS l', '  columns:', '    - l', '  rows:',
        '  arrow:', '    - name: l', '      format: +l'],
      'line 12: "+l" is a nested type and the fields under it are part of it',
    ],
    [
      'a flat type with fields under it',
      ['- name: one', '  doc: d', '  query: RETURN 1 AS n', '  columns:', '    - n', '  rows:',
        '  arrow:', '    - name: n', '      format: l', '      children:', '        - name: item',
        '          format: l'],
      'line 12: "l" holds no fields, so nothing goes under it',
    ],
    [
      'a word that is not refused',
      ['- name: one', '  doc: d', '  query: RETURN 1', '  columns:', '    - n', '  rows:', '  arrow: no'],
      'line 11: `arrow:` is the columns the export gives, or `refused` for a result Arrow has no ' +
        'type for, and this is "no"',
    ],
    [
      'a field with no format',
      ['- name: one', '  doc: d', '  query: RETURN 1 AS n', '  columns:', '    - n', '  rows:',
        '  arrow:', '    - name: n'],
      'line 12: an Arrow field has a `format:`',
    ],
    [
      'a field with a key nothing knows',
      ['- name: one', '  doc: d', '  query: RETURN 1 AS n', '  columns:', '    - n', '  rows:',
        '  arrow:', '    - name: n', '      fromat: l'],
      'line 12: an Arrow field has no key "fromat"',
    ],
  ]) {
    assert.equal(refused(suite(...lines)), want, `${what} was refused with the wrong words`)
  }
})

// A directory of files, which is what the runner is handed. The file name
// and the suite name have to agree, because a report cites the suite and
// somebody looking for it opens the file.
test('a directory reads in a fixed order and the names have to agree', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-cases-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const one = (name) =>
    `schema: ${SCHEMA}\nsuite: ${name}\ndoc: d\ncases:\n  - name: one\n    doc: d\n    query: RETURN 1\n` +
    '    raises: 42601\n'

  await writeFile(join(dir, 'beta.yaml'), one('beta'))
  await writeFile(join(dir, 'alpha.yaml'), one('alpha'))
  // Not a case file, and not an error either, since a directory of cases
  // has a README in it.
  await writeFile(join(dir, 'README.md'), 'not a suite\n')

  const suites = await readDir(dir)
  assert.deepEqual(suites.map((held) => held.name), ['alpha', 'beta'])

  await writeFile(join(dir, 'gamma.yaml'), one('delta'))
  await assert.rejects(readDir(dir), (err) => {
    assert.ok(err instanceof CorpusError)
    assert.equal(err.message, `${join(dir, 'gamma.yaml')}: the suite calls itself "delta" and the file calls it "gamma"`)
    return true
  })
})

test('a directory with no case files in it is refused', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-cases-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(readDir(dir), (err) => {
    assert.equal(err.message, `${dir}: no case files`)
    return true
  })
  const missing = join(dir, 'nowhere')
  await assert.rejects(readDir(missing), (err) => {
    assert.ok(err instanceof CorpusError)
    assert.ok(err.message.startsWith(`${missing}: `), err.message)
    return true
  })
})

// A refusal inside a file carries the file with it, since a report of
// twenty five suites that says "line 4" and nothing else is one nobody
// can act on.
test('a refusal inside a file says which file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zu-cases-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'broken.yaml')
  await writeFile(path, `schema: ${SCHEMA}\nsuite: broken\ndoc: d\ncases:\n  - name: One\n    doc: d\n    query: RETURN 1\n    raises: 42601\n`)
  await assert.rejects(readDir(dir), (err) => {
    assert.equal(
      err.message,
      `${path}: line 5: "One" is a case name, which is lower case words joined by dashes`,
    )
    return true
  })
})
