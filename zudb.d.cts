/* The types for `require('zudb')`. */

import type { ZuBatch, ZuError, ZuParam, ZuStreamOptions, ZuSummary, ZuValue } from './binding.cjs'

export * from './binding.cjs'

/**
 * The two things about a connection that are not written in Rust.
 *
 * The disposal is put on every connection as it is made, under the key
 * `await using` looks up. It cannot be declared where the rest of the
 * class is, because the generator writes that file from the Rust and a
 * method's name there is a string while this key is a symbol.
 *
 * `stream` is on the prototype for a plainer reason: its body is an
 * async generator, and there is nowhere in Rust to write one.
 */
declare module './binding.cjs' {
  interface Connection extends AsyncDisposable {
    /**
     * Runs one statement and reads it a batch at a time.
     *
     * The statement starts on the first read rather than here, so a
     * stream that is made and never read is not a scan holding the
     * connection against everything after it. Ending the read early,
     * by a `break` or a `cancel()`, stops the statement.
     */
    stream<Row = Record<string, ZuValue>>(
      statement: string,
      params?: Record<string, ZuParam> | null,
      options?: ZuStreamOptions | null,
    ): ZuStream<Row>
  }
}

/**
 * A statement read a batch at a time.
 *
 * Iterating it row by row is the ordinary way, `batches()` is the fast
 * way when the work is per batch rather than per row, and
 * `toReadableStream()` is for handing rows to anything that already
 * speaks Web Streams. All three read the same statement once, so a
 * stream is used one of the three ways rather than two.
 *
 * Ending it early is the case worth knowing about: a `break` out of the
 * loop, a `return()` on the iterator, a `cancel()`, or leaving the block
 * of an `await using` all stop the statement and wait for it to let go
 * of the connection.
 *
 * A class rather than an interface, so that a program passing streams
 * around can name the type and ask `instanceof`. It is not constructed
 * directly: a stream is a statement, and a statement comes from a
 * connection.
 */
export declare class ZuStream<Row = Record<string, ZuValue>> implements AsyncIterable<Row>, AsyncDisposable {
  private constructor()
  /** The projection, `null` until the first batch has arrived. */
  readonly columns: string[] | null
  /** What the statement did, `null` until it has ended. */
  readonly summary: ZuSummary | null
  /**
   * The rows a batch at a time, which is the shape they cross the
   * boundary in.
   */
  batches(): AsyncIterableIterator<ZuBatch<Row>>
  [Symbol.asyncIterator](): AsyncIterableIterator<Row>
  /**
   * The same rows as a Web Stream, one row per chunk, pulled a batch at
   * a time.
   */
  toReadableStream(): ReadableStream<Row>
  /** Stops the statement and waits for it to let go of the connection. */
  cancel(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Whether a caught value is a failure from this client.
 *
 * A `catch` gives you `unknown`, and this is the guard that narrows it.
 * It tests the two things every zu failure has and nothing else does: a
 * name in the family, and a `retryable` that says whether running the
 * same statement again could work. An `AbortError` from a signal is not
 * one of these, which is the point, since it came from the caller rather
 * than from the database.
 */
export declare function isZuError(value: unknown): value is ZuError
