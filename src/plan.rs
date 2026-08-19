//! What a statement would do, and what it did.
//!
//! ```js
//! console.log((await conn.explain('MATCH (p:person) RETURN p.id AS id')).text)
//! console.log((await conn.profile('MATCH (p:person) RETURN p.id AS id')).text)
//! ```
//!
//! Two calls with one shape between them. `explain` compiles and stops,
//! so it costs the compile and answers the operators the statement would
//! have run. `profile` runs it with the counters on and answers the same
//! operators with what each of them really did: how many times it was
//! pulled, how many rows it produced, how many the optimizer thought it
//! would, and where the wall clock went.
//!
//! ## Why both a tree and a string
//!
//! The two questions a plan gets asked want different answers. A person
//! looking at a slow query wants the listing, indented, the way every
//! database prints one, and building that out of a tree in JavaScript is
//! twenty lines nobody should write twice. A program asking whether the
//! scan reached an index, how deep the expands go, or which tables a
//! statement touches wants operators it can walk.
//!
//! So both are here, and `text` is the engine's own rendering of the
//! same tree rather than something this client assembles, which is what
//! keeps the two from drifting: the listing a Node program prints is
//! character for character the listing the shell prints.
//!
//! ## The numbers
//!
//! Counts are `number` and not `bigint`, which is the one place this
//! client spells an integer as a double on purpose. Nothing a profile
//! counts comes near 2^53: a statement that pulled nine quadrillion rows
//! is not a statement anybody is profiling. Times are nanoseconds, as
//! integers, for the same reason and with a lot more room.
//!
//! `estimate` and `bound` are null where the optimizer had nothing to
//! say, which is the operators that pass their input through rather than
//! producing rows of their own, and `qerror` is null wherever `estimate`
//! is. Where it is a number it is `max(estimate/rows, rows/estimate)`
//! with both sides floored at one row, so an operator the optimizer got
//! right is 1 and the one to look at is the one furthest from it.

use napi::bindgen_prelude::*;
use napi::{Env, ScopedTask};
use zudb::query::Value;
use zudb::{OpProfile, PlanNode, Profile, QueryPlan, StageProfile, ZuError};

use crate::cancel::Watch;
use crate::conn::{Failure, Handles, failed, with};

/// Compiling a statement to see what it would do.
pub struct PlanTask {
    handles: Handles,
    statement: String,
    /// Why this is not going to run, when it is not.
    refused: Option<String>,
}

