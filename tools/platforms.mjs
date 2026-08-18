// The platforms this package ships a binary for, in one place.
//
// These are the tier 1 rows of platforms.toml in tamnd/zu, plus Windows
// on arm64, which is tier 2 there and cheap here because the runner
// exists. The release workflow builds this list, the test suite holds
// package.json and the npm directories to it, and the tool beside this
// one checks that every row ended up with a binary in it.
//
// The mapping from a Rust target triple to npm's `os`, `cpu` and `libc`
// is a table of facts rather than something to derive. A wrong entry is
// a package that installs on the wrong machine and fails at the
// require, which is the one failure a user cannot do anything about.
export const PLATFORMS = [
  {
    target: 'x86_64-unknown-linux-gnu',
    dir: 'linux-x64-gnu',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
  },
  {
    target: 'aarch64-unknown-linux-gnu',
    dir: 'linux-arm64-gnu',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
  },
  {
    target: 'x86_64-unknown-linux-musl',
    dir: 'linux-x64-musl',
    os: 'linux',
    cpu: 'x64',
    libc: 'musl',
  },
  {
    target: 'aarch64-unknown-linux-musl',
    dir: 'linux-arm64-musl',
    os: 'linux',
    cpu: 'arm64',
    libc: 'musl',
  },
  {
    target: 'aarch64-apple-darwin',
    dir: 'darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    libc: null,
  },
  {
    target: 'x86_64-apple-darwin',
    dir: 'darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    libc: null,
  },
  {
    target: 'x86_64-pc-windows-msvc',
    dir: 'win32-x64-msvc',
    os: 'win32',
    cpu: 'x64',
    libc: null,
  },
  {
    target: 'aarch64-pc-windows-msvc',
    dir: 'win32-arm64-msvc',
    os: 'win32',
    cpu: 'arm64',
    libc: null,
  },
]

/// The row for the machine this is running on, which is the one package
/// an install here can use. glibc and musl are the same `process.platform`
/// and the same `process.arch`, and the only thing in Node that tells them
/// apart is whether the process reports a glibc it was linked against.
export function hostPlatform() {
  const os = process.platform
  const cpu = process.arch
  const libc = os !== 'linux' ? null : process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'

  const found = PLATFORMS.find(
    (platform) => platform.os === os && platform.cpu === cpu && platform.libc === libc,
  )
  if (!found) throw new Error(`no platform row for ${os} ${cpu}${libc ? ` ${libc}` : ''}`)
  return found
}

/// The row for a target triple, or a failure naming what was asked for.
export function platformOf(target) {
  const found = PLATFORMS.find((platform) => platform.target === target)
  if (!found) throw new Error(`no platform row for ${target}`)
  return found
}

/// What the addon for a platform is called, which is the name the
/// loader looks for and the only file its package publishes.
export function binaryOf(platform) {
  return `zudb.${platform.dir}.node`
}
