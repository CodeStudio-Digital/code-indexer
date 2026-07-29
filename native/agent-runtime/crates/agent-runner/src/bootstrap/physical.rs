//! Physical Windows bootstrap composition for the runner process.

use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_platform::windows::bootstrap::open_inherited_windows_bootstrap;
use agent_protocol::runner_bootstrap::{
    RunnerPhysicalBootstrapReceiver, ShapeValidatedRunnerLaunchHandoff,
};

use super::{
    MaterializedRunnerBootstrap, PreparedMaterializedRunnerBootstrap, RunnerMaterializationError,
    prepare_materialized_windows_bootstrap,
};

mod error;

pub use error::RunnerPhysicalBootstrapError;

/// Opens the inherited one-shot channel and materializes all runner listeners.
///
/// The current time is sampled only after the handoff has been received and
/// its physical pipe creator has matched the expected supervisor PID.
///
/// # Errors
///
/// Any open, receive, authority, clock, bind, write, or flush failure consumes
/// the bootstrap resources and produces no materialized owner.
pub fn materialize_inherited_windows_bootstrap()
-> Result<MaterializedRunnerBootstrap, RunnerPhysicalBootstrapError> {
    let bootstrap =
        open_inherited_windows_bootstrap().map_err(RunnerPhysicalBootstrapError::BootstrapOpen)?;
    let creator_process_id = bootstrap.creator_process_id();
    let (reader, writer) = bootstrap.into_parts();
    materialize_windows_bootstrap_with(
        creator_process_id,
        reader,
        writer,
        sample_observed_at_unix_ms,
        prepare_materialized_windows_bootstrap,
    )
}

pub(super) fn materialize_windows_bootstrap_with<R, W, O, M>(
    creator_process_id: u32,
    reader: R,
    writer: W,
    observe_now: O,
    materialize: M,
) -> Result<MaterializedRunnerBootstrap, RunnerPhysicalBootstrapError>
where
    R: Read,
    W: Write,
    O: FnOnce() -> Result<i64, RunnerPhysicalBootstrapError>,
    M: FnOnce(
        ShapeValidatedRunnerLaunchHandoff,
        i64,
    ) -> Result<PreparedMaterializedRunnerBootstrap, RunnerMaterializationError>,
{
    let received = RunnerPhysicalBootstrapReceiver::new(reader, writer)
        .receive()
        .map_err(RunnerPhysicalBootstrapError::HandoffReceive)?;
    let (handoff, ready_transport) = received.into_parts();
    verify_supervisor_creator(&handoff, creator_process_id)?;
    let observed_at_unix_ms = observe_now()?;
    let prepared = materialize(handoff, observed_at_unix_ms)
        .map_err(RunnerPhysicalBootstrapError::Materialization)?;
    prepared
        .commit_ready_with(|bytes| ready_transport.send_raw(bytes))
        .map_err(RunnerPhysicalBootstrapError::ReadyCommit)
}

fn verify_supervisor_creator(
    handoff: &ShapeValidatedRunnerLaunchHandoff,
    creator_process_id: u32,
) -> Result<(), RunnerPhysicalBootstrapError> {
    let expected = handoff
        .metadata()
        .expected_supervisor_peer
        .as_ref()
        .ok_or(RunnerPhysicalBootstrapError::ExpectedSupervisorMissing)?;
    if expected.process_id != creator_process_id {
        return Err(RunnerPhysicalBootstrapError::CreatorProcessMismatch {
            expected: expected.process_id,
            actual: creator_process_id,
        });
    }
    Ok(())
}

fn sample_observed_at_unix_ms() -> Result<i64, RunnerPhysicalBootstrapError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(RunnerPhysicalBootstrapError::ClockBeforeUnixEpoch)?;
    i64::try_from(elapsed.as_millis()).map_err(|_| RunnerPhysicalBootstrapError::ClockOverflow)
}
