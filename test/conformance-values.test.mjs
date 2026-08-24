// The corpus value encoding, tested on both sides of it.
//
// A case says what a statement produces by naming a type and a payload,
// and the whole point of naming the type is that a payload cannot be
// misread. So the tests here are mostly refusals: an INT64 written bare
// is refused because some reader will round it, a STRING written where a
// LIST belongs is refused, a payload out of its type's range is refused.
// A round trip through a reader that accepted all three would still look
// green.
//
// The other half is `show`, which is what a failure report prints. It is
// diffed against the Rust runner's line for line, so a float that
// switches to an exponent one power earlier here than there is a
// difference in the report that is not a difference in the answer.

import assert from 'node:assert/strict'
import test from 'node:test'

import { ZuDate, ZuDuration, ZuTime, ZuTimestamp } from 'zudb'

import { parse, quote } from '../conformance/reader.mjs'
import {
  EdgeAt,
  NodeAt,
  Walk,
  cell,
  decode,
  form,
  same,
  show,
  showFloat,
} from '../conformance/values.mjs'

// The value a `type:`/`value:` mapping comes to, written the way a case
// writes it.
function value(text) {
  return decode(parse(text))
}

// The message a `type:`/`value:` mapping was refused with, and a failure
// when it was read instead.
function declined(text) {
  let node
  try {
    node = parse(text)
  } catch (err) {
    return err.message
  }
  try {
    const got = decode(node)
    assert.fail(`decode read this as ${show(got)}, and it should have been refused`)
  } catch (err) {
    return err.message
  }
}

test('every type says whether its payload is quoted', () => {
  // The whole table, written out rather than iterated over, because the
  // point of the test is that the table is this and not whatever the map
  // happens to hold.
  const bare = ['NULL', 'BOOL', 'INT8', 'INT16', 'INT32', 'UINT8', 'UINT16', 'UINT32', 'STRING', 'LIST', 'PATH']
  const quotedTypes = ['INT64', 'UINT64', 'FLOAT32', 'FLOAT64', 'BYTES', 'DATE', 'LOCALTIME', 'ZONEDTIME',
    'LOCALDATETIME', 'ZONEDDATETIME', 'DURATION', 'NODE', 'EDGE']
  for (const type of bare) assert.deepEqual(form(type), { quoted: false, known: true }, type)
  for (const type of quotedTypes) assert.deepEqual(form(type), { quoted: true, known: true }, type)
  // DECIMAL has a name and no value behind it, and is told apart from a
  // typo so that the message says which of the two happened.
  assert.equal(form('DECIMAL').known, false, 'DECIMAL is a type, and the engine has no value for one')
})

test('a payload is read as the type beside it', () => {
  for (const [text, want] of [
    ['type: NULL\n', null],
    ['type: BOOL\nvalue: true\n', true],
    ['type: BOOL\nvalue: false\n', false],
    ['type: INT8\nvalue: -128\n', -128n],
    ['type: INT16\nvalue: 32767\n', 32767n],
    ['type: INT32\nvalue: -2147483648\n', -2147483648n],
    ['type: INT64\nvalue: "9223372036854775807"\n', 9223372036854775807n],
    ['type: UINT8\nvalue: 255\n', 255n],
    ['type: UINT16\nvalue: 65535\n', 65535n],
    ['type: UINT32\nvalue: 4294967295\n', 4294967295n],
    ['type: UINT64\nvalue: "0"\n', 0n],
    ['type: FLOAT64\nvalue: "1.5"\n', 1.5],
    ['type: FLOAT64\nvalue: "-0.0"\n', -0],
    ['type: FLOAT64\nvalue: "inf"\n', Number.POSITIVE_INFINITY],
    ['type: FLOAT64\nvalue: "-inf"\n', Number.NEGATIVE_INFINITY],
    // A FLOAT32 is held as the double the single rounds to, since that is
    // what comes back out of a column of them.
    ['type: FLOAT32\nvalue: "0.1"\n', Math.fround(0.1)],
    ['type: STRING\nvalue: plain\n', 'plain'],
    ["type: STRING\nvalue: ''\n", ''],
    ['type: BYTES\nvalue: "00AB00"\n', new Uint8Array([0, 0xab, 0])],
    ['type: BYTES\nvalue: ""\n', new Uint8Array()],
    ['type: NODE\nvalue: "person#1"\n', new NodeAt('person', 1n)],
    ['type: EDGE\nvalue: "knows#0->2"\n', new EdgeAt('knows', 0n, 2n)],
  ]) {
    const got = value(text)
    assert.ok(same(want, got), `${quote(text)} came to ${show(got)}, and it should be ${show(want)}`)
  }
})

