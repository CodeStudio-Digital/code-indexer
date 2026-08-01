//! Production process composition for the Windows protected bootstrap.
//!
//! The process accepts exactly the protected Host, hydrates one attempt,
//! commits activation, and retains the active lifetime until a terminal guard
//! or the supervisor ends the single-tenant process.

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
    ActiveLifetimeEnded,
}

/// Consumes the inherited protected handoff and starts the Host control pump.
///
/// Successful execution does not return before the active lifetime terminates
/// or the supervisor reaps the single-tenant process. Productive provider,
/// tool, and effect dispatch remains fail-closed after activation.
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
        match Box::pin(prepared.accept_and_activate(agent_hello, &mut cancellation)).await {
            Ok(active) => {
                active.run_until_cleanup(&mut cancellation).await;
                drop(cancellation_authority);
                Ok(())
            }
            Err(error) => {
                drop(cancellation_authority);
                Err(error)
            }
        }
    });
    match outcome {
        Ok(()) => Err(RunnerProcessStartError::ActiveLifetimeEnded),
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
            Self::ActiveLifetimeEnded => formatter.write_str("active runner lifetime ended"),
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
            Self::ActiveLifetimeEnded => None,
        }
    }
}
