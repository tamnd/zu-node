# zu for JavaScript and TypeScript

The JS client for [zu](https://github.com/tamnd/zu), an embedded property-graph database. One package, four runtimes: Node.js, Bun, Deno, and the browser via WebAssembly.

```ts
import { connect } from "zudb";

await using conn = await connect("social.zu1");

await conn.exec(`INSERT (p:Person {id: 1, name: 'ada'})`);
await conn.exec(`INSERT (p:Person {id: $id, name: $name})`, { id: 2n, name: "zoe" });

const rows = await conn.query<{ id: bigint; name: string }>(
  `MATCH (p:Person) WHERE p.name = $name
   RETURN p.id AS id, p.name AS name`,
  { name: "zoe" },
);
for (const { id, name } of rows) console.log(id, name);

rows.columns; // ["id", "name"], in the order they were written
rows.gqlstatus; // "00000"
```

The first insert into a table is what declares it, and the engine works out what each column holds from the values it was given, which is why that one is written with literals and every one after it takes parameters.

The rows are an array, so iterating them is `for (const row of rows)` and nothing else. What a wrapper object would have carried rides beside the elements as properties that are not enumerable, which is what lets the same value spread, stringify and compare as the plain array it is.

## Decisions worth knowing before you start

- **INT64 is `bigint`.** By default, everywhere. A JavaScript number stops being exact at 2^53 and zu's integers go to 2^63, so a count that came back as a number would be a count you cannot trust. `{ bigIntMode: "number" }` asks for the other spelling, and the section below is what it costs.
- **Nothing blocks the event loop.** Every native call runs on libuv's threadpool and hands back a promise before the statement has started. There is no synchronous variant, and the ones that arrive later will say in their own documentation that they belong in scripts, not servers.
- **`await using` is the intended scoping.** A connection is `Symbol.asyncDispose`, and `close()` stays public for callers who cannot use the syntax.
- **A failure is an ordinary `Error`.** Every `catch`, logger and rejection handler already knows what to do with one. What makes it a zu error is the fields, and none of them has to be parsed back out of the message: `code` is the GQLSTATUS and picks the branch, `condition` is the standard's own words for it, `line` and `column` and `excerpt` underline the token, and `retryable` decides whether a retry loop goes round again. A mistake this client caught before the engine saw it carries no `code` and is named `ZuUsageError`, so a caller mapping codes to branches can tell a missing code from one it does not recognize. `isZuError(caught)` is the exported guard for the `catch` clause, where the value is `unknown` and could be anything at all, and in TypeScript it narrows to the full shape.
- **A refusal is a rejection.** A closed connection, a statement that is not a string and a parameter of a type nothing can bind are all refused inside the promise rather than thrown out of the call, so one `await` catches everything one statement can do and no caller has to wrap the same call twice. That holds for the arguments too: passing a number where a statement goes is a `ZuUsageError` the promise rejects with, not a `TypeError` off the stack.
- **Parameters are named, and nothing about them is guessed.** An object keyed by the names the statement uses, without the `$`. An array is refused rather than bound by position, because zu has no positional parameters and binding one by index would run the statement with none of the values the caller passed and say nothing about it. A value that contains itself is refused too, at a nesting depth no real value reaches.

## A database with no file

`connect()` with nothing after it is a database in memory, and it makes no file anywhere.

```ts
import { connect } from "zudb";

await using conn = await connect();

await conn.exec(`INSERT (p:Person {id: 1, name: 'ada'})`);
for (const { name } of await conn.query(`MATCH (p:Person) RETURN p.name AS name`)) {
  console.log(name);
}
```

`connect(":memory:")` is the same thing spelled the way every embedded database spells it, and it makes no file called `:memory:` either, which is what it used to do. Options may stand where the path would, so `connect({ threads: 2 })` is a call and not a mistake.

It is the whole engine and not a reduced one: writes, transactions, the appender, registered frames and streams, all of it, on bytes that are not a file. `conn.memory` says which kind you have, since `path` cannot quite answer it on a filesystem that allows a colon in a name. Nothing survives the last connection, which is the point: a test, a script, or five minutes with the language costs no cleanup and leaves no `social.zu1` in a directory somebody has to notice later.

## A second connection, made from the first

`duplicate()` is another connection to the same database, made from a connection rather than from a path. It is how a pool is written.

```ts
import { connect } from "zudb";

await using conn = await connect("social.zu1");
await using other = await conn.duplicate();

const rows = await other.query(`MATCH (p:Person) RETURN p.name AS name`);
console.log(rows.length);
```

It forks off the database the connection already holds rather than opening the file again, so it costs a schema load and no path lookup, and it works on a database in memory, where there is no path to open a second time. That was the gap worth closing: a pool that seeds itself and lets the first connection go had no way to a second one at all.

The two are connections in every sense rather than two names for one. Each has its own prepared statements, its own caches and its own transaction, so a task taking one from a pool is not in whatever transaction the last borrower left open, and closing one does not close the other. What they share is the write side: they queue behind each other to write and each sees what the other has committed. Two of them also read at once, where two statements on one connection queue, which is the other reason to reach for this.

The switches come across, including `bigIntMode` and `temporal`, because a pool handing out connections that answered differently from the one it was seeded with would be a trap. Other clients spell this call `cursor()`, after the way every embedded database has spelled it for thirty years. That name is taken here by `conn.cursor()`, which is a cursor over the rows of one statement and a different thing entirely, so this one says what it does.

## What works today

`connect`, `query`, `exec`, `stream`, `close`, `dispose` and `await using`. `duplicate`, for a second connection made from the first. Named parameters both ways, including lists, records and nesting. Every scalar the engine has, plus nodes, edges and paths with their tables named rather than numbered, and `ZuDate`, `ZuTime`, `ZuTimestamp` and `ZuDuration`, with `{ temporal: true }` and `toTemporal()` for the runtimes that have `Temporal`. Read-only connections, databases in memory, memory and thread limits. `bigIntMode`, per statement or per connection. An `AbortSignal` on any statement, and `rowsRead` and `progress` for watching the one running now. The full error surface above, and `isZuError` to recognize it. Streaming, as an async iterable, as batches and as a Web Stream. Transactions, with `inTransaction` on the connection. An appender, for loading rows a batch at a time, and `load` for building a whole database out of columns and an edge list. Registered frames, so an Arrow table or an object of typed arrays is something a statement can match on without the rows being copied. `columnar`, for a result read down its columns as the buffers themselves rather than across its rows as objects. Prepared statements, compiled at the line that asked and run as often as wanted, and `explain` and `profile`, as a tree a program walks and as the listing a person reads. Both module formats, typed separately.

Build it with `npm run build`, and run the suite with `npm test`. Nothing is published yet, so `npm i zudb` is not a thing you can type at anybody's terminal, but everything it will do is built and installed on every run of the release workflow.

## Stopping a statement

Every statement takes a third argument, and what is in it today is a signal:

```ts
const rows = await conn.query(statement, params, { signal: AbortSignal.timeout(50) });
```

It is the signal JavaScript already has, so a timeout written like the one above, the signal a framework hands a request handler, and an `AbortSignal.any([...])` composed out of both all work here without anything being adapted. When it fires, the engine's interrupt is raised, the executor notices it at a boundary it was already stopping at, and the statement ends inside a vector of rows rather than at the end of the scan. The connection is left exactly as it was, so the statement after a stopped one runs normally.

What the promise rejects with is the signal's own reason, which is what `fetch` does: `AbortSignal.timeout(50)` rejects with the runtime's `TimeoutError`, `controller.abort(new RequestGone())` rejects with the `RequestGone` you made, and a bare `controller.abort()` rejects with the runtime's `AbortError`. A signal that has already fired stops the statement before the engine sees it at all. A signal that never fires costs one listener, taken off again when the statement ends, whether it answered, failed or was stopped.

## Watching one run

A statement that takes a minute is one somebody is sitting in front of, so a connection says how far the one running now has got:

```ts
using watch = conn.progress((rows) => process.stdout.write(`\r${rows} rows read`));
const answer = await conn.query(statement);
```

`rowsRead` is the number underneath it, and it is a property rather than a call because reading it must never wait: the statement is on a threadpool thread holding the connection's lock, and this is an atomic beside the lock rather than a question through it. It counts rows read out of storage rather than rows answered, because the statement somebody is waiting on is exactly the one that reads a hundred million rows to answer one. It starts again at zero at each statement and holds its last value once one ends, so `conn.rowsRead` after a statement is what that statement cost.

`progress` is a timer around that number, a tenth of a second apart unless you say otherwise with `{ everyMs }`. The callback runs only when the count has moved, which is what makes a watch on an idle connection quiet, and the timer does not hold the event loop open, so a watch nobody stopped is not a program that never exits. Stop it with `stop()` or by leaving the scope of the `using`. Nothing calls into JavaScript from the thread doing the scanning, which is the point: the statement being watched does not know it is being watched and does not slow down for it.

## Reading a result a piece at a time

`conn.stream(...)` runs the same statement and hands the rows over as they are made, instead of building the whole answer first:

```ts
await using stream = conn.stream<{ id: bigint; name: string }>(
  `MATCH (p:Person) RETURN p.id AS id, p.name AS name`,
);
for await (const { id, name } of stream) {
  if (name === "ada") break; // the scan under it stops here
}

stream.summary; // { columns, rows, stopped, streamed, notices }
```

Three ways to read it, all the same statement read once. `for await` over the stream gives one row at a time. `stream.batches()` gives the array the rows crossed the boundary in, with `columns` beside it, which is what to reach for when the work is per batch rather than per row. `stream.toReadableStream()` gives a `ReadableStream<Row>` for anything that already speaks Web Streams, and its backpressure is the reader's: nothing is pulled from the database until what is in front of it has drained.

Ending early is the case worth knowing about, because it is the reason streaming is different from `query`. A `break`, a `throw`, a `return()` on the iterator, a `cancel()`, or leaving the block of an `await using` all stop the statement and wait for it to let go of the connection, so the next statement on that connection runs rather than queueing behind a scan nobody is reading. The rows already read stand, and `summary.stopped` says the reader stopped it. The statement itself does not start until the first read, so a stream made and never read is not a scan holding anything.

A connection runs one statement at a time, and a stream that has started is that statement until it ends. So a `query` on the same connection while a stream is half-read is refused rather than queued: what it would be queueing behind is the loop that is waiting for it, and a program that stops is worse than a program that is told to read the stream out, cancel it, or open a second connection. Two scans that should overlap want two connections, which is one line and no lock.

Between the statement and the loop sit two batches, which is the whole of the buffering: a reader slower than the scan stops the scan rather than filling memory behind it. `{ batchRows: 512 }` sets what a batch may hold, which is what to name when the rows are going somewhere with a size of its own. On 50k rows here a stream costs about 460ns a row against 370ns for `query`, reading a batch at a time costs about 320ns, and reading the first batch and stopping costs 1.1ms against 18.6ms for the whole scan, which is what the whole thing is for.

A statement that has to see every row before it can give one, which is `ORDER BY`, `DISTINCT` and the aggregates, runs whole and is handed over in batches afterwards. The loop is the same either way and `summary.streamed` is what tells them apart.

## Several statements as one unit of work

One statement is atomic on its own. `conn.transaction()` is how two of them stand or fall together:

```ts
const tx = await conn.transaction();
await conn.exec(`INSERT (p:Person {id: $id, name: $name})`, { id: 3n, name: "ida" });
await conn.exec(`INSERT (p:Person {id: $id, name: $name})`, { id: 4n, name: "eve" });
await tx.commit();
```

The statements are still the connection's, because the span is the connection's and not a second handle to it. `conn.inTransaction` says whether one is open, and it is the session's own answer rather than a tally kept here, so a caller who would rather write `START TRANSACTION`, `COMMIT` and `ROLLBACK` as statements gets the same answer from it. `{ readOnly: true }` starts a span that refuses the statement that writes. Nesting is refused by the engine, with the engine's own condition.

`await using tx` rolls back. That is the opposite of what the Python client's `with` block does, and the difference is in the language rather than in the database: a Python context manager is handed the exception unwinding through it and can tell a block that ended well from one that failed, and a JavaScript disposal is told nothing at all. A disposal that committed would commit half the work of a block that threw, which is the one thing a transaction exists to prevent. So the commit is the word the caller writes, and leaving the block without writing it undoes the span:

```ts
{
  await using tx = await conn.transaction();
  await conn.exec(`INSERT (p:Person {id: 5, name: 'zoe'})`);
  await tx.commit(); // without this line the insert is undone
}
```

A block that ends well and forgets to commit loses its work, which is a loud kind of wrong and shows up the first time the code runs. The alternative was a block that failed and kept half of what it did, which is a quiet kind and shows up in production. Committing or rolling back twice is refused as a `ZuUsageError` rather than ignored, since the statements after the first end belong to no transaction of yours. Leaving the block of a transaction whose connection has already been closed says nothing, because a closed connection took the unwritten span with it and there is nothing left to undo.

## Loading a lot of rows

`INSERT` is the wrong shape for loading. Every row is parsed, bound, planned and committed, and the commit is the expensive part, so a million rows is a million commits and the load is spent on durability nobody asked for. An appender is the right shape: rows go into columns in memory, and a flush turns the whole buffer into one commit.

```ts
await using rows = await conn.appender("Person");
for (const [id, name] of people) rows.appendRow([id, name]);
await rows.flush();
```

A row is every column of the table, in the order the table declares them, and a column is a position rather than a name. Naming the columns per row would cost a lookup per value on the one path where per-value cost is the whole story, and a loader knows its own column order. `appendRows` takes an array of them, which is one check for the batch rather than one per row.

`appendRow` is the one synchronous call in this client, and it is synchronous because it reaches nothing. It converts the values in front of it and pushes them onto a vector, bounded by the width of one row, with no file and no lock at the end of it. Making it a promise would put a microtask between the loop and a memcpy and allocate a million promises to describe work that had already finished. Being synchronous it throws rather than rejecting, with the same `ZuUsageError` everything else here rejects with, so `isZuError(caught)` recognizes it either way. Everything that touches the file, which is `flush`, `close` and the disposal, is a promise like the rest of the client.

What is buffered is typed from the table's own columns, read when the appender opened, so a value that does not belong in a column is refused by the call that appended it rather than a million rows later by the flush that would have carried it. The message names the column and the position: `value 0 of this row is a string and column 'id' of 'Person' holds whole numbers`. A refused row is a row that never happened, so the columns that did take a value give it back and the appender is usable as soon as the caller has fixed the row. In a batch the refusal says which row it was and keeps the ones before it, since nothing here is a transaction until the flush.

`await using rows` flushes. That is the opposite of what a transaction's disposal does, and the two differ because the question differs: a transaction that leaves its scope unfinished is a unit of work nobody completed, and a buffer that leaves its scope unwritten is a loader that read a million rows and threw them away. `discard()` is there for the caller who meant exactly that, and it answers how many rows it dropped.

Two more things are worth knowing before a load. A flush issued while one is still running is refused rather than queued, and so is an append, because waiting for either would be the event loop waiting for a write to disk: `await` the flush. And rows an appender writes are not part of an open transaction, since it writes through the file rather than through the session, so a `ROLLBACK` after a flush does not take them back. A load and a transaction are two different things to reach for.

A rel table has no property columns. A row of one is the two ends of an edge, as offsets into the tables it runs between, so `conn.appender("knows")` takes two columns and the flush checks that both rows are there before it writes anything. That check is here rather than the engine's, because the engine's comes after the write is durable.

## Building a graph out of columns and an edge list

An appender writes rows into a table that already exists, and no statement makes a rel table, so neither of them is a way to a graph with edges in it. `load` is the other shape and the one the C ABI's loader has: a table's columns whole, an edge list whole, one file written once.

```ts
import { load } from "zudb";

const uid = new BigInt64Array([1n, 2n, 3n]);
const name = ["ada", "grace", "kay"];

const stats = await load("social.zu1", {
  nodes: "person",
  rels: "knows",
  columns: { uid, name },
  edges: [
    [0, 1],
    [1, 2],
  ],
});
console.log(stats); // { nodes: 3, rels: 2, columns: 2 }
```

It is a function rather than a method because there is no connection yet: the file it writes is the file a program connects to afterwards. The path must not exist, since a load builds a database rather than adding to one, and a path that already holds one is a caller who meant a different path. What comes back is what went in, as `{ nodes, rels, columns }`.

Edges name rows by position, counting from zero in the order the columns were written, because at load time a row has no other name. They go in as pairs, `[[0, 1], [1, 2]]`, or as a flat `Int32Array` or `Uint32Array` of two elements an edge for a program that built them in memory and would rather not make a million small arrays to hand them over. The same edge twice is one edge, and an edge naming a row the table has not got is refused rather than written, because a builder handed one would either invent the row or lose the edge.

A column goes in as an array of values or as a typed array. The first value of an array settles what the column holds and every value after it has to agree, which is the appender's rule, with the same one widening: `[1, 2, 2.5]` is a column of floats. A typed array is read as the numbers it already holds, which is one pass over memory rather than a runtime call per value, and every integer width lands as the INT64 the store keeps. On this machine, with `npm run bench:load` over a million rows:

```
one column, typed array             51.3 ms      51 ns/row
one column, plain array             92.2 ms      92 ns/row
two columns, with names           1060.1 ms    1060 ns/row
two columns and an edge each      1096.9 ms    1097 ns/row
the appender, for contrast        2124.5 ms    2125 ns/row
```

The last line is the same two columns through the appender, which is the closest comparison there is: a load is about twice as quick and is the only one of the two that can write the edges. The strings are where the rest of the time goes, which is the store encoding them rather than anything on this side of the boundary.

Everything the caller passed is read on the thread that owns the runtime, because that is the only thread allowed to read a JavaScript value, and everything after that runs on the threadpool: the edges are sorted, the graph is built, and every column is encoded and written to disk. So the event loop is free for the whole of the expensive part, which on a load is all of it.

## Matching on columns a program already has

Columns a program is already holding become something a statement can match on, under a name the program picks.

```ts
await conn.register("people", table);
const rows = await conn.query(`MATCH (p:people) WHERE p.age > 40 RETURN p.name AS name`);
await conn.unregister("people");
```

An Arrow table goes in, which is what `apache-arrow` and everything built on it hands out, and so does an object of column name to typed array for a caller with none of that installed. `apache-arrow` is not a dependency of this package and is not imported by it: a table is recognized by its shape, so any library that speaks that shape takes the same path.

Nothing is copied. What the engine is told is where each column is, how wide its values are and what they mean, and a statement that names the frame builds vectors pointing straight at the caller's arrays. So registering costs what describing the columns costs and not what the rows cost: on this machine a frame of a million rows registers in 26 microseconds and one of ten rows in 34, both of which are mostly the promise, since the round trip on its own is 16.

The one column that is walked is a string column, and it is walked once. Every offset is checked at registration so that reading the frame afterwards cannot fail, which is 1.2 ms for a million strings. Two other things copy and both are said rather than hidden: a table that arrived as several record batches is concatenated into one, because a column of a frame is one run of bytes and two batches are two of them, and a column given as a plain array is read into a buffer of this client's own, because an array holds JavaScript values rather than numbers and there is nothing in it to point at. That last one is the expensive way in at 127 ns a row, and it is there so that a caller with an array is not stuck rather than because it is the way to do this.

Because it is not a copy, a registered frame is a view and not a snapshot. Write into the typed array behind it and the next statement answers what is there now, which is the thing to know about the call and the reason it is worth having. Reading one is as fast as reading a table of the database and faster where the database has to decode: over a million rows here, summing an integer column takes 1.3 ms against a stored table's 1.6, and finding one row by a string takes 2.2 ms against 5.8.

The frame belongs to the connection it was registered on and goes when that connection does. Nothing is written to the file, so another program opening the same database has never heard of it, and nothing writes to it either: a statement that inserts into or deletes from a registered name is refused with the reason, because that memory is the caller's array. `unregister(name)` takes the name away and hands the arrays back, which is not always that instant, since a statement still reading the frame holds it until it ends. `registered()` says what is registered here, and it is a method rather than a getter because it takes the connection's lock like everything else and nothing here blocks the event loop.

Registering the same name again replaces what it stands for, columns and all. Registering over a table the database already holds is refused, since a statement naming it would mean the stored one. A frame with no rows is a table to match on and answers nothing, because a frame knows its columns without being told by a row. A null anywhere is refused by column and row, since a property that is null is one no row of this engine holds, and registering inside a transaction is refused because a frame is registered on the session, which is the thing the transaction is running on.

## Reading a result as columns

`query` builds an object a row and a JavaScript value a cell, which is what a program reading a hundred rows wants and the wrong shape for a million. `columnar` runs the same statement and hands back the buffers instead:

```ts
const read = await conn.columnar(`MATCH (p:person) RETURN p.age AS age`);
read.rows; // 1000000
read.columns[0].values; // a BigInt64Array of every age, and not one object
```

The buffers are the engine's own, moved rather than read: the pointer V8 is given is the pointer the engine filled, and the allocation is freed when the typed array is collected. So a column of a million integers crosses the boundary as a pointer and a length. On this machine, with `npm run bench:columnar` over a million rows:

```
one integer column, columnar       38.4 ms      38 ns/row
one integer column, rows          243.1 ms     243 ns/row
a string column, columnar          50.3 ms      50 ns/row
a string column, rows             262.0 ms     262 ns/row
three columns, columnar            75.8 ms      76 ns/row
three columns, rows               632.2 ms     632 ns/row
```

Walking what came back costs the same either way, at about 14 ns a row for a sum over the buffer and the same over the rows, which is worth saying because it is where the win is not. V8 reads a property of a small object about as fast as an element of a typed array. What it cannot do is make a million of those objects for nothing, and that is the whole of the six to eight times above.

Every column says what it is, and reading one is a switch on `type` rather than a series of tests for what is there. `values` carries everything of a fixed width: a `BigInt64Array` of integers, nanoseconds or months, a `Float64Array` of floats, an `Int32Array` of days, and for booleans a `Uint8Array` of one bit a row, least significant bit first. A string column has `data`, the bytes of every string end to end, and `offsets`, one more than there are rows, so row `i` is `data.subarray(offsets[i], offsets[i + 1])`. `validity` is one bit a row again, set meaning the row has a value, and it is null when nothing in the column is, so the common case costs a reader nothing to skip. `unit` says whether a cell counts days, nanoseconds or months, and `zone` is the minutes east of UTC a column of zoned times was written with.

That layout is Arrow's, which is the point of it. `apache-arrow` wraps a buffer of this shape without copying it, so a table is eleven lines and no dependency of this package:

```ts
// with apache-arrow installed, and nothing in zudb importing it
const table = new Table(
  Object.fromEntries(
    read.columns.map((column) => [
      column.name,
      new Vector([
        makeData({
          type: arrow(column), // Int64, Float64, Bool, Utf8, DateDay, TimestampNanosecond
          length: column.length,
          nullCount: column.nulls,
          nullBitmap: column.validity ?? undefined,
          data: column.data ?? column.values,
          valueOffsets: column.offsets ?? undefined,
        }),
      ]),
    ]),
  ),
);
```

The same memory is on both sides of that: `table.getChild("age").data[0].values` is the array the engine filled, not a copy of it. The recipe is printed here rather than shipped because a client that hands out an Arrow object has to agree with one version of Arrow forever, and a client that hands out the bytes agrees with all of them. It is run in the test suite, so it is checked rather than believed.

Two things are not buffers, and both are named by the type rather than found out by looking. A column of nodes, rels, paths, lists or records has no fixed width cell, so it arrives as `items`, holding the same JavaScript values `query` would have made. A column of nothing but nulls has a length and nothing else, because there is nothing to put in a buffer. A column that mixes two types is refused, naming the column and the row that did it, since a columnar result holds one type per column and a column that quietly became strings is worse than one that would not build.

A statement that matched nothing still comes back with its columns, each one the type the plan declared and each one empty: a string column of no rows has its one starting offset, an integer column of no rows has a buffer of no elements. So a table built from an empty answer has the schema the same statement would have had with rows in it, and a loop that concatenates a page at a time does not have to hold the first page that had anything in it as a special case.

`bigIntMode` says nothing here. A columnar read has one physical layout per type and an INT64 column is 64 bit cells however a caller would rather read one, which is the difference between a buffer and a value. The mode still decides what is inside `items`, where this client is making objects anyway.

## Preparing a statement

`conn.prepare` compiles a statement now and hands back something that runs it later, as often as it is asked to, with different values bound each time:

```ts
await using find = await conn.prepare(`MATCH (p:person) WHERE p.name = $name RETURN p.id AS id`);
find.params; // ["name"], which the statement asked for and nobody had to read out of it
const ada = await find.query<{ id: bigint }>({ name: "ada" });
const zoe = await find.query<{ id: bigint }>({ name: "zoe" });
```

It answers the same three ways a connection does. `query` gives rows, `exec` gives nothing and is for a statement written to change something, and `columnar` gives the buffers. Each takes the bindings and the same options a statement takes, so a signal and a `bigIntMode` go on the run rather than on the prepare, since which run a caller wants to stop is a property of that run.

What this is not is a speedup, and it is worth saying so here rather than letting a reader assume the thing every other client's documentation says. A driver prepares to save a round trip to a server, and there is no server and no round trip here. The engine already caches the plan for a statement by its text, so the second `conn.query` of the same string is not compiled a second time either. On this machine, with `npm run bench:prepared` over 100 rows and 5000 runs:

```
prepared, bound per run                     13756 ns each
the same text, bound per run                13812 ns each
a new text per run                          21209 ns each
```

The first two are the same number, and that is the honest result. The third is the one to read: a statement whose text is different every run, which is what a program that pastes its values into the string is writing, pays the compile every time, and the roughly 7 microseconds between it and the other two is the size of that mistake. `prepare` and `close` together cost 10 microseconds, which is that same compile bought once.

So what preparing buys is two things, and neither of them is throughput. The compile happens at the line that asked for it, at startup, where a statement that does not compile fails on the way up rather than on the first request that needed it. And the names come back: `params` is what the statement wants bound, in the order the engine found them, which is how a layer that binds from a record knows what to look for. `statement` is the text it was given back, and `closed` says whether it still holds anything.

A prepared statement holds an id on the connection that made it, so closing it gives that back. `await using` is the intended scoping, `close()` is there for callers who cannot use the syntax, closing twice is not an error, and every run after the close is refused with the reason. One whose connection closed first is refused too, saying the connection is closed, because the session that was holding the id went with it. There is no `stream` on a prepared statement, deliberately: the engine's streaming path takes a text rather than a pinned id, so a streamed prepared statement would be this client quietly running the text again behind the caller, and a method that does not do what its name says is worse than one that is not there.

## Seeing what a statement will do

`explain` compiles a statement and answers the plan without running it:

```ts
const plan = await conn.explain(`MATCH (p:person) WHERE p.name = $name RETURN p.id AS id`);
plan.columns; // ["id"]
plan.params; // ["name"]
plan.root.op; // "Project"
plan.root.children[0].detail; // "p.name = $name"
console.log(plan.text);
// Project p.id AS id
//   Filter p.name = $name
//     ScanNodes p: person
```

It comes back twice on purpose. `root` is the tree, for a program: every operator carries `op`, the `detail` it works on, the `binds` it introduces, the `tables` it touches, and its `children`, so a test can assert that a scan became an index seek without matching on a string. `text` is the engine's own listing, for a person, and it is the engine's rather than this client's rendering of the tree so the two cannot drift apart from one release to the next. An operator inside a bracket says which one it is in, `Optional`, `Semi`, `Anti` or `Mark`, and `name` is what the listing calls it, which for an expand inside an optional match is `OptionalExpand` while `op` stays `Expand`.

`explain` takes no parameters, and that is not an oversight. A plan is chosen from the shape of the statement, and the values are bound when it runs, so a plan asked for with values would suggest that the values changed it. `scalars` is the other half of that: a query written where a value belongs gets a plan of its own, and `reads` says which variables of the query around it that plan reads, which is the whole difference between a subquery that runs once and one that runs once a row.

`profile` runs the statement and answers what the operators actually did:

```ts
const run = await conn.profile(`MATCH (p:person) RETURN p.name AS name`, { since: 1990 });
const scan = run.stages[0].ops.find((op) => op.op === "Scan");
scan.rows; // what it really produced
scan.estimate; // what the optimizer thought, or null if it had nothing to say
scan.qerror; // the two divided, the way the literature writes it
run.nanos; // every stage added up
```

A profile takes bindings, since it is a run. Every count is a `number` and not a `bigint`, which is the one place in this client an integer is spelled as a double on purpose: nothing a profile counts, not rows, not pulls, not nanoseconds of a statement anybody waited for, comes anywhere near 2^53, and a caller doing arithmetic on a measurement should not have to convert first. `pulls` is how many times the operator above asked, `rows` is how many it answered, `flat` is the same count with vectors unpacked, `bound` is the upper bound the optimizer had, and `qerror` is null where an estimate was. A statement that writes is refused rather than profiled, saying so, because a profile that also inserted two rows is a measurement that changed the thing measured.

## Asking for numbers instead of bigints

`bigIntMode` says how INT64 is spelled on the way out. It goes on one statement, or on a connection for all of them, and a statement on a connection that named one may still name the other:

```ts
const conn = await connect("social.zu1", { bigIntMode: "number" });
const rows = await conn.query<{ id: number }>(`MATCH (p:Person) RETURN p.id AS id`);
JSON.stringify(rows); // works, which it does not with bigints in it

const exact = await conn.query(`MATCH (p:Person) RETURN count(*) AS n`, null, {
  bigIntMode: "bigint",
});
```

Two things are usually behind the ask. `JSON.stringify` throws on a `bigint`, so a row holding one cannot be handed straight to a response, and arithmetic on a `bigint` will not mix with a `number`, so every `+` in the reporting code needs a conversion. Numbers are also slightly cheaper to make: on 50k rows here, one INT64 column costs about 190ns a row as numbers against about 220ns as bigints.

What is traded for that is worth stating plainly, because it is the reason this is never the default. Which integers a database holds is a property of the data and not of the program, so a query that returned numbers for every row of a test database is a query that can meet a larger one in production. This client refuses that row rather than rounding it: an integer past 2^53 raises a `ZuUsageError` naming the column and the value, so the failure is loud and local instead of an answer that is quietly off by one. It is still a failure that arrives at read time, on a machine that is not yours.

The mode reaches the INT64 columns of a result and nothing else. A node's `offset`, an edge's `src`, `dst` and `ord`, and the nanosecond counts on the temporal classes stay `bigint` in both modes, because they are properties of classes the addon registers once rather than values a statement can respell.

## Dates and times, as classes or as Temporal

A date, a time, a timestamp and a duration come back as `ZuDate`, `ZuTime`, `ZuTimestamp` and `ZuDuration`, which hold exactly what the engine holds: a count of days from 1970-01-01, a count of nanoseconds from midnight, a count of nanoseconds from the epoch, and a count of months or nanoseconds. That is exact and it is portable and it is no help at all to a program that wants to know what day of the week it was.

`Temporal` is the standard answer to that, so a connection can ask for it:

```ts
await using conn = await connect("social.zu1", { temporal: true });
const rows = await conn.query<{ on: Temporal.PlainDate }>(`MATCH (d:day) RETURN d.on AS on`);
rows[0].on.dayOfWeek; // 1, which no count of days was ever going to tell you
```

| zu | as a class | with `{ temporal: true }` |
|---|---|---|
| DATE | `ZuDate` | `Temporal.PlainDate` |
| TIME without an offset | `ZuTime` | `Temporal.PlainTime` |
| TIME with an offset | `ZuTime` | `ZuTime`, which is the exception below |
| TIMESTAMP without an offset | `ZuTimestamp` | `Temporal.PlainDateTime` |
| TIMESTAMP with an offset | `ZuTimestamp` | `Temporal.ZonedDateTime` |
| DURATION | `ZuDuration` | `Temporal.Duration` |

The exception is the one value zu holds that `Temporal` has no type for. A time carrying an offset is neither a `PlainTime`, which is local and would drop the offset, nor a `ZonedDateTime`, which carries a date nobody wrote, so it stays a `ZuTime` in temporal mode rather than being converted into something it is not. Everything else in the same row still arrives converted.

The option is settled when the connection is opened and cannot be named per statement, unlike `bigIntMode`. Both spellings are exact and neither loses anything, so which one a program wants is a property of the program and not of the query, and a result whose classes changed halfway through a codebase is a result nobody can write a function against. A program that wants one value converted rather than all of them calls `toTemporal()`, which is on all four classes and needs no option anywhere:

```ts
const rows = await conn.query<{ on: ZuDate }>(`MATCH (d:day) RETURN d.on AS on`);
const plain = rows[0].on.toTemporal(); // Temporal.PlainDate
```

Going the other way needs no opt-in at all. A `Temporal` value passed as a parameter binds as the zu value it is, on every connection, whether or not that connection asked for `Temporal` on the way out, because recognizing one costs a property read and refusing one would be a rule nobody could guess. `PlainDate`, `PlainTime`, `PlainDateTime`, `ZonedDateTime`, `Instant` and `Duration` all bind. A `PlainYearMonth`, a `PlainMonthDay` or a value on a calendar that is not `iso8601` is refused by name, since zu holds neither, and so is a `Duration` counting both months and days, because no number of days is a month and a value holding both would have to invent an answer for one month after 31 January.

What it costs is the constructor and the calendar arithmetic. On 50k rows here a DATE column costs about 560ns a row as a `ZuDate` and about 650ns as a `Temporal.PlainDate`, against 240ns for the INT64 column beside it, so the conversion is worth about a sixth of a value that was already the most expensive kind to build. Nothing is cached between rows, because a `Temporal` value is a JavaScript object and the constructors are properties of one, and neither can be held by a struct that crosses to the threadpool thread the statement runs on.

`Temporal` reached Stage 4 in March 2026 and is unflagged in Node 26 and the current browsers. Node 24, which is still the active LTS, has it behind `--harmony-temporal`. Asking a runtime without it for `{ temporal: true }` is refused at the connect and before the database file is opened, so a program that asked for something its runtime cannot do fails at the line that asked and leaves nothing behind. `toTemporal()` on such a runtime is refused the same way. That is the whole reason this is an opt-in rather than the default: a client that returned `Temporal` values everywhere would be a client half its users cannot load.

In TypeScript the types are named `ZuPlainDate`, `ZuPlainTime`, `ZuPlainDateTime`, `ZuZonedDateTime` and `ZuTemporalDuration`, and each is the real `Temporal` type on a program whose `lib` declares one and `unknown` on a program whose `lib` does not. Which `lib` has `Temporal` is different in every version of TypeScript that has shipped since Stage 4, and a package that hard-coded an answer would either fail to compile for half its users or promise a type their compiler has never heard of.

## Importing it, either way

```ts
import { connect } from "zudb";      // ESM, and TypeScript resolving through the import condition
const { connect } = require("zudb"); // CommonJS, the same names and the same objects
```

Both formats reach one loaded addon, so a `ZuDate` made through `import` is an instance of the `ZuDate` reached through `require`, and a program that mixes the two, which is most programs with a dependency tree, is not quietly holding two of everything. There is no default export in either format, because a default alongside the named exports is a second spelling of every name whose meaning depends on the caller's bundler and their `esModuleInterop`.

The declarations are separate files rather than one shared `.d.ts`, since a resolver reads `.d.cts` for `require` and `.d.mts` for `import`, and `types` is the first condition in each entry: conditions match in the order they are written, so `types` after `default` is a `types` nothing reaches, and a package that compiles here would be `any` everywhere else. `npm run check:types` compiles a program in each format against the published shape, and `npm run check:package` runs [`attw`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) over a real `npm pack` for node10, node16 CJS, node16 ESM and bundler resolution.

## Reference

Every exported name, its signature and what its doc comment says, generated from the declarations this package publishes rather than written by hand beside them. The release builds it from the version it is about to publish, and `npm run reference` builds the same pages here.

typedoc rather than api-documenter, which would have been the obvious pick since api-extractor already runs here for the stability report. api-extractor's doc model does not carry `conn.stream(...)` or `await using`, because both reach the type of a connection through the `declare module` in `zudb.d.cts` and it does not follow one. A reference missing the streaming entry point is a reference that sends a reader to the cursor. So the generator that reads the declarations with the TypeScript compiler is the one used, and the build fails if it stops carrying them, along with any exported name whose types have gone missing.

## Installing, once there is something to install

`npm i zudb`, and that is the whole of it. The install downloads one file, runs nothing, and needs no compiler: the root package carries the loader and no binary, each platform has its own package holding exactly one addon, and npm picks the one for the machine out of `optionalDependencies` by its `os`, `cpu` and `libc`. There is no `postinstall`, no `node-gyp`, no `node-pre-gyp` and no fetch from anywhere but the registry, which is what makes the package installable behind a proxy, inside a locked-down CI image, and on a machine with no toolchain on it.

| Machine | Package | Built on |
|---|---|---|
| Linux x64, glibc | `zudb-linux-x64-gnu` | manylinux_2_28, so glibc 2.28 and newer, which is RHEL 8 and newer |
| Linux arm64, glibc | `zudb-linux-arm64-gnu` | the same image, the same floor |
| Linux x64, musl | `zudb-linux-x64-musl` | Alpine 3.24 |
| Linux arm64, musl | `zudb-linux-arm64-musl` | Alpine 3.24 |
| macOS arm64 | `zudb-darwin-arm64` | the hosted arm64 runner |
| macOS x64 | `zudb-darwin-x64` | cross compiled from that same runner |
| Windows x64 | `zudb-win32-x64-msvc` | the hosted x64 runner |
| Windows arm64 | `zudb-win32-arm64-msvc` | the hosted arm64 runner |

Anything outside that table has no binary and no source build to fall back on, so the install resolves nothing and the first `require` says so. The browser and the platforms nobody builds for are what the WASM target answers, later.

`npm run bench` measures what this package adds to the engine, which is a row object and one JavaScript value per column: the same scan with the rows dropped is the floor, and the difference between the two is what the boundary costs. Run it against a release build, since a debug build of the engine moves the floor by an order of magnitude and not the rest of it. `npm run bench:append` does the same for the appender, `npm run bench:load` for building a database out of columns, `npm run bench:register` for registered frames, where what is being watched is that the registration does not scale with the rows, `npm run bench:columnar` for a result read down its columns against the same result read across its rows, and `npm run bench:prepared` for a prepared statement against the same text run again and against a text that is new every time, which is the one of these whose interesting number is that the first two are equal.

## Still to come

Bun and Deno in CI, and the WASM build for the browser.

## Runtimes

| Runtime | How | Notes |
|---|---|---|
| Node >= 24 (LTS) | prebuilt N-API binary | CI runs 24 and 26, and 24 again with `--harmony-temporal` |
| Bun >= 1.3 | the same binary | CI runs the whole suite on it |
| Deno >= 2.9 | the same binary via `npm:zudb`, or `jsr:@zu/zudb` | CI runs the whole suite on it, with `--allow-read --allow-write --allow-env --allow-ffi` |
| Browser and edge | `zudb/wasm` | read-mostly, over OPFS or HTTP range requests |
| Electron | the same binary | N-API is ABI-stable across Electron versions, so no per-Electron rebuild |

`apache-arrow` is a dev dependency and not a dependency, and it is one so that the tests can build the tables the register path reads. Nothing in the package imports it, so a caller who never registers a frame never installs it.

One binary serves all three, because N-API is the ABI all three implement, and the whole suite runs on each of them in CI rather than the other two being assumed from Node passing. `npm run test:bun` and `npm run test:deno` run it locally. What the three do not agree on is what a native error carries: V8 writes a `stack` when the error is made and JavaScriptCore writes none at all through N-API, so this client writes the header line itself when it finds none, non-enumerably, and `err.stack` starts with the condition's name on all of them.

## Specification

Spec/2064g/dx/05-typescript.md in [tamnd/zu](https://github.com/tamnd/zu). Milestone: DX3 (tamnd/zu#169).

## Status

Pre-1.0 and pre-release. Nothing is published yet. The engine, the C ABI, and this client all move on one version number, so a release here always pairs with the same release of [`tamnd/zu`](https://github.com/tamnd/zu).

## Where things live

| What | Where |
|---|---|
| Engine, Rust SDK, CLI, `zu.h`, conformance corpus | [tamnd/zu](https://github.com/tamnd/zu) |
| Documentation and website | [tamnd/zu-web](https://github.com/tamnd/zu-web) |
| This client | here |

If a bug reproduces through the `zu` CLI, it belongs in [tamnd/zu](https://github.com/tamnd/zu/issues), not here.

## License

Apache-2.0, same as the engine.
