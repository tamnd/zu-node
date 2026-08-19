//! The zu client for JavaScript.
//!
//! zu is an embedded graph database, so this is not a driver: there is
//! no socket, no protocol and no server, and a statement runs in the
//! process that called it. What crosses the boundary is a value, and
//! the whole of this crate is about crossing it faithfully, which means
//! an INT64 arrives as a `bigint` (ADR 0003), a node arrives as a node
//! rather than as a shape a caller has to recognize, and a failure
//! arrives with its GQLSTATUS, its position and whether it is worth
//! retrying.
//!
//! The binding is napi-rs rather than the C ABI (ADR 0002). The ABI is
//! the specification of what a binding must mean and this one is graded
//! against the same conformance corpus, but a runtime is where the work
//! is: promises, disposal, streams and cancellation are all things the
//! ABI has nothing to say about and a JavaScript program cannot do
//! without.

mod append;
mod buffer;
mod cancel;
mod conn;
mod error;
mod frame;
mod load;
mod register;
mod stream;
mod temporal;
mod txn;
mod value;

/// The version of the client.
#[napi_derive::napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The revision of the C ABI this client implements the semantics of.
///
/// Not the same number as [`version`] and not meant to be: the ABI is
/// the specification every zu client is graded against, so this is what
/// says which edition of that specification the behaviour here matches,
/// and it moves when the specification does rather than when this crate
/// does.
#[napi_derive::napi]
pub fn abi_version() -> String {
    zudb::C_ABI_VERSION.to_string()
}
