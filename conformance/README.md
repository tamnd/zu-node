# The shared corpus, run through this client

The corpus is one set of hand written YAML files in the engine's repository, under `conformance/cases`. Every client reads the same files and runs the same statements, so a value that survives one binding and not another is a diff rather than an argument. This directory is the Node end of that: a reader for the subset of YAML the cases are written in, a decoder for the value encoding, a reader for the Arrow schema an export carries, and a runner that reports what happened in the form the reference runner reports it.

It is a development tool and not part of the package. `package.json` lists the files that ship and `conformance` is not among them, so it is there when the repository is checked out and absent when `zudb` is installed. Nothing under the published entry points imports it.

## Running it

The cases live in the engine's repository, pinned in `Cargo.toml` to the same revision this client builds against:

```
git clone https://github.com/tamnd/zu /tmp/zu
git -C /tmp/zu checkout 526ac583359f6112bca11bdae3fb43cc6fd76b2e
node conformance/cli.mjs /tmp/zu/conformance/cases
```

which prints every case that did not pass and then one line saying what the run came to:

```
1412 cases, 1411 passed, 0 failed, 1 unsupported
```

`npm run corpus -- /tmp/zu/conformance/cases` is the same thing through the script.

`--strict` turns an unsupported case into a failed run, `--quiet` prints the summary alone, and `--work DIR` keeps the databases the cases were run against instead of removing them, which is what to reach for when a failure wants opening.

The exit code is 0 when nothing failed, and 1 when something did or when the corpus will not read. One and not two for a corpus that will not read, because the reference runner exits one and a report compared line for line is worth less if the two runners disagree about what the run came to.

CI runs the same thing. The `corpus` job reads the revision out of `Cargo.toml`, checks the engine out at it, and runs both the report and the tests below against the cases it finds, so a client that drifts from the corpus fails on the pull request that drifted rather than on the release that shipped.

## What it is checking

Four things, and the last two are the ones this client had to work for.

A client can decode a value and pass every case, because the case and the answer both went through the same decoder. So the reader here is another implementation of the corpus format rather than a consumer of one: it refuses what `crates/zu-corpus/src/yaml.rs` refuses, with the same words and the same line numbers, and the tests in `test/conformance-reader.test.mjs` and `test/conformance-cases.test.mjs` are that file's own tables ported case for case. A reader that grew a hole would pass its own tests and fail those.

The value encoding is the same again. An INT64 written bare is refused, a value wider than the type it claims is refused, a float is exact or it is not a float, and a temporal is written the way the engine prints it. `conformance/temporal.mjs` spells the four accepted forms out rather than calling `Date.parse`, which reads `2024-1-1` and `Jan 1 2024` and is allowed by its own specification to read anything else it likes. What a report prints is the encoding's own spelling, so a failure can be pasted back into a case.

The comparison is not `===`. `NaN` matches `NaN`, `-0` does not match `0`, and a `bigint` never matches a `number`, which is the rule that keeps an INT64 and a FLOAT64 apart: this client puts the first in a `bigint` and the second in a `number`, so a case wanting `1` and a client giving `1n` is a diff and not a rounding.

And the Arrow half is read out of the bytes. This client hands out Arrow IPC rather than a C Data Interface stream, so there is no `ArrowSchema` to walk and no `format` string to read off one. `arrow.mjs` parses the schema flatbuffer at the head of the buffer, with a small vtable reader, and turns each field back into the format string a case is written in. A flatbuffer omits any field holding the schema's declared default, which is the trap: `Int.is_signed` defaults to false, so an unsigned column is written as a width and nothing else, and a reader that defaults it the other way reports every UINT64 as `l` and says nothing. That one cost five cases before it was found, and `test/conformance-arrow.test.mjs` now pins it against bytes the addon really produced rather than against a buffer written by hand, which would only prove the reader agrees with whoever wrote the buffer.

## What this client cannot answer

One case, `result/the-same-name-twice`:

```
RETURN 1 AS a, 2 AS a
```

The engine answers it with two columns, both named `a`, which is a legal result and one this client's row mapping has nowhere to put: `query` hands back an array of plain objects keyed by column name, and an object has one `a`. The second column would silently replace the first.

So the runner reports it unsupported rather than failed, by name and with the reason in the line. Nothing went wrong: the engine answered correctly, and the value mapping this client documents is where the column went. A columnar read of the same statement gives both columns, because a columnar read is an array and an array keeps its order, and the corpus asserts on rows.

Unsupported is a third outcome and not a softer kind of failure. A case the corpus wrote on purpose to catch a mapping cost is a case a client should be able to say it cannot answer, out loud and with the reason, rather than passing it on a value invented for the occasion or failing it as though the engine had got something wrong.

## The one check that is weaker here than in the engine

A case naming a condition writes its GQLSTATUS, and the reference reader checks that code against the table the standard defines, which lives in `zu-common`. This reader checks the shape, five characters of digits and capitals, because the table is not something the client has. A code of the right shape that no standard defines is caught by the reference runner and not by this one. The Python reader and the C reader take the same position.

## The files

`reader.mjs` is the YAML subset: block mappings, block sequences, scalars, and a refusal with a line number for everything else. There is no YAML dependency, which would read these files and a good deal more besides, and would hand back `9223372036854775807` as a float on the way.

`values.mjs` is the `{type, value}` encoding, both directions, and the comparison.

`temporal.mjs` is the four temporal spellings and the duration one, read and printed, with nanoseconds as a `bigint` throughout for the reason they are one everywhere else in this client: nanoseconds from the epoch passed 2^53 in 1970.

`cases.mjs` is what a case is, `arrow.mjs` is the schema reader and the schema comparison, and `runner.mjs` runs them, one database per case with a fresh copy of the suite's load, so a case that leaked a table into the next one would be a failure that moves when the file is reordered.

The tests are in `test/conformance-*.test.mjs`, eighty five of them, and they run with the rest of the suite under `npm test`.
