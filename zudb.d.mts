/* The types for `import ... from "zudb"`.
 *
 * The same declarations as the CommonJS ones, taken from them rather
 * than written twice, because two copies of a public API are two things
 * that drift. A resolver following the `import` condition lands here,
 * sees an ES module, and reads the types out of the file the `require`
 * condition lands on.
 */

export * from './zudb.cjs'
