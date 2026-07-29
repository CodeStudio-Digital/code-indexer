//! Production process composition for the Windows protected bootstrap.
//!
//! The process accepts exactly the protected Host and completes Hello. Attempt
//! preparation remains fail-closed until the authenticated data-channel
//! hydration adapter lands.

use std::convert::Infallible;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;

use agent_platform::ipc::endpoint_cancellation;

use crate::bootstrap::{
    RunnerControlTransitionError, RunnerPhysicalBootstrapError,
    materialize_inherited_windows_bootstrap,
};

/// Failure before the runner owns a prepared control launch.
#[derive(Debug)]
pub enum RunnerProcessStartError {
    Runtime(io::Error),
    PhysicalBootstrap(RunnerPhysicalBootstrapError),
    ControlTransition(RunnerControlTransitionError),
    Control(Box<dyn Error + Send + Sync>),
    UnexpectedActivation,
}

/// Consumes the inherited protected handoff and starts the Host control pump.
///
/// Successful execution does not return before the supervisor terminates the
/// single-tenant process. Hello, data binding, and bounded hydration are real;
/// productive effect dispatch remains fail-closed after activation.
///
/// # Errors
///
/// Rejects a missing/malformed inherited bootstrap, invalid supervisor
/// identity, endpoint materialization failure, or control-authority mismatch.
pub fn run_inherited_windows() -> Result<Infallible, RunnerProcessStartError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(RunnerProcessStartError::Runtime)?;
    let materialized = {
        let _runtime_guard = runtime.enter();
        materialize_inherited_windows_bootstrap()
            .map_err(RunnerProcessStartError::PhysicalBootstrap)?
    };
    let prepared = materialized
        .prepare_control_launch()
        .map_err(RunnerProcessStartError::ControlTransition)?;
    let agent_hello = prepared
        .protected_agent_hello_draft()
        .map_err(RunnerProcessStartError::ControlTransition)?;
    let (cancellation_authority, mut cancellation) = endpoint_cancellation();
    let outcome = runtime.block_on(async move {
        let outcome = Box::pin(prepared.accept_and_activate(agent_hello, &mut cancellation)).await;
        drop(cancellation_authority);
        outcome
    });
    match outcome {
        Ok(active) => {
            drop(active.revoke());
            Err(RunnerProcessStartError::UnexpectedActivation)
        }
        Err(error) => Err(RunnerProcessStartError::Control(Box::new(error))),
    }
}

impl Display for RunnerProcessStartError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime(_) => formatter.write_str("cannot create runner I/O runtime"),
            Self::PhysicalBootstrap(_) => formatter.write_str("protected runner bootstrap failed"),
            Self::ControlTransition(_) => {
                formatter.write_str("runner control authority transition failed")
            }
            Self::Control(_) => formatter.write_str("runner control service stopped"),
            Self::UnexpectedActivation => {
                formatter.write_str("runner activated without a production hydration port")
            }
        }
    }
}

impl Error for RunnerProcessStartError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Runtime(source) => Some(source),
            Self::PhysicalBootstrap(source) => Some(source),
            Self::ControlTransition(source) => Some(source),
            Self::Control(source) => Some(source.as_ref()),
            Self::UnexpectedActivation => None,
        }
    }
}
