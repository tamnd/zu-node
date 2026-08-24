// The corpus reader, tested against the subset it claims to read and
// against the constructs it claims to refuse.
//
// Both halves matter and the second one is the reason this file is long.
// A reader that accepts everything the corpus writes is half a reader:
// the other half is that a case using a block scalar, an anchor or a
// flow sequence is refused with a line number rather than read as
// something the author did not write. Five implementations of this
// subset exist and a construct one of them quietly accepts is a case
// that passes in one repository and fails in four.
//
// The refusal messages are checked in full rather than by substring,
// because they are diffed against the reference runner's and a wording
// that drifted would be a difference in the report that is not a
// difference in the answer.

import assert from 'node:assert/strict'
import test from 'node:test'

import { CorpusError, EMPTY, parse, quote } from '../conformance/reader.mjs'

// The message a document was refused with, and a failure when it was not
// refused at all.
function refused(text) {
  try {
    const node = parse(text)
    assert.fail(`parse read this as ${node.what()}, and it should have been refused`)
  } catch (err) {
    assert.ok(err instanceof CorpusError, `parse gave a ${err.name}, and everything here is a CorpusError`)
    return err.message
  }
}

test('a mapping keeps its keys in the order they were written', () => {
  const doc = parse('suite: string\ndoc: what a string does\nschema: 4\n')
  const pairs = doc.map()
  assert.ok(pairs !== null, `the document is ${doc.what()}, and it should be a mapping`)
  assert.deepEqual(pairs.map((pair) => pair.key), ['suite', 'doc', 'schema'])
  assert.equal(doc.get('doc').str(), 'what a string does')
  assert.equal(doc.get('load'), null, 'get answered a key that is not in the mapping')
})

test('a sequence of mappings is one node per item', () => {
  const items = parse(
    ['cases:', '  - name: one', '    query: RETURN 1', '  - name: two', '    query: RETURN 2', ''].join('\n'),
  )
    .get('cases')
    .seq()
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.get('name').str()), ['one', 'two'])
  // The line a refusal would cite is the line the item opened on and not
  // the line the sequence did, which is the whole reason a node carries
  // one.
  assert.equal(items[1].line, 4)
})

// A `- ` and the key it opens are one line in the file and two lines by
// the time the parser sees them, and the split is what lets an item
// written on one line and an item written under its dash be the same
// shape. Both spellings are in the corpus.
test('a dash and its first key may share a line', () => {
  const together = parse('cases:\n  - name: one\n    query: RETURN 1\n')
  const apart = parse('cases:\n  -\n    name: one\n    query: RETURN 1\n')
  for (const doc of [together, apart]) {
    const items = doc.get('cases').seq()
    assert.equal(items.length, 1)
    assert.equal(items[0].get('name').str(), 'one')
  }
})

test('a scalar remembers whether it was quoted', () => {
  const doc = parse('bare: 42\nsingle: \'42\'\ndouble: "42"\n')
  for (const [key, quoted] of [
    ['bare', false],
    ['single', true],
    ['double', true],
  ]) {
    const held = doc.get(key).scalar()
    assert.ok(held !== null, `${key} is ${doc.get(key).what()}`)
    assert.equal(held.text, '42')
    assert.equal(held.quoted, quoted, `${key} came back the other way round`)
  }
})

test('a single quoted run escapes only by doubling the quote', () => {
  const doc = parse("query: 'RETURN ''it''''s'' AS s'\n")
  const held = doc.get('query').scalar()
  assert.equal(held.quoted, true)
  assert.equal(held.text, "RETURN 'it''s' AS s")
  // A backslash inside a single quoted run is a backslash, which is what
  // lets a case write a regular expression without doubling every one of
  // them.
  assert.equal(parse("query: 'a\\nb'\n").get('query').str(), 'a\\nb')
})

test('a double quoted run takes the escapes the corpus uses', () => {
  const doc = parse('text: "a\\nb\\tc\\\\d\\"e\\r\\0f\\bg"\n')
  assert.equal(doc.get('text').str(), 'a\nb\tc\\d"e\r\x00f\bg')
})

// A comment is dropped, and the three rules that keep the dropping from
// eating content are each worth a line: a # inside a word is part of the
// word, a quote inside a word is part of the word, and a quote that
// opens nothing that closes was not a run.
test('a comment goes and a hash inside a value stays', () => {
  for (const [text, key, want] of [
    ['a: 1 # why\n', 'a', '1'],
    ['# whole line\nb: 2\n', 'b', '2'],
    ['c: person#1\n', 'c', 'person#1'],
    ["d: 'a # b'\n", 'd', 'a # b'],
    ["e: it's a plain scalar # and a comment\n", 'e', "it's a plain scalar"],
    ["f: cast('  42  ' AS INT64)\n", 'f', "cast('  42  ' AS INT64)"],
    ["g: RETURN 'a' AS a # a comment after a run that closed\n", 'g', "RETURN 'a' AS a"],
  ]) {
    assert.equal(parse(text).get(key).str(), want, `${quote(text)} read wrongly`)
  }
})

// A key with nothing under it is a node rather than an error, because a
// case that expects no rows writes `rows:` and stops. Every accessor
// says no to it, so a `name:` somebody left blank is still caught.
test('a key with nothing under it is an empty node', () => {
  const doc = parse('rows:\nname: after\n')
  const empty = doc.get('rows')
  assert.equal(empty.kind, EMPTY)
  assert.equal(empty.what(), 'nothing')
  assert.equal(empty.str(), null)
  assert.equal(empty.seq(), null)
  assert.equal(empty.map(), null)
  assert.deepEqual(empty.seqOrEmpty(), [])
  // The key after it is still read, so an empty value ends at its own
  // line rather than swallowing what follows.
  assert.equal(doc.get('name').str(), 'after')
})

