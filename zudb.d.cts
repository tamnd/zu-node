/* The types for `require('zudb')`. */

import type { ZuError } from './binding.cjs'

export * from './binding.cjs'

/**
 * `await using` on a connection, in the types as well as at runtime.
 *
 * The disposal is put on every connection as it is made, under the key
 * `await using` looks up. It cannot be declared where the rest of the
 * class is, because the generator writes that file from the Rust and a
 * method's name there is a string while this key is a symbol.
 */
declare module './binding.cjs' {
  interface Connection extends AsyncDisposable {}
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
