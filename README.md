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

- **INT64 is `bigint`.** Always, by default. A JavaScript number stops being exact at 2^53 and zu's integers go to 2^63, so a count that came back as a number would be a count you cannot trust. `{ bigIntMode: "number" }` is planned, will be documented with its precision hazard, and will never be the default.
- **Nothing blocks the event loop.** Every native call runs on libuv's threadpool and hands back a promise before the statement has started. There is no synchronous variant, and the ones that arrive later will say in their own documentation that they belong in scripts, not servers.
- **`await using` is the intended scoping.** A connection is `Symbol.asyncDispose`, and `close()` stays public for callers who cannot use the syntax.
- **A failure is an ordinary `Error`.** Every `catch`, logger and rejection handler already knows what to do with one. What makes it a zu error is the fields, and none of them has to be parsed back out of the message: `code` is the GQLSTATUS and picks the branch, `condition` is the standard's own words for it, `line` and `column` and `excerpt` underline the token, and `retryable` decides whether a retry loop goes round again. A mistake this client caught before the engine saw it carries no `code` and is named `ZuUsageError`, so a caller mapping codes to branches can tell a missing code from one it does not recognize.
- **A refusal is a rejection.** A closed connection and a parameter of a type nothing can bind are refused inside the promise rather than thrown out of the call, so one `await` catches everything one statement can do.

## What works today

`connect`, `query`, `exec`, `close`, `dispose` and `await using`. Named parameters both ways, including lists, records and nesting. Every scalar the engine has, plus nodes, edges and paths with their tables named rather than numbered, and `ZuDate`, `ZuTime`, `ZuTimestamp` and `ZuDuration`. Read-only connections, memory and thread limits. The full error surface above.

Build it with `npm run build`, and run the suite with `npm test`. Nothing is published yet, so `npm i zudb` is not a thing you can type at anybody's terminal, but everything it will do is built and installed on every run of the release workflow.

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

`AsyncIterable` and Web Streams over a result, and `AbortSignal` wired to the engine's interrupt. `bigIntMode`. `toTemporal()` and `{ temporal: true }`, for the runtimes where Temporal is unflagged: it reached Stage 4 in March 2026 and is unflagged in Node 26, but Node 24 is still the active LTS and Safari is still behind a flag, which is why the stable types are the four classes above. Dual ESM and CJS, with types first in every export condition. Bun and Deno in CI, and the WASM build for the browser.

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
