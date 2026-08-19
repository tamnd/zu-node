// What a statement would do, and what it did.
//
// A plan is the engine's and this client only carries it, so what these
// assert is that the carrying is faithful: every operator, in the shape
// the tree had, with the fields that mean something and null where the
// engine had nothing to say. The listing is asserted against the tree it
// was rendered from rather than against a string written here, because a
// test that pins the exact words would fail every time the optimizer
// learns to print one better.

import assert from 'node:assert/strict'
import test from 'node:test'

import { connect } from 'zudb'

import { fresh, isZuError, twoPeople } from './helper.mjs'

const BY_NAME = 'MATCH (p:person) WHERE p.name = $name RETURN p.id AS id'

// Every operator of a plan, depth first, which is the order the listing
// prints them in.
function operators(node) {
  return node === null ? [] : [node, ...node.children.flatMap(operators)]
}

// A database with an edge in it, since a plan is only interesting once
// there is something to expand.
async function twoPeopleWhoKnow(t) {
  const made = await twoPeople(t)
  await made.conn.exec('MATCH (a:person), (b:person) INSERT (a)-[:knows]->(b)')
  return made
}

test('a plan is the tree of operators the statement would run', async (t) => {
  const { conn } = await twoPeople(t)

  const plan = await conn.explain(BY_NAME)

  assert.deepEqual(
    operators(plan.root).map((op) => op.op),
    ['Project', 'Filter', 'ScanNodes'],
  )
  assert.deepEqual(plan.columns, ['id'])
  assert.deepEqual(plan.params, ['name'])
  assert.deepEqual(plan.notes, [])
  assert.deepEqual(plan.scalars, [])
})

test('an operator carries what it works on, what it binds and what it touches', async (t) => {
  const { conn } = await twoPeople(t)

  const plan = await conn.explain(BY_NAME)
  const [project, filter, scan] = operators(plan.root)

  assert.equal(project.detail, 'p.id AS id')
  assert.deepEqual(project.binds, ['id'])
  assert.deepEqual(project.tables, [])

  assert.equal(filter.detail, 'p.name = $name')
  assert.deepEqual(filter.binds, [])

  assert.equal(scan.detail, 'p: person')
  assert.deepEqual(scan.binds, ['p'])
  assert.deepEqual(scan.tables, ['person'])
  assert.deepEqual(scan.children, [])
})

test('an operator inside a bracket is named for the bracket and is not it', async (t) => {
  const { conn } = await twoPeopleWhoKnow(t)

  const plan = await conn.explain(
    'MATCH (a:person) OPTIONAL MATCH (a)-[:knows]->(b:person) RETURN a.name AS a, b.name AS b',
  )
  const expand = operators(plan.root).find((op) => op.op === 'Expand')

  assert.equal(expand.op, 'Expand')
  assert.equal(expand.name, 'OptionalExpand')
  assert.equal(expand.bracket, 'Optional')
  assert.deepEqual(expand.tables, ['knows'])
})

test('an operator outside a bracket has none, and is named for itself', async (t) => {
  const { conn } = await twoPeopleWhoKnow(t)

  const plan = await conn.explain('MATCH (a:person)-[:knows]->(b:person) RETURN a.name AS a')
  const expand = operators(plan.root).find((op) => op.op === 'Expand')

  assert.equal(expand.name, 'Expand')
  assert.equal(expand.bracket, null)
})

test('the text is the listing, and it is the tree', async (t) => {
  const { conn } = await twoPeople(t)

  const plan = await conn.explain(BY_NAME)

  assert.equal(plan.text, 'Project p.id AS id\n  Filter p.name = $name\n    ScanNodes p: person\n')
  // Written twice on purpose: the listing is what a person reads and
  // the tree is what a program walks, and this is the one assertion
  // that says they describe the same plan.
  assert.deepEqual(
    plan.text
      .trimEnd()
      .split('\n')
      .map((line) => line.trim().split(' ')[0]),
    operators(plan.root).map((op) => op.name),
  )
})

