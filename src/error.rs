//! Raising an engine condition as a JavaScript exception.
//!
//! What a caller catches is an ordinary `Error`, because that is what
//! `try`/`catch`, `unhandledRejection` and every logger in the
//! ecosystem already understand, and because a subclass of `Error`
//! built in a native addon is a class the addon has to keep working
//! across four runtimes for no gain the caller can see.
//!
//! What makes it a zu error is the fields it carries. Every field the
//! error model gives a binding is a property here, and none of them is
//! parsed back out of a message: `err.code` picks the branch,
//! `err.line` underlines the token, `err.retryable` decides whether a
//! retry loop goes round again. `err.name` is the condition's class
//! written out, so a stack trace says `ZuSyntaxError` rather than
//! `Error`, and `isZuError` in the TypeScript layer is the guard that
//! narrows the `unknown` a `catch` gives you.

use napi::bindgen_prelude::*;
use napi::{Env, Status, ValueType};
use zudb::ZuError;

/// Builds the exception for `err` and wraps it as the failure to
/// return.
///
/// Wrapped rather than thrown into the environment, because most of
/// what fails here fails inside a promise and a promise has to be
/// rejected rather than thrown out of. An `Error` built from a JS value
/// keeps a reference to it, and napi hands that same object back when
/// it rejects or throws, so every field survives either way and the
/// caller sees the object built here rather than a copy of its message.
pub fn raise(env: &Env, err: ZuError) -> Error {
    match build(env, &err).and_then(|object| object.into_unknown(env)) {
        Ok(value) => Error::from(value),
        // A failure to build the exception is reported as itself. A
        // condition that cannot be dressed up is still worth less than
        // a report that the dressing failed, since the second one is a
        // bug here and the first one is a bug in the caller's
        // statement.
        Err(broken) => broken,
    }
}

fn build<'env>(env: &'env Env, err: &ZuError) -> Result<Object<'env>> {
    let mut object = blank(env, name_for(err), &err.to_string())?;
    object.set("retryable", err.retryable())?;
    if let Some(status) = err.gqlstatus() {
        object.set("code", status.code())?;
        object.set("condition", status.standard_text())?;
        object.set("severity", severity(status.severity()))?;
        object.set("docUrl", status.doc_url())?;
    }
    if let Some(at) = err.position() {
        object.set("line", at.line)?;
        object.set("column", at.column)?;
        object.set("offset", at.offset)?;
    }
    if let Some(excerpt) = err.excerpt() {
        object.set("excerpt", excerpt)?;
    }
    Ok(object)
}

/// The name a condition wears.
///
/// One name per GQLSTATUS class, which is what the two characters that
/// open a code are for: a caller that wants every one of the forty-two
/// conditions in class 22 tests one name rather than listing them, and
/// a condition zu adds to that class later answers to the same test.
fn name_for(err: &ZuError) -> &'static str {
    let Some(status) = err.gqlstatus() else {
        return match err {
            ZuError::Interrupted => "ZuInterrupted",
            ZuError::InvalidArgument(_) => "ZuUsageError",
            ZuError::Conflict(_) => "ZuTransactionError",
            // A file that is not there, or not readable, is the same
            // kind of thing as a database that cannot be reached, and
            // class 08 is what the standard calls that. Reporting a
            // missing path as an internal error would tell the caller
            // to file a bug about their own typo.
            ZuError::Io(_) => "ZuConnectionError",
            // And so is a file that is there and is not a database,
            // which is the same typo landing on a real file.
            ZuError::Corrupt { .. } => "ZuConnectionError",
            _ => "ZuInternalError",
        };
    };
    match status.class() {
        "08" => "ZuConnectionError",
        "22" => "ZuDataError",
        "25" | "2D" | "40" => "ZuTransactionError",
        "42" => "ZuSyntaxError",
        _ => "ZuError",
    }
}

