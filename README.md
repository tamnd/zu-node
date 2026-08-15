# zu for JavaScript and TypeScript

The JS client for [zu](https://github.com/tamnd/zu), an embedded property-graph database. One package, four runtimes: Node.js, Bun, Deno, and the browser via WebAssembly.

```ts
import { connect } from "zudb";

await using conn = await connect("social.zu1");

await conn.exec(`CREATE NODE TABLE Person(id INT64 PRIMARY KEY, name STRING)`);
await conn.loadCsv("Person", "people.csv");

const rows = await conn.query<{ name: string; n: bigint }>(
  `MATCH (p:Person)-[:Follows]->(f)
   RETURN p.name AS name, count(*) AS n ORDER BY n DESC LIMIT 5`,
);
for (const { name, n } of rows) console.log(name, n);
```

```
npm i zudb
```

No `node-gyp`, no postinstall script, no compiler. `optionalDependencies` fetches exactly one prebuilt binary for your platform, and a platform with no prebuild falls back to the WASM build rather than failing the install.

## Decisions worth knowing before you start

- **INT64 is `bigint`.** Always, by default. `{ bigIntMode: "number" }` exists and is documented with its precision hazard, and is never the default, because `count(*)` returning a bigint surprises you once and a corrupted id surprises you in production.
- **Temporal where the runtime has it.** Temporal reached Stage 4 in March 2026 but is unflagged only in Node 26 and recent Chrome, Edge, and Firefox. Node 24 is still the active LTS and Safari is still behind a flag, so the stable public types are `ZuDate`, `ZuTimestamp`, and `ZuDuration`, each with `toTemporal()`. Pass `{ temporal: true }` to get Temporal objects directly, and it throws at connect time on a runtime that lacks it rather than handing you `undefined` three frames later.
- **Nothing blocks the event loop.** Every native call runs on the threadpool. `Sync` variants exist and their doc comments say they belong in scripts, not servers.
- **`await using` is the intended scoping.** `close()` stays public for callers who cannot use it.
- **Web Streams and `AbortSignal`** work the way you expect: `conn.stream(gql)` gives a `ReadableStream` that respects backpressure, and aborting a signal interrupts the query within 50 ms.

## Runtimes

| Runtime | How | Notes |
|---|---|---|
| Node >= 24 (LTS) | prebuilt N-API binary | CI runs 24 and 26 |
| Bun >= 1.3 | the same binary | tested as a first-class target, not assumed |
| Deno >= 2.5 | the same binary via `npm:zudb`, or `jsr:@zu/zudb` | needs `--allow-ffi --allow-read` |
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