test('a query written where a value belongs is a plan of its own', async (t) => {
  const { conn } = await twoPeople(t)

  const plan = await conn.explain(
    'MATCH (p:person) RETURN VALUE { MATCH (q:person) WHERE q.name = p.name RETURN q.id LIMIT 1 } AS v',
  )

  assert.equal(plan.scalars.length, 1)
  const [scalar] = plan.scalars
  // It reads a name from the query around it, which is the whole test
  // for whether it runs once or once a row.
  assert.deepEqual(scalar.reads, ['p'])
  assert.equal(scalar.exists, false)
  assert.equal(scalar.plan.root.op, 'Limit')
  assert.ok(scalar.plan.text.includes('ScanNodes q: person'))
})

test('a subquery that reads nothing runs once and says so by reading nothing', async (t) => {
  const { conn } = await twoPeople(t)

  const plan = await conn.explain(
    'MATCH (p:person) RETURN VALUE { MATCH (q:person) RETURN q.id LIMIT 1 } AS v',
  )

  assert.deepEqual(plan.scalars[0].reads, [])
  assert.ok(plan.text.includes('(once)'))
})

test('explaining does not run the statement', async (t) => {
  const { conn } = await twoPeople(t)

  await conn.explain("INSERT (p:person {id: 3, name: 'ida'})")

  const rows = await conn.query('MATCH (p:person) RETURN count(*) AS n')
  assert.equal(rows[0].n, 2n)
})

test('a statement that does not compile fails at the explain', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.explain('MATCH ('),
    (err) => isZuError(err, 'ZuSyntaxError'),
  )
})

test('explaining on a closed connection is refused', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(
    () => conn.explain('MATCH (p:person) RETURN p.name AS name'),
    (err) => isZuError(err, 'ZuUsageError') && err.message.includes('the connection is closed'),
  )
})

test('a profile is what the operators really did', async (t) => {
  const { conn } = await twoPeople(t)

  const run = await conn.profile('MATCH (p:person) RETURN p.name AS name')

  assert.equal(run.stages.length, 1)
  const [stage] = run.stages
  assert.equal(stage.sink, 'Project')
  assert.equal(stage.rows, 2)
  assert.ok(stage.nanos > 0)
  assert.deepEqual(
    stage.ops.map((op) => op.op),
    ['Source', 'Scan'],
  )

  const scan = stage.ops.find((op) => op.op === 'Scan')
  assert.equal(scan.detail, 'p: person')
  assert.equal(scan.pulls, 1)
  assert.equal(scan.rows, 2)
  assert.equal(scan.flat, 2)
  // The estimate comes off the catalog's summary of the table, and rows
  // written without folding the file have not reached it yet, so a table
  // two statements old estimates low. That is the engine's to answer;
  // what this client owes is that the number and the q-error derived
  // from it arrive at all.
  assert.ok(scan.estimate > 0)
  assert.equal(scan.qerror, scan.rows / scan.estimate)
  assert.ok(scan.nanos > 0)
})

test('the estimate is the catalog summary once the file holds it', async (t) => {
  // Written down because the difference between this and the profile
  // above is a real one a reader would otherwise take for noise.
  const { path, conn } = await twoPeople(t)
  conn.close()

  const again = await connect(path)
  t.after(() => again.close())
  const run = await again.profile('MATCH (p:person) RETURN p.name AS name')
  const scan = run.stages[0].ops.find((op) => op.op === 'Scan')

  assert.equal(scan.rows, 2)
  assert.equal(scan.estimate, 2)
  assert.equal(scan.qerror, 1)
})

test('an operator the optimizer has nothing to say about carries nulls', async (t) => {
  const { conn } = await twoPeople(t)

  const run = await conn.profile('MATCH (p:person) RETURN p.name AS name')
  const source = run.stages[0].ops.find((op) => op.op === 'Source')

  assert.equal(source.estimate, null)
  assert.equal(source.bound, null)
  assert.equal(source.qerror, null)
})

