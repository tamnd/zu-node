// The same package, as an ES module.
//
// A native addon is a CommonJS thing: what loads it is `process.dlopen`
// through `require`, and there is no import that does it. So this file
// is what an ES module import of the package reaches, and it takes the
// same surface out of the CommonJS one rather than repeating it. There
// is one implementation of everything and two ways of naming it.
//
// Named exports only, and no default. A default export of a namespace is
// a second spelling of every name in the package, and the two spellings
// then differ by bundler, by `esModuleInterop`, and by whether the file
// doing the importing is itself a module.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const zudb = require('./zudb.cjs')

export const connect = zudb.connect
export const version = zudb.version
export const abiVersion = zudb.abiVersion
export const isZuError = zudb.isZuError
export const Connection = zudb.Connection
export const Transaction = zudb.Transaction
export const ZuStream = zudb.ZuStream
export const ZuCursor = zudb.ZuCursor
export const ZuDate = zudb.ZuDate
export const ZuTime = zudb.ZuTime
export const ZuTimestamp = zudb.ZuTimestamp
export const ZuDuration = zudb.ZuDuration
export const ZuNode = zudb.ZuNode
export const ZuRel = zudb.ZuRel