/// The severity letter's name, because `"exception"` is what a person
/// reading a log understands and `X` is what the standard's table says.
fn severity(severity: zudb::Severity) -> &'static str {
    match severity {
        zudb::Severity::Success => "success",
        zudb::Severity::NoData => "noData",
        zudb::Severity::Warning => "warning",
        zudb::Severity::Informational => "informational",
        zudb::Severity::Exception => "exception",
    }
}

/// A mistake the program made, as the exception for one.
///
/// Not every failure comes from the engine. A call on a connection
/// that is closed, or a parameter of a type nothing here can bind, is
/// the caller's doing rather than a condition the standard has a code
/// for, and it says so by name: `ZuUsageError`, with no `code`, since
/// a caller mapping codes to branches has to be able to tell a missing
/// code from one it does not recognize.
pub fn usage(env: &Env, message: impl AsRef<str>) -> Error {
    match usage_object(env, message.as_ref()).and_then(|object| object.into_unknown(env)) {
        Ok(value) => Error::from(value),
        Err(broken) => broken,
    }
}

fn usage_object<'env>(env: &'env Env, message: &str) -> Result<Object<'env>> {
    let mut object = blank(env, "ZuUsageError", message)?;
    object.set("retryable", false)?;
    Ok(object)
}

/// A statement stopped by a signal that named no reason of its own.
///
/// Named `AbortError` rather than anything of this client's, because
/// that is the name every runtime gives the reason it makes for a signal
/// nobody gave one to, and a caller testing `err.name === 'AbortError'`
/// is testing the one thing that is true of both.
pub fn aborted(env: &Env, message: &str) -> Error {
    match aborted_object(env, message).and_then(|object| object.into_unknown(env)) {
        Ok(value) => Error::from(value),
        Err(broken) => broken,
    }
}

fn aborted_object<'env>(env: &'env Env, message: &str) -> Result<Object<'env>> {
    let mut object = blank(env, "AbortError", message)?;
    object.set("retryable", false)?;
    Ok(object)
}

/// An `Error` with a name, a message, a stack and nothing else on it yet.
///
/// napi writes the status it was handed into `code`, and `code` here is
/// the GQLSTATUS. A caller reading `err.code === '42001'` cannot be
/// given `GenericFailure` for a condition that has no code of its own,
/// so the one napi wrote is removed and the real one, when there is
/// one, is written in its place.
fn blank<'env>(env: &'env Env, name: &str, message: &str) -> Result<Object<'env>> {
    let mut object = env.create_error(Error::new(Status::GenericFailure, message.to_string()))?;
    object.delete_named_property("code")?;
    object.set("name", name)?;
    stacked(env, &mut object, name, message)?;
    Ok(object)
}

/// Gives the error a `stack` on a runtime that gave it none.
///
/// V8 writes one when the error is made, and for one made under a
/// statement it is the header line and nothing else, since there are no
/// JavaScript frames beneath a native call that is already running.
/// JavaScriptCore writes no `stack` at all through napi, so on Bun
/// `err.stack` is `undefined` and every logger that reaches for it
/// prints that word instead of the failure. The header line is what the
/// other runtimes have and it is what this writes, after the name, so
/// the first line says `ZuSyntaxError` on all four of them. An error
/// that arrived with a stack keeps the one it has, frames and all.
fn stacked(env: &Env, object: &mut Object<'_>, name: &str, message: &str) -> Result<()> {
    let existing: Unknown = object.get_named_property_unchecked("stack")?;
    if existing.get_type()? == ValueType::String {
        return Ok(());
    }
    // Defined rather than assigned, because the one V8 writes is not
    // enumerable and this one has to match: a plain assignment puts
    // `stack` in `Object.keys(err)`, and then every structured logger
    // that walks an error's own keys prints the trace as a field on one
    // runtime and not on the other three.
    let property = Property::new()
        .with_utf8_name("stack")?
        .with_napi_value(env, format!("{name}: {message}"))?
        .with_property_attributes(PropertyAttributes::Writable | PropertyAttributes::Configurable);
    object.define_properties(&[property])
}