test('the profile totals its stages and prints them', async (t) => {
  const { conn } = await twoPeople(t)

  const run = await conn.profile('MATCH (p:person) RETURN p.name AS name')

  assert.equal(
    run.nanos,
    run.stages.reduce((total, stage) => total + stage.nanos, 0),
  )
  assert.ok(run.text.startsWith('stage 1: Project'))
  assert.ok(run.text.includes('Scan p: person'))
})

test('the counts are numbers and the times are whole nanoseconds', async (t) => {
  const { conn } = await twoPeople(t)

  const run = await conn.profile('MATCH (p:person) RETURN p.name AS name')

  for (const stage of run.stages) {
    assert.equal(typeof stage.rows, 'number')
    assert.equal(typeof stage.nanos, 'number')
    assert.equal(stage.nanos % 1, 0)
    for (const op of stage.ops) {
      for (const field of ['pulls', 'rows', 'flat', 'nanos']) {
        assert.equal(typeof op[field], 'number', `${op.op}.${field}`)
        assert.equal(op[field] % 1, 0, `${op.op}.${field}`)
      }
    }
  }
})

test('a profile binds its parameters', async (t) => {
  const { conn } = await twoPeople(t)

  const run = await conn.profile(BY_NAME, { name: 'ada' })
  const filter = run.stages[0].ops.find((op) => op.op === 'Filter')

  assert.equal(filter.detail, 'p.name = $name')
  assert.equal(run.stages[0].rows, 1)
})

test('a profile that binds nothing fails the way the statement would', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.profile(BY_NAME),
    (err) => isZuError(err, 'ZuSyntaxError') && err.message.includes('$name'),
  )
})

test('an expand shows up as its own operator with the rows it walked', async (t) => {
  const { conn } = await twoPeopleWhoKnow(t)

  const run = await conn.profile(
    'MATCH (a:person)-[:knows]->(b:person) RETURN a.name AS a, b.name AS b',
  )
  const expand = run.stages[0].ops.find((op) => op.op === 'Expand')

  assert.ok(expand.detail.includes('knows'))
  assert.equal(run.stages[0].rows, 4)
})

test('a statement that writes is refused rather than profiled', async (t) => {
  const { conn } = await twoPeople(t)

  await assert.rejects(
    () => conn.profile("INSERT (p:person {id: 3, name: 'ida'})"),
    (err) => err.message.includes('profiling a statement that writes'),
  )

  const rows = await conn.query('MATCH (p:person) RETURN count(*) AS n')
  assert.equal(rows[0].n, 2n)
})

test('a signal stops a profile', async (t) => {
  const { conn } = await twoPeople(t)

  const control = new AbortController()
  control.abort(new Error('changed my mind'))

  await assert.rejects(
    () => conn.profile('MATCH (p:person) RETURN p.name AS name', null, { signal: control.signal }),
    (err) => err.message === 'changed my mind',
  )
  // The connection is still usable, which is what says the signal took
  // the statement rather than the connection with it.
  assert.equal((await conn.query('MATCH (p:person) RETURN p.name AS name')).length, 2)
})

test('profiling on a closed connection is refused', async (t) => {
  const { conn } = await fresh(t)
  conn.close()

  await assert.rejects(
    () => conn.profile('MATCH (p:person) RETURN p.name AS name'),
    (err) => isZuError(err, 'ZuUsageError') && err.message.includes('the connection is closed'),
  )
})

test('a statement that is not a string is refused by both calls', async (t) => {
  const { conn } = await fresh(t)

  const refused = (err) =>
    isZuError(err, 'ZuUsageError') &&
    err.message === 'the statement is a Number, and a statement is a string'
  await assert.rejects(() => conn.explain(42), refused)
  await assert.rejects(() => conn.profile(42), refused)
})