// A STRING is the one type that reads either way, because a string is
// what a plain scalar already is and a case quotes one only when it has
// to. Everything else is written one way and refused the other.
test('a string reads quoted or bare', () => {
  assert.equal(value('type: STRING\nvalue: 42\n'), '42')
  assert.equal(value('type: STRING\nvalue: "42"\n'), '42')
})

test('an integer is refused outside the range its type holds', () => {
  for (const [type, text] of [
    ['INT8', '128'],
    ['INT8', '-129'],
    ['INT16', '32768'],
    ['INT32', '2147483648'],
    ['UINT8', '256'],
    ['UINT8', '-1'],
    ['UINT16', '65536'],
    ['UINT32', '4294967296'],
  ]) {
    assert.equal(declined(`type: ${type}\nvalue: ${text}\n`), `line 2: ${quote(text)} is not a ${type}`)
  }
  // UINT64 stops at the signed maximum, because the engine's integer is
  // signed and wrapping the top half into a negative would be a case that
  // passes while meaning the opposite of what it says.
  assert.equal(
    declined('type: UINT64\nvalue: "9223372036854775808"\n'),
    'line 2: "9223372036854775808" is not a UINT64',
  )
})

// The rule the whole encoding exists for. A bare INT64 is a number some
// reader in some language rounds, and a bare NODE is a name and two
// numbers no reader has a scalar for, so the two are told apart.
test('a quoted type written bare is refused and says why', () => {
  for (const [text, want] of [
    [
      'type: INT64\nvalue: 1\n',
      'line 2: INT64 is written in quotes, because a bare 1 is a number and some reader of this file will round it',
    ],
    [
      'type: FLOAT64\nvalue: 1.5\n',
      'line 2: FLOAT64 is written in quotes, because a bare 1.5 is a number and some reader of this file will round it',
    ],
    [
      'type: NODE\nvalue: person#1\n',
      'line 2: NODE is written in quotes, because person#1 is a name and two numbers and no reader has a scalar for that',
    ],
    [
      'type: EDGE\nvalue: knows#0->1\n',
      'line 2: EDGE is written in quotes, because knows#0->1 is a name and two numbers and no reader has a scalar for that',
    ],
  ]) {
    assert.equal(declined(text), want)
  }
})

test('a bare type written in quotes is refused', () => {
  assert.equal(
    declined('type: INT8\nvalue: "1"\n'),
    'line 2: INT8 is written without quotes, so that a reader cannot take it for a string',
  )
})

test('a value says what is wrong with it in the order that helps', () => {
  for (const [what, text, want] of [
    ['a type nothing knows', 'type: INTEGER\nvalue: 1\n', 'line 1: INTEGER is not a type this encoding knows'],
    [
      'a type the encoding holds a name for',
      'type: DECIMAL\nvalue: "1.0"\n',
      'line 1: DECIMAL is a type the encoding reserves and the engine has no value for',
    ],
    // The type is the mistake and the missing payload is a consequence of
    // it, so the type is what the message names.
    ['a type nothing knows and no payload either', 'type: INTEGER\n', 'line 1: INTEGER is not a type this encoding knows'],
    ['no type at all', 'value: 1\n', 'line 1: a value with no `type`'],
    ['a type that is not a name', 'type:\n  - INT8\nvalue: 1\n', 'line 1: a `type` that is not a name'],
    ['no payload', 'type: INT8\n', 'line 1: a INT8 with no `value`'],
    ['a payload under NULL', 'type: NULL\nvalue: 1\n', 'line 1: NULL carries no `value`'],
    ['a key the encoding has no room for', 'type: INT8\nvalue: 1\nname: n\n', 'line 1: a value has no key "name"'],
    [
      'a sequence where a value belongs',
      '- type: INT8\n',
      'line 1: a value is a mapping of `type` and `value`, and this is a sequence',
    ],
    [
      'a scalar where a value belongs',
      'just a scalar\n',
      'line 1: a value is a mapping of `type` and `value`, and this is a scalar',
    ],
    ['a sequence under a scalar type', 'type: INT8\nvalue:\n  - 1\n', 'line 3: a INT8 holds one scalar, and this is a sequence'],
    ['a scalar under LIST', 'type: LIST\nvalue: 1\n', 'line 2: a LIST holds a sequence of values, and this is a scalar'],
  ]) {
    assert.equal(declined(text), want, `${what} was refused with the wrong words`)
  }
})

