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
  version: binding.version,
  abiVersion: binding.abiVersion,
  isZuError,
  Connection: binding.Connection,
  ZuDate: binding.ZuDate,
  ZuTime: binding.ZuTime,
  ZuTimestamp: binding.ZuTimestamp,
  ZuDuration: binding.ZuDuration,
  ZuNode: binding.ZuNode,
  ZuRel: binding.ZuRel,
}
