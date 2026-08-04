use agent_platform::ipc::EndpointCancellation;
use agent_platform::windows::ipc::VerifiedWindowsEndpointStream;
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::ShapeValidatedRunnerLaunchHandoff;

use crate::control::{
    ActivationOutcome, ActiveRunnerLifetime, AsyncRunnerControlDriver, ControlDriverEvent,
    PrepareOutcome,
};

use super::data::PendingRunnerDataHydration;
use super::pulse::RunnerPulsePump;
use super::{ActiveRunnerControlLaunch, ActiveRunnerResources, RunnerControlServiceError};

mod hydration;

pub(super) struct PendingRunnerActivation {
    handoff: ShapeValidatedRunnerLaunchHandoff,
    data: Option<PendingRunnerDataHydration>,
    runner_pulse: RunnerPulsePump,
    resource_budget: wire::ResourceBudget,
    effective_containment: wire::ContainmentReport,
}

impl PendingRunnerActivation {
    pub(super) const fn new(
        handoff: ShapeValidatedRunnerLaunchHandoff,
        data: PendingRunnerDataHydration,
        runner_pulse: RunnerPulsePump,
        resource_budget: wire::ResourceBudget,
        effective_containment: wire::ContainmentReport,
    ) -> Self {
        Self {
            handoff,
            data: Some(data),
            runner_pulse,
            resource_budget,
            effective_containment,
        }
    }
}

pub(super) async fn pre_active(
    mut driver: AsyncRunnerControlDriver<VerifiedWindowsEndpointStream>,
    cancellation: &mut EndpointCancellation,
    mut pending: PendingRunnerActivation,
) -> Result<ActiveRunnerControlLaunch, RunnerControlServiceError> {
    let mut hydration = None;
    let mut data_channel = None;
    loop {
        let event = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                return Err(RunnerControlServiceError::Cancelled);
            }
            result = driver.receive_next() => {
                result.map_err(RunnerControlServiceError::Driver)?
            }
        };
        match event {
            ControlDriverEvent::Replayed(_)
            | ControlDriverEvent::Prepare(
                PrepareOutcome::AlreadyPrepared | PrepareOutcome::HydrationInProgress,
            ) => {
                // The control plane stays responsive while the stop-and-wait
                // data transaction owns its independent stream.
            }
            ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token)) => {
                pending
                    .runner_pulse
                    .transition(wire::RunnerPulsePhase::Hydrating, 1)?;
                let data = pending
                    .data
                    .take()
                    .ok_or(RunnerControlServiceError::HydrationAlreadyConsumed)?;
                let deadline = driver
                    .hard_deadline()
                    .map_err(RunnerControlServiceError::Driver)?;
                let request = super::hydration::RunnerHydrationRequest::new(
                    token.expected_snapshots().to_vec(),
                    token.expected_artifacts().to_vec(),
                    pending.resource_budget,
                );
                let completed = Box::pin(hydration::receive_with_terminal_guards(
                    cancellation,
                    data,
                    request,
                    deadline,
                ))
                .await?;
                let verified = completed.hydration;
                data_channel = Some(completed.channel);
                let facts = verified.effective_facts(
                    pending.resource_budget,
                    pending.effective_containment.clone(),
                    driver.owner_now_unix_ms(),
                );
                tokio::select! {
                    biased;
                    () = cancellation.cancelled() => {
                        return Err(RunnerControlServiceError::Cancelled);
                    }
                    result = driver.finish_prepare(token, facts) => {
                        result.map_err(RunnerControlServiceError::Driver)?;
                    }
                }
                hydration = Some(verified);
                pending
                    .runner_pulse
                    .transition(wire::RunnerPulsePhase::Prepared, 2)?;
            }
            ControlDriverEvent::Activate(
                ActivationOutcome::Activated | ActivationOutcome::AlreadyActive,
            ) => {
                let hydration = hydration
                    .take()
                    .ok_or(RunnerControlServiceError::MissingHydrationOwnership)?;
                let data = data_channel
                    .take()
                    .ok_or(RunnerControlServiceError::MissingHydrationOwnership)?;
                pending
                    .runner_pulse
                    .transition(wire::RunnerPulsePhase::Active, 3)?;
                return Ok(ActiveRunnerControlLaunch {
                    lifetime: ActiveRunnerLifetime::new(
                        driver,
                        ActiveRunnerResources {
                            handoff: pending.handoff,
                            data,
                            runner_pulse: pending.runner_pulse,
                            hydration,
                        },
                    )
                    .map_err(RunnerControlServiceError::Driver)?,
                });
            }
            ControlDriverEvent::Cancel(_) | ControlDriverEvent::Fence(_) => {
                return Err(RunnerControlServiceError::UnexpectedPreActiveTermination);
            }
        }
    }
}
