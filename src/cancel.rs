//! An `AbortSignal`, wired to the statement it is meant to stop.
//!
//! Cancellation in JavaScript has one shape and every library uses it,
//! so a statement takes an `AbortSignal` rather than a handle of its
//! own: the timeout a caller already has from `AbortSignal.timeout`, the
//! signal a web framework hands a request handler, and the one a caller
//! composes with `AbortSignal.any` all work here without anything being
//! adapted. What arrives on the other side is the engine's interrupt,
//! which is one word the executor reads at a boundary it was already
//! stopping at, so a statement that is asked to stop does so within a
//! vector of rows and leaves the connection exactly as it was.
//!
//! Two things make this harder than adding a listener. The interrupt
//! belongs to the connection rather than to the statement, so a stop
//! raised a moment too late would end the next statement instead of the
//! one it was meant for. And a signal can fire before the statement
//! reaches the thread it runs on, which is a stop nobody is there to
//! hear. Both are answered the same way: the listener and the statement
//! share two words and set them in the opposite order, so whichever of
//! them is second sees what the other did.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use napi::{Env, ValueType};
use zudb::Interrupt;

/// The two words a listener and a statement share.
///
/// `asked` is set by the listener and read by the statement, `running`
/// the other way about. Both are sequentially consistent, which is what
/// makes the pair work: the listener sets `asked` before it reads
/// `running`, the statement sets `running` before it reads `asked`, and
/// an ordering where neither sees the other is one this ordering
/// forbids.
#[derive(Debug)]
struct Shared {
    asked: AtomicBool,
    running: AtomicBool,
    interrupt: Interrupt,
}

impl Shared {
    /// The listener's half: say that somebody asked, then stop the
    /// statement if one is running.
    fn ask(&self) {
        self.asked.store(true, Ordering::SeqCst);
        if self.running.load(Ordering::SeqCst) {
            self.interrupt.stop();
        }
    }
}

/// A signal watching one statement.
///
/// It is made on the thread that owns the runtime, because that is the
/// only thread that may add a listener, and it is taken apart there too.
pub struct Watch {
    shared: Arc<Shared>,
    /// Kept so the reason can be read when the statement gives up, and
    /// so the listener can be taken off again.
    signal: ObjectRef,
    listener: FunctionRef<(), ()>,
}

impl Watch {
    /// Watches `signal`, and stops `interrupt` when it fires.
    ///
    /// A signal that has already fired is still watched rather than
    /// refused here, so that one place decides what an aborted statement
    /// does and the answer does not depend on how early the caller was.
    pub fn new(env: &Env, signal: Object<'_>, interrupt: Interrupt) -> Result<Watch> {
        let shared = Arc::new(Shared {
            asked: AtomicBool::new(signal.get_named_property::<bool>("aborted")?),
            running: AtomicBool::new(false),
            interrupt,
        });

        let held = Arc::clone(&shared);
        let listener: Function<'_, (), ()> =
            env.create_function_from_closure("abort", move |_| {
                held.ask();
                Ok(())
            })?;

        let mut once = Object::new(env)?;
        once.set("once", true)?;
        // `FnArgs` rather than the tuple on its own, because a bare tuple
        // is one argument to napi and a JavaScript function called with
        // one argument that happens to be three values is a function
        // called wrongly. The failure that teaches this is
        // `addEventListener` complaining that its arguments were not
        // specified while three of them sit in the call.
        let add: Function<'_, FnArgs<(Unknown<'_>, Unknown<'_>, Unknown<'_>)>, Unknown<'_>> =
            signal.get_named_property("addEventListener")?;
        add.apply(
            signal,
            (
                env.create_string("abort")?.into_unknown(env)?,
                listener.into_unknown(env)?,
                once.into_unknown(env)?,
            )
                .into(),
        )?;

        Ok(Watch {
            shared,
            signal: signal.create_ref()?,
            listener: listener.create_ref()?,
        })
    }

    /// The statement is about to run. `false` means it must not: the
    /// signal fired first.
    pub fn enter(&self) -> bool {
        self.shared.running.store(true, Ordering::SeqCst);
        !self.shared.asked.load(Ordering::SeqCst)
    }

    /// The statement is done with the connection.
    ///
    /// The flag goes down first, so a signal firing now raises nothing,
    /// and then the interrupt is put back down, so a stop that landed in
    /// the moment between the statement finishing and this call cannot
    /// end whatever runs next on the same connection.
    pub fn leave(&self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.interrupt.clear();
    }

    /// Whether the signal fired at all, which is what tells an interrupt
    /// the caller asked for apart from one they did not.
    pub fn asked(&self) -> bool {
        self.shared.asked.load(Ordering::SeqCst)
    }

    /// What the signal gives as its reason, if it gives one.
    ///
    /// Every runtime sets a reason on a signal that has fired, an
    /// `AbortError` when the caller named nothing of their own, so this
    /// is almost always something. It is an option rather than a promise
    /// of one because a rejection with `undefined` in it is worse than
    /// the plain sentence this client would write instead.
    pub fn reason<'env>(&self, env: &'env Env) -> Option<Unknown<'env>> {
        let signal = self.signal.get_value(env).ok()?;
        let reason: Unknown<'env> = signal.get_named_property("reason").ok()?;
        match reason.get_type() {
            Ok(ValueType::Undefined) | Ok(ValueType::Null) | Err(_) => None,
            Ok(_) => Some(reason),
        }
    }

    /// Takes the listener off the signal and releases both references.
    ///
    /// A signal outlives the statement it stopped, often by the length
    /// of a whole request, and a listener left on one is a statement's
    /// worth of memory that never goes away. This is why the statement
    /// keeps the function it added rather than adding a fresh closure
    /// and hoping `once` covers it: `once` only fires for a signal that
    /// aborts, and most of them never do.
    pub fn release(self, env: &Env) -> Result<()> {
        let signal = self.signal.get_value(env)?;
        let listener = self.listener.borrow_back(env)?;
        let remove: Function<'_, FnArgs<(Unknown<'_>, Unknown<'_>)>, Unknown<'_>> =
            signal.get_named_property("removeEventListener")?;
        remove.apply(
            signal,
            (
                env.create_string("abort")?.into_unknown(env)?,
                listener.into_unknown(env)?,
            )
                .into(),
        )?;

        // The function's reference releases itself when it drops, on
        // this thread or through the environment's own collector if it
        // ever drops on another. The object's does not, and says so on
        // stderr when it is forgotten, so it is released here.
        self.signal.unref(env)
    }
}
