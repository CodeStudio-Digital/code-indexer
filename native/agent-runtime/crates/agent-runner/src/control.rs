//! Single-attempt control plane for the native runner.
//!
//! This module owns the attempt control transport, authority, and lifecycle.
//! It contains no provider, tool, transcript, database, or child-process
//! implementation.

mod ack;
#[allow(
    dead_code,
    reason = "post-active lifetime remains unreachable before the Host control pump"
)]
mod active_lifetime;
#[allow(
    dead_code,
    reason = "internal async transition remains unreachable before the Host control pump"
)]
mod async_bootstrap;
#[allow(
    dead_code,
    reason = "internal async transition remains unreachable before the Host control pump"
)]
mod async_driver;
pub mod authority;
mod bootstrap;
mod driver;
mod effective;
mod error;
mod execution_seed;
mod hello;
mod launch;
mod manifest;
mod model;
mod session;
mod spec_validation;
mod validation;

pub(crate) use active_lifetime::{
    ActiveRunnerCleanup, ActiveRunnerLifetime, ActiveRunnerLifetimeAdvance,
};
pub(crate) use async_bootstrap::{AsyncRunnerBootstrapDriver, AsyncRunnerBootstrapError};
pub(crate) use async_driver::{AsyncControlDriverError, AsyncRunnerControlDriver};
#[cfg(test)]
pub(crate) use authority::AuthorityError;
pub use bootstrap::{RunnerBootstrapDriver, RunnerBootstrapError};
pub use driver::{ControlDriverError, ControlDriverEvent, RunnerControlDriver};
pub use error::{ControlError, TextFieldError};
pub(crate) use execution_seed::RunnerExecutionSeed;
pub use launch::{LaunchContextError, RunnerLaunchContext};
pub use model::{
    ActivationOutcome, CancelOutcome, CancelledAttempt, EffectivePreparedFacts, FenceOutcome,
    FencedAttempt, HydrationToken, PrepareOutcome,
};
pub use spec_validation::SpecValidationError;

pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 512;
pub const MAX_ACTIVATION_NONCE_BYTES: usize = 512;
pub const MAX_REASON_CODE_BYTES: usize = 128;
pub const MAX_RUNTIME_INSTANCE_ID_BYTES: usize = 512;

pub(crate) const CONTROL_PLANE_CONTRACT_VERSION: &str = "1.0.0";
pub(crate) const CONTROL_PLANE_SCHEMA_VERSION: u32 = 1;
pub(crate) const CONTROL_PROTOCOL_MAJOR: u32 = 1;
pub(crate) const CONTROL_PROTOCOL_MINOR: u32 = 1;

#[cfg(test)]
mod tests;
