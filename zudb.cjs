// The package, as CommonJS.
//
// The file the binding generator writes is a loader: it works out which
// platform package holds the addon for this machine, dlopens it, and
// re-exports whatever the addon registered. This file is the package's
// own surface over it, which is where anything written in JavaScript
// rather than in Rust belongs, and it is what both `require('zudb')` and
// `import 'zudb'` end at.
//
// Every name is listed one at a time rather than spread across, because
// the list is the API. A spread would publish whatever the addon happens
// to register, which is how a helper meant for a test ends up as
// something somebody depends on.

const binding = require('./binding.cjs')

/**
 * A statement read a batch at a time.
 *
 * The cursor underneath is a pull: one call, one batch, `null` at the
 * end. Everything a program actually writes is here rather than in
 * Rust, because iteration, early exit and Web Streams are JavaScript
 * shapes, and the native side of a `for await` that breaks halfway is
 * a lot of machinery for something the language already has.
 *
 * A stream is read once. All three ways of reading it are the same
 * statement, so taking two of them gets two halves of one result.
 */
class ZuStream {
  #cursor
  #columns = null
  #summary = null
  #ended = false

  constructor(cursor) {
    this.#cursor = cursor
  }

  /** The projection, once the first batch has arrived. */
  get columns() {
    return this.#columns
  }

  /** What the statement did, once it has ended. */
  get summary() {
    return this.#summary
  }

  /**
   * The rows a batch at a time, which is the shape they cross the
   * boundary in.
   *
   * The `finally` is the whole reason this is a generator: a `break`
   * out of a `for await`, a `throw` inside it and a `return()` on the
   * iterator all end up there, and all three mean the reader has gone
   * and the statement should stop rather than scan a database nobody
   * is reading.
   */
  async *batches() {
    try {
      for (;;) {
        const batch = await this.#cursor.next()
        if (batch === null) {
          this.#done()
          return
        }
        this.#columns ??= batch.columns
        yield batch
      }
    } finally {
      if (!this.#ended) await this.cancel()
    }
  }

  async *[Symbol.asyncIterator]() {
    for await (const batch of this.batches()) yield* batch
  }

  /**
   * The same rows as a Web Stream, one row per chunk.
   *
   * Pulled a batch at a time and enqueued a row at a time, so the
   * backpressure is the reader's: nothing is pulled from the database
   * until the queue in front of it has drained. A `cancel()` on the
   * stream, which is what a `pipeTo` that fails does, stops the
   * statement.
   */
  toReadableStream() {
    const batches = this.batches()
    return new ReadableStream({
      async pull(controller) {
        const { value, done } = await batches.next()
        if (done) {
          controller.close()
          return
        }
        for (const row of value) controller.enqueue(row)
      },
      async cancel() {
        await batches.return()
      },
    })
  }

  /** Stops the statement and waits for it to let go of the connection. */
  async cancel() {
    this.#ended = true
    await this.#cursor.cancel()
    this.#summary ??= this.#cursor.summary
  }

  async [Symbol.asyncDispose]() {
    await this.cancel()
  }

  #done() {
    this.#ended = true
    this.#summary = this.#cursor.summary
    this.#columns ??= this.#summary?.columns ?? null
  }
}

/**
 * `conn.stream(...)`, which is a method of the native class written in
 * JavaScript.
 *
 * On the prototype rather than in the class, because the class is
 * registered by the addon and there is nowhere in Rust to write a
 * method whose body is a JavaScript generator. Not enumerable, like
 * every other method of a class, so it does not turn up in a
 * `for...in` over a connection.
 */
Object.defineProperty(binding.Connection.prototype, 'stream', {
  value: function stream(statement, params, options) {
    return new ZuStream(this.cursor(statement, params, options))
  },
  writable: true,
  configurable: true,
})

/**
 * Whether a caught value is a failure from this client.
 *
 * A `catch` in TypeScript gives you `unknown`, and this is the guard
 * that narrows it. It tests the two things every zu failure has and
 * nothing else does: a name in the family, and a `retryable` that says
 * whether running the same statement again could work. An `AbortError`
 * from a signal is not one of these, which is the point, since it came
 * from the caller rather than from the database.
 */
function isZuError(value) {
  return (
    value instanceof Error &&
    typeof value.name === 'string' &&
    value.name.startsWith('Zu') &&
    typeof value.retryable === 'boolean'
  )
}

module.exports = {
  connect: binding.connect,
  load: binding.load,
  version: binding.version,
  abiVersion: binding.abiVersion,
  isZuError,
  Connection: binding.Connection,
  Transaction: binding.Transaction,
  Appender: binding.Appender,
  ZuStream,
  // The pull underneath a stream, which `conn.cursor(...)` hands back
  // and almost nobody should be holding. It is here because it is in
  // the types either way, and a name that types can see and `require`
  // cannot is a program that compiles and then throws.
  ZuCursor: binding.ZuCursor,
  ZuDate: binding.ZuDate,
  ZuTime: binding.ZuTime,
  ZuTimestamp: binding.ZuTimestamp,
  ZuDuration: binding.ZuDuration,
  ZuNode: binding.ZuNode,
  ZuRel: binding.ZuRel,
}
