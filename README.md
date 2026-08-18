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
- **A refusal is a rejection.** A closed connection and a parameter of a type nothing can bind are refused inside the promise rather than thrown out of the call, so one `await` catches everything one statement can do.

## What works today

`connect`, `query`, `exec`, `stream`, `close`, `dispose` and `await using`. Named parameters both ways, including lists, records and nesting. Every scalar the engine has, plus nodes, edges and paths with their tables named rather than numbered, and `ZuDate`, `ZuTime`, `ZuTimestamp` and `ZuDuration`. Read-only connections, memory and thread limits. `bigIntMode`, per statement or per connection. An `AbortSignal` on any statement. The full error surface above, and `isZuError` to recognize it. Streaming, as an async iterable, as batches and as a Web Stream. Both module formats, typed separately.

Build it with `npm run build`, and run the suite with `npm test`. Nothing is published yet, so `npm i zudb` is not a thing you can type at anybody's terminal, but everything it will do is built and installed on every run of the release workflow.

## Stopping a statement

Every statement takes a third argument, and what is in it today is a signal:

```ts
const rows = await conn.query(statement, params, { signal: AbortSignal.timeout(50) });
```

It is the signal JavaScript already has, so a timeout written like the one above, the signal a framework hands a request handler, and an `AbortSignal.any([...])` composed out of both all work here without anything being adapted. When it fires, the engine's interrupt is raised, the executor notices it at a boundary it was already stopping at, and the statement ends inside a vector of rows rather than at the end of the scan. The connection is left exactly as it was, so the statement after a stopped one runs normally.

What the promise rejects with is the signal's own reason, which is what `fetch` does: `AbortSignal.timeout(50)` rejects with the runtime's `TimeoutError`, `controller.abort(new RequestGone())` rejects with the `RequestGone` you made, and a bare `controller.abort()` rejects with the runtime's `AbortError`. A signal that has already fired stops the statement before the engine sees it at all. A signal that never fires costs one listener, taken off again when the statement ends, whether it answered, failed or was stopped.

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

Between the statement and the loop sit two batches, which is the whole of the buffering: a reader slower than the scan stops the scan rather than filling memory behind it. `{ batchRows: 512 }` sets what a batch may hold, which is what to name when the rows are going somewhere with a size of its own. On 50k rows here a stream costs about 460ns a row against 370ns for `query`, reading a batch at a time costs about 320ns, and reading the first batch and stopping costs 1.1ms against 18.6ms for the whole scan, which is what the whole thing is for.

A statement that has to see every row before it can give one, which is `ORDER BY`, `DISTINCT` and the aggregates, runs whole and is handed over in batches afterwards. The loop is the same either way and `summary.streamed` is what tells them apart.

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

## Importing it, either way

```ts
import { connect } from "zudb";      // ESM, and TypeScript resolving through the import condition
const { connect } = require("zudb"); // CommonJS, the same names and the same objects
```

Both formats reach one loaded addon, so a `ZuDate` made through `import` is an instance of the `ZuDate` reached through `require`, and a program that mixes the two, which is most programs with a dependency tree, is not quietly holding two of everything. There is no default export in either format, because a default alongside the named exports is a second spelling of every name whose meaning depends on the caller's bundler and their `esModuleInterop`.

The declarations are separate files rather than one shared `.d.ts`, since a resolver reads `.d.cts` for `require` and `.d.mts` for `import`, and `types` is the first condition in each entry: conditions match in the order they are written, so `types` after `default` is a `types` nothing reaches, and a package that compiles here would be `any` everywhere else. `npm run check:types` compiles a program in each format against the published shape, and `npm run check:package` runs [`attw`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) over a real `npm pack` for node10, node16 CJS, node16 ESM and bundler resolution.

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

`npm run bench` measures what this package adds to the engine, which is a row object and one JavaScript value per column: the same scan with the rows dropped is the floor, and the difference between the two is what the boundary costs. Run it against a release build, since a debug build of the engine moves the floor by an order of magnitude and not the rest of it.

## Still to come

`toTemporal()` and `{ temporal: true }`, for the runtimes where Temporal is unflagged: it reached Stage 4 in March 2026 and is unflagged in Node 26, but Node 24 is still the active LTS and Safari is still behind a flag, which is why the stable types are the four classes above. Bun and Deno in CI, and the WASM build for the browser.

## Runtimes

| Runtime | How | Notes |
|---|---|---|
| Node >= 24 (LTS) | prebuilt N-API binary | CI runs 24 and 26 |
| Bun >= 1.3 | the same binary | tested as a first-class target, not assumed |
| Deno >= 2.9 | the same binary via `npm:zudb`, or `jsr:@zu/zudb` | needs `--allow-ffi --allow-read` |
| Browser and edge | `zudb/wasm` | read-mostly, over OPFS or HTTP range requests |
| Electron | the same binary | N-API is ABI-stable across Electron versions, so no per-Electron rebuild |

`apache-arrow` is an optional peer dependency behind the `zudb/arrow` entry point, so the base package stays small.

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