impl PlanTask {
    pub(crate) fn new(handles: Handles, statement: String, refused: Option<String>) -> PlanTask {
        PlanTask {
            handles,
            statement,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for PlanTask {
    type Output = std::result::Result<QueryPlan, Failure>;
    type JsValue = Object<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let statement = self.statement.clone();
        let handles = &self.handles;
        Ok(with(
            &handles.inner,
            &handles.alive,
            &handles.in_txn,
            |conn| Ok(conn.explain_plan(&statement)?),
        ))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let plan = output.map_err(|failure| failed(env, failure, None))?;
        planned(env, &plan)
    }
}

/// Running one with the counters on.
pub struct ProfileTask {
    handles: Handles,
    statement: String,
    params: Vec<(String, Value)>,
    /// The signal watching this run, when the caller gave one.
    watch: Option<Watch>,
    refused: Option<String>,
}

impl ProfileTask {
    pub(crate) fn new(
        handles: Handles,
        statement: String,
        params: Vec<(String, Value)>,
        watch: Option<Watch>,
        refused: Option<String>,
    ) -> ProfileTask {
        ProfileTask {
            handles,
            statement,
            params,
            watch,
            refused,
        }
    }
}

impl<'task> ScopedTask<'task> for ProfileTask {
    type Output = std::result::Result<Profile, Failure>;
    type JsValue = Object<'task>;

    fn compute(&mut self) -> Result<Self::Output> {
        if let Some(message) = self.refused.take() {
            return Ok(Err(Failure::Usage(message)));
        }
        let (statement, params, watch) = (&self.statement, &self.params, &self.watch);
        let handles = &self.handles;
        Ok(with(
            &handles.inner,
            &handles.alive,
            &handles.in_txn,
            move |conn| {
                // A profile is a run, so it is stoppable exactly the way
                // a run is: the signal is entered when the connection
                // becomes this call's and left when it stops being.
                if let Some(watch) = watch
                    && !watch.enter()
                {
                    watch.leave();
                    return Err(Failure::Aborted);
                }
                let params: Vec<(&str, Value)> = params
                    .iter()
                    .map(|(name, value)| (name.as_str(), value.clone()))
                    .collect();
                let out = conn.profile(statement, &params);
                if let Some(watch) = watch {
                    watch.leave();
                    if watch.asked() && matches!(out, Err(ZuError::Interrupted)) {
                        return Err(Failure::Aborted);
                    }
                }
                Ok(out?)
            },
        ))
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue> {
        let profile = output.map_err(|failure| failed(env, failure, self.watch.as_ref()))?;
        profiled(env, &profile)
    }

    fn finally(mut self, env: Env) -> Result<()> {
        match self.watch.take() {
            Some(watch) => watch.release(&env),
            None => Ok(()),
        }
    }
}

/// A whole plan as the object a caller reads.
fn planned<'env>(env: &'env Env, plan: &QueryPlan) -> Result<Object<'env>> {
    let mut object = Object::new(env)?;
    object.set(
        "root",
        match &plan.root {
            Some(root) => Some(operator(env, root)?),
            None => None,
        },
    )?;
    object.set("columns", strings(env, &plan.columns)?)?;
    object.set("params", strings(env, &plan.params)?)?;
    object.set("notes", strings(env, &plan.notes)?)?;
    let mut scalars = env.create_array(plan.scalars.len() as u32)?;
    for (ix, scalar) in plan.scalars.iter().enumerate() {
        let mut held = Object::new(env)?;
        held.set("reads", strings(env, &scalar.reads)?)?;
        held.set("exists", scalar.exists)?;
        held.set("plan", planned(env, &scalar.plan)?)?;
        scalars.set(ix as u32, held)?;
    }
    object.set("scalars", scalars)?;
    // Rendered by the engine rather than assembled here, so the listing
    // a program prints is the listing the shell prints.
    object.set("text", plan.render())?;
    Ok(object)
}

/// One operator and everything under it.
///
/// `op` is the operator and `name` is what the listing calls it, which
/// differ only where the operator sits inside a bracket: an OPTIONAL
/// MATCH expand is an `Expand` named `OptionalExpand`. A program
/// grouping by operator wants the first and a program printing wants the
/// second, so both are here and neither has to be derived.
fn operator<'env>(env: &'env Env, node: &PlanNode) -> Result<Object<'env>> {
    let mut object = Object::new(env)?;
    object.set("op", node.op)?;
    object.set("name", node.name())?;
    object.set("bracket", node.bracket.as_ref().map(|b| b.prefix()))?;
    object.set("detail", node.detail.as_str())?;
    object.set("binds", strings(env, &node.binds)?)?;
    object.set("tables", strings(env, &node.tables)?)?;
    let mut children = env.create_array(node.children.len() as u32)?;
    for (ix, child) in node.children.iter().enumerate() {
        children.set(ix as u32, operator(env, child)?)?;
    }
    object.set("children", children)?;
    Ok(object)
}

/// A whole profile as the object a caller reads.
fn profiled<'env>(env: &'env Env, profile: &Profile) -> Result<Object<'env>> {
    let mut stages = env.create_array(profile.stages.len() as u32)?;
    for (ix, stage) in profile.stages.iter().enumerate() {
        stages.set(ix as u32, staged(env, stage)?)?;
    }
    let mut object = Object::new(env)?;
    object.set("stages", stages)?;
    // The stages end to end, which is what a caller comparing two runs
    // reaches for and the one number the engine's own listing does not
    // print on a line of its own.
    object.set(
        "nanos",
        profile.stages.iter().map(|stage| stage.nanos).sum::<u64>() as f64,
    )?;
    object.set("text", profile.render())?;
    Ok(object)
}

/// One stage: the operators bottom-up and the sink that took their rows.
fn staged<'env>(env: &'env Env, stage: &StageProfile) -> Result<Object<'env>> {
    let mut ops = env.create_array(stage.ops.len() as u32)?;
    for (ix, op) in stage.ops.iter().enumerate() {
        ops.set(ix as u32, counted(env, op)?)?;
    }
    let mut object = Object::new(env)?;
    object.set("sink", stage.sink.as_str())?;
    object.set("rows", stage.out_rows as f64)?;
    object.set("nanos", stage.nanos as f64)?;
    object.set("ops", ops)?;
    Ok(object)
}

/// One operator and what the counters saw of it.
fn counted<'env>(env: &'env Env, op: &OpProfile) -> Result<Object<'env>> {
    let mut object = Object::new(env)?;
    object.set("op", op.kind)?;
    object.set("detail", op.detail.as_str())?;
    object.set("pulls", op.pulls as f64)?;
    object.set("rows", op.rows as f64)?;
    // What the vectors stand for with the factorization multiplied out,
    // which is the count to compare against an estimate: on a chain it
    // is `rows` and on a star it is the product of the vectors beside
    // this one, and the optimizer was estimating the latter.
    object.set("flat", op.flat as f64)?;
    object.set("estimate", op.est)?;
    object.set("bound", op.bnd)?;
    object.set("nanos", op.nanos as f64)?;
    object.set("qerror", op.qerror())?;
    Ok(object)
}

/// A list of names, which is most of what a plan is made of.
fn strings<'env>(env: &'env Env, held: &[String]) -> Result<Array<'env>> {
    Array::from_ref_vec_string(env, held)
}