test('unknown names the keys that are not expected', () => {
  const doc = parse('name: one\nquery: RETURN 1\nqeury: RETURN 2\nrows:\n')
  assert.deepEqual(doc.unknown('name', 'query', 'rows'), ['qeury'])
  assert.deepEqual(doc.unknown('name', 'query', 'qeury', 'rows'), [])
  // A scalar has no keys and is not a mapping, so it has no unknown ones
  // either rather than being an error at this level.
  assert.deepEqual(parse('just a scalar\n').unknown('name'), [])
})

test('what says which shape a node is', () => {
  for (const [text, want] of [
    ['a plain scalar\n', 'a scalar'],
    ['- one\n- two\n', 'a sequence'],
    ['key: value\n', 'a mapping'],
  ]) {
    assert.equal(parse(text).what(), want)
  }
})

// The constructs this reader will not read. Every one of them is real
// YAML that a general reader would take, and every one of them would
// mean a case says one thing to a reviewer and another to the runner.
test('the constructs this reader does not read', () => {
  for (const [what, text, want] of [
    ['a tab', 'cases:\n\t- name: one\n', 'line 2: a tab at column 1, and indentation here is spaces'],
    ['a document marker', '---\nschema: 4\n', 'line 1: "---" opens or closes a document, and a file here holds one'],
    ['a document terminator', 'schema: 4\n...\n', 'line 2: "..." opens or closes a document, and a file here holds one'],
    ['an odd indent', 'cases:\n   - name: one\n', 'line 2: indented 3, and indentation here goes two spaces at a time'],
    [
      'a dash with two spaces after it',
      'cases:\n  -  name: one\n',
      'line 2: a `- ` takes exactly one space, so that what follows it lines up with the lines under it',
    ],
    [
      'a sequence opening into a sequence',
      'cases:\n  - - one\n',
      'line 2: a sequence opening straight into another one, which nothing here needs',
    ],
    ['a dash with nothing after it', 'cases:\n  -\n', 'line 2: a `-` with nothing after it'],
    [
      'a flow sequence',
      'columns: [a, b]\n',
      "line 1: a plain scalar opening with '[', which is a construct this reader does not read",
    ],
    [
      'a flow mapping',
      'value: {type: INT64}\n',
      "line 1: a plain scalar opening with '{', which is a construct this reader does not read",
    ],
    [
      'an anchor',
      'row: &base one\n',
      "line 1: a plain scalar opening with '&', which is a construct this reader does not read",
    ],
    [
      'an alias',
      'row: *base\n',
      "line 1: a plain scalar opening with '*', which is a construct this reader does not read",
    ],
    [
      'a tag',
      'count: !!int 4\n',
      "line 1: a plain scalar opening with '!', which is a construct this reader does not read",
    ],
    [
      'a literal block scalar',
      'doc: |\n  one\n',
      "line 1: a plain scalar opening with '|', which is a construct this reader does not read",
    ],
    [
      'a folded block scalar',
      'doc: >\n  one\n',
      "line 1: a plain scalar opening with '>', which is a construct this reader does not read",
    ],
    [
      'a directive',
      'query: %YAML 1.2\n',
      "line 1: a plain scalar opening with '%', which is a construct this reader does not read",
    ],
    ['a run that does not close', 'query: "RETURN 1\n', 'line 1: a " that opens and does not close on its line'],
    ['two runs on one line', 'query: "a" and "b"\n', 'line 1: " and \\"b\\"" after the scalar ends'],
    // The backslash escapes the quote that would have closed the run, so
    // this is reported as a run left open rather than as a scalar ending
    // in a backslash. Both messages are in the reader and this is the one
    // that is reachable, since a backslash before the closing quote
    // always takes the quote with it.
    [
      'a double quoted run whose last character escapes its quote',
      'query: "a\\"\n',
      'line 1: a " that opens and does not close on its line',
    ],
    ['an escape this reader has no rule for', 'query: "a\\x41b"\n', 'line 1: \\x is not an escape'],
    ['a key set twice', 'name: one\nname: two\n', 'line 2: name is set twice in one mapping'],
    [
      'an indent under a key that is not two',
      'load:\n    nodes: person\n',
      'line 2: indented 4, where what is under `load:` on line 1 is indented 2',
    ],
    [
      'an indent under a dash that is not two',
      'cases:\n  -\n      name: one\n',
      'line 3: indented 6, where an item of the sequence on line 2 is indented 4',
    ],
    ['a first line that is indented', '  schema: 4\n', 'line 1: the first line is indented'],
    ['a file with nothing in it', '# only a comment\n\n', 'the file has nothing in it'],
    ['a line belonging to nothing above it', 'just a scalar\nand another\n', 'line 2: this belongs to nothing above it'],
  ]) {
    assert.equal(refused(text), want, `${what} was refused with the wrong words`)
  }
})

// quote is Rust's {:?} and not JSON, because a refusal written in five
// languages and diffed across them cannot have one of them escaping a
// code point the others print.
test('quote writes a string the way the other runners do', () => {
  for (const [text, want] of [
    ['plain', '"plain"'],
    ['a "quoted" word', '"a \\"quoted\\" word"'],
    ['a\\backslash', '"a\\\\backslash"'],
    ['a\nb', '"a\\nb"'],
    ['a\rb', '"a\\rb"'],
    ['a\tb', '"a\\tb"'],
    // The one JSON.stringify would escape and Rust would not.
    ['héllo → 世界', '"héllo → 世界"'],
    ['', '""'],
  ]) {
    assert.equal(quote(text), want)
  }
})