test('a list holds values and the empty one has a spelling', () => {
  const got = value(
    ['type: LIST', 'value:', '  - type: INT8', '    value: 1', '  - type: NULL', '  - type: STRING', '    value: two', ''].join('\n'),
  )
  assert.ok(same([1n, null, 'two'], got), `read ${show(got)}`)
  // A `value:` with nothing under it, which is the empty list and a value
  // a case asserts.
  assert.ok(same([], value('type: LIST\nvalue:\n')))
})

// A path alternates and ends at both ends with a node, so a sequence that
// does not is refused where it is written rather than at the comparison,
// which is the difference between a message naming a line and a report
// saying the row differs.
test('a path alternates node and edge or is refused', () => {
  const oneHop = value(
    [
      'type: PATH',
      'value:',
      '  - type: NODE',
      '    value: "person#0"',
      '  - type: EDGE',
      '    value: "knows#0->1"',
      '  - type: NODE',
      '    value: "person#1"',
      '',
    ].join('\n'),
  )
  assert.ok(oneHop instanceof Walk, `a one hop path read as ${show(oneHop)}`)
  assert.equal(oneHop.elements.length, 3)

  for (const [what, text, want] of [
    [
      'an even number of values',
      'type: PATH\nvalue:\n  - type: NODE\n    value: "person#0"\n  - type: EDGE\n    value: "knows#0->1"\n',
      'line 3: a PATH is a node, then an edge and a node for each hop, so it holds an odd number of values and this holds 2',
    ],
    [
      'an edge where the walk starts',
      'type: PATH\nvalue:\n  - type: EDGE\n    value: "knows#0->1"\n',
      'line 3: a PATH alternates, so value 1 is an EDGE where it should be a NODE',
    ],
    [
      'a node in the hop position',
      'type: PATH\nvalue:\n  - type: NODE\n    value: "person#0"\n  - type: NODE\n    value: "person#1"\n' +
        '  - type: NODE\n    value: "person#2"\n',
      'line 3: a PATH alternates, so value 2 is a NODE where it should be an EDGE',
    ],
    [
      'something that is neither',
      'type: PATH\nvalue:\n  - type: INT8\n    value: 1\n',
      'line 3: a PATH alternates, so value 1 is neither a NODE nor an EDGE where it should be a NODE',
    ],
  ]) {
    assert.equal(declined(text), want, `${what} was refused with the wrong words`)
  }
  // The empty path is refused too, since zero is an even number and a walk
  // with no nodes in it is not a walk.
  assert.match(declined('type: PATH\nvalue:\n'), /odd number/)
})

test('a node and an edge are a table name and row numbers', () => {
  // Split from the right, so a table whose name holds a # still reads.
  assert.ok(same(new NodeAt('od#d', 7n), value('type: NODE\nvalue: "od#d#7"\n')))
  for (const text of [
    'person', // no offset
    '#1', // no table
    'person#', // no digits
    'person#-1', // a sign, which BigInt would take
    'person#1_0', // an underscore, which BigInt would take too
    'person#a', // not a number
    'person#1->2', // an edge under a node's type
  ]) {
    assert.equal(declined(`type: NODE\nvalue: ${quote(text)}\n`), `line 2: ${quote(text)} is not a NODE`)
  }
  for (const text of [
    'knows#0', // one row rather than two
    'knows#0->', // no second row
    'knows#->1', // no first row
    'knows#0-1', // the wrong arrow
    '#0->1', // no table
    'knows#0->-1', // a sign
  ]) {
    assert.equal(declined(`type: EDGE\nvalue: ${quote(text)}\n`), `line 2: ${quote(text)} is not a EDGE`)
  }
})

// An integer is written back out and compared, so that a spelling BigInt
// would take and no other reader would is refused.
test('an integer is refused when it is spelt unusually', () => {
  for (const text of ['+1', '01', '1_0', '0x10']) {
    assert.equal(declined(`type: INT8\nvalue: ${text}\n`), `line 2: ${quote(text)} is not a INT8`)
  }
  // Space around a bare payload never reaches here, because the reader
  // takes it off along with the space after the colon. This is asserted
  // rather than left implied, since it is the reason the list above has no
  // padded spelling in it.
  assert.ok(same(1n, value('type: INT8\nvalue:   1  \n')))
})

// A float is exact here: `1` is an integer somebody meant to write as
// `1.0`, and `1e400` is `inf` under another name. `Number` takes four
// more spellings the other runners do not.
test('a float is refused when it is spelt unusually', () => {
  for (const text of ['1', '-1', '1e400', '-1e400', 'Inf', 'infinity', 'nan', '0x1p-2', '1_0.0', '1.0f', '']) {
    assert.equal(declined(`type: FLOAT64\nvalue: ${quote(text)}\n`), `line 2: ${quote(text)} is not a FLOAT64`)
  }
  for (const text of ['1.0', '-1.5', '1e10', '1E10', '1.5e-3', 'NaN', 'inf', '-inf']) {
    assert.equal(typeof value(`type: FLOAT64\nvalue: ${quote(text)}\n`), 'number', text)
  }
})

// Space anywhere in a byte string is dropped, which is what the
// standard's production allows and what lets a long literal be written in
// groups. Half a byte is refused.
test('a byte string is hexits in either case and space is dropped', () => {
  for (const [text, want] of [
    ['00AB00', new Uint8Array([0, 0xab, 0])],
    ['00ab00', new Uint8Array([0, 0xab, 0])],
    ['00 AB 00', new Uint8Array([0, 0xab, 0])],
    ['', new Uint8Array()],
    ['FF', new Uint8Array([0xff])],
  ]) {
    const got = value(`type: BYTES\nvalue: ${quote(text)}\n`)
    assert.ok(same(want, got), `BYTES ${quote(text)} read as ${show(got)}`)
  }
  for (const text of ['0', 'ABC', 'GG', '0x41', '00-AB']) {
    assert.equal(declined(`type: BYTES\nvalue: ${quote(text)}\n`), `line 2: ${quote(text)} is not a BYTES`)
  }
})

// Not ===, for three reasons: a float, because NaN is not equal to itself
// and -0 is equal to 0; the shapes that hold other values; and every
// temporal value, which is a class holding its count behind a getter.
test('same is equality except where equality is wrong', () => {
  for (const [what, want, got, is] of [
    ['NaN against itself', Number.NaN, Number.NaN, true],
    ['a negative zero against a positive one', -0, 0, false],
    ['a positive zero against a negative one', 0, -0, false],
    ['two ones', 1.0, 1.0, true],
    ['an integer against a float', 1n, 1.0, false],
    ['a float against an integer', 1.0, 1n, false],
    ['a boolean against an integer', true, 1n, false],
    ['nothing against nothing', null, null, true],
    ['nothing against a value', null, 0n, false],
    ['two lists', [1n, null], [1n, null], true],
    ['lists of different lengths', [1n], [1n, null], false],
    ['a list against a scalar', [1n], 1n, false],
    ['a scalar against a list', 1n, [1n], false],
    ['nested lists', [[1.0]], [[1.0]], true],
    ['two walks', new Walk([new NodeAt('p', 0n)]), new Walk([new NodeAt('p', 0n)]), true],
    ['a walk against a list', new Walk([new NodeAt('p', 0n)]), [new NodeAt('p', 0n)], false],
    ['two records', { a: 1n }, { a: 1n }, true],
    ['records of different sizes', { a: 1n }, { a: 1n, b: null }, false],
    ['records with different names', { a: 1n }, { b: 1n }, false],
    ['a record against a scalar', { a: 1n }, 1n, false],
    ['a scalar against a record', 1n, { a: 1n }, false],
    ['two byte strings', new Uint8Array([1, 2]), new Uint8Array([1, 2]), true],
    ['byte strings that differ', new Uint8Array([1, 2]), new Uint8Array([1, 3]), false],
    ['a byte string against a string', new Uint8Array([65]), 'A', false],
    ['a string against a byte string', 'A', new Uint8Array([65]), false],
    ['two dates', new ZuDate(1), new ZuDate(1), true],
    ['dates that differ', new ZuDate(1), new ZuDate(2), false],
    ['a local time against a zoned one', new ZuTime(0n), new ZuTime(0n, 0), false],
    ['a year month against a day time', ZuDuration.ofMonths(0n), ZuDuration.ofNanos(0n), false],
  ]) {
    assert.equal(same(want, got), is, `${what} came out the other way round`)
  }
})

// A value the runner did not put through `cell` prints as itself, under a
// name that is not a type, so a report carrying one cannot be mistaken
// for a case that could be pasted back in.
class Unconverted {
  constructor() {
    this.offset = 1n
  }
}

// `show` is what a failure report prints, in the encoding's own spelling
// so that a line can be pasted back into a case.
test('show writes a value the way a case would spell it', () => {
  for (const [held, want] of [
    [null, 'NULL'],
    [true, 'BOOL true'],
    [false, 'BOOL false'],
    [-7n, 'INT64 "-7"'],
    [1.5, 'FLOAT64 "1.5"'],
    ['a string', 'STRING "a string"'],
    ['with "quotes"', 'STRING "with \\"quotes\\""'],
    [new Uint8Array([0, 0xab]), 'BYTES "00AB"'],
    [new Uint8Array(), 'BYTES ""'],
    [new ZuDate(0), 'DATE "1970-01-01"'],
    [new ZuTime(0n), 'LOCALTIME "00:00:00"'],
    [new ZuTime(123456789n), 'LOCALTIME "00:00:00.123456789"'],
    [new ZuTime(0n, 0), 'ZONEDTIME "00:00:00Z"'],
    [new ZuTimestamp(0n), 'LOCALDATETIME "1970-01-01T00:00:00"'],
    // The instant is UTC and the offset is what the case wrote, so the
    // clock printed beside it is the instant moved into that zone, which
    // is the wall clock the case reads back.
    [new ZuTimestamp(0n, 60), 'ZONEDDATETIME "1970-01-01T01:00:00+01:00"'],
    [ZuDuration.ofMonths(14n), 'DURATION "P1Y2M"'],
    [ZuDuration.ofNanos(0n), 'DURATION "PT0S"'],
    [[1n, null], 'LIST [INT64 "1", NULL]'],
    [[], 'LIST []'],
    [
      new Walk([new NodeAt('person', 0n), new EdgeAt('knows', 0n, 1n), new NodeAt('person', 1n)]),
      'PATH [NODE "person#0", EDGE "knows#0->1", NODE "person#1"]',
    ],
    [new NodeAt('person', 3n), 'NODE "person#3"'],
    [new EdgeAt('knows', 3n, 4n), 'EDGE "knows#3->4"'],
    [{ b: 2n, a: null }, 'RECORD {a: NULL, b: INT64 "2"}'],
    [{}, 'RECORD {}'],
    [new Unconverted(), '(Unconverted) {"offset":"1"}'],
  ]) {
    assert.equal(show(held), want)
  }
  // A record's names are sorted, because a failure that reorders its own
  // fields between an engine and a case is a failure nobody can diff.
  assert.equal(show({ z: null, a: null, m: null }), 'RECORD {a: NULL, m: NULL, z: NULL}')
})

// A float is printed the way Rust's {:?} writes one: the shortest text
// that reads back as the same double, always with a point or an exponent,
// switching to an exponent where Rust switches and writing the exponent
// bare rather than with a sign and a padding zero.
test('a float prints the way the reference runner prints it', () => {
  for (const [held, want] of [
    [0, '0.0'],
    [-0, '-0.0'],
    [1, '1.0'],
    [-1, '-1.0'],
    [1.5, '1.5'],
    [0.1, '0.1'],
    [1 / 3, '0.3333333333333333'],
    [100, '100.0'],
    [1e15, '1000000000000000.0'],
    // At ten to the sixteenth the digits go behind an exponent, which is
    // where Rust switches and not where `toString` does.
    [1e16, '1e16'],
    [1e17, '1e17'],
    [1.5e17, '1.5e17'],
    [0.001, '0.001'],
    [0.0001, '0.0001'],
    // And below a ten thousandth, likewise.
    [0.00001, '1e-5'],
    [1.5e-5, '1.5e-5'],
    [Number.MAX_VALUE, '1.7976931348623157e308'],
    [Number.MIN_VALUE, '5e-324'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'inf'],
    [Number.NEGATIVE_INFINITY, '-inf'],
  ]) {
    assert.equal(showFloat(held), want, `${held} printed wrongly`)
  }
})

// Everything a table holds is spelled the same on both sides and comes
// through untouched, which is what this half asserts. The graph values,
// which are the ones `cell` exists for, need an engine to make one, so
// they are checked in the live test below.
test('cell leaves everything that is not a graph value alone', () => {
  for (const held of [1n, null, 'text', 1.5, true, new Uint8Array([1]), new ZuDate(3)]) {
    assert.ok(same(held, cell(held)), `${show(held)} did not come through`)
  }
  assert.ok(same([1n, [2n]], cell([1n, [2n]])))
  assert.ok(same({ a: [1n] }, cell({ a: [1n] })))
})
