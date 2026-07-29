use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::{
    ManagementChannelError, PendingManagementInbound, ValidatedManagementPayload,
};

use super::cleanup::{FlooredLifecycleClock, LifecycleClockSampler};
use super::fact_flow::FactIntent;
use super::facts::{LaunchRejection, authority_rejection};
use super::plan::LaunchPlan;
use super::provision::{ProtectedLaunchProvisionPort, ProtectedLaunchRequest};
use super::reporting::PreparedLaunchEmission;
use super::{
    SupervisorDriverError, SupervisorDriverStep, SupervisorLifecycleCore, SupervisorPhysicalDriver,
};
use crate::management::SupervisorLifecycleClock;
use classification::LaunchDisposition;

mod async_phases;
mod classification;
mod operation;
pub(super) mod worker;

pub(in crate::management) use async_phases::{
    AsyncLaunchPrepareOutcome, AsyncLaunchSpawnOutcome, AsyncWorkerCompletion,
};
pub(in crate::management) use operation::{AsyncLaunchStart, PhysicalLaunchState};
pub(in crate::management) use worker::{
    PendingPhysicalLaunchWorker, PhysicalLaunchWorkerCommand, PhysicalLaunchWorkerEvent,
};

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn prepare_launch(
        &mut self,
        payload: &ValidatedManagementPayload,
        digest: [u8; 32],
        received_at_unix_ms: i64,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        if received_at_unix_ms <= 0 {
            return Err(super::state::CleanupStateError::InvalidTime.into());
        }
        if self
            .last_observed_at_unix_ms
            .is_some_and(|previous| received_at_unix_ms < previous)
        {
            return Err(super::state::CleanupStateError::ClockRegressed.into());
        }
        let launch = payload
            .launch_attempt_process()
            .ok_or(SupervisorDriverError::InvalidLaunchPlan)?;
        let plan = LaunchPlan::from_validated(launch, digest)
            .map_err(|_| SupervisorDriverError::InvalidLaunchPlan)?;
        let floored_clock = FlooredLifecycleClock::new(clock, received_at_unix_ms);
        let mut clock =
            LifecycleClockSampler::new_floored(&floored_clock, self.last_observed_at_unix_ms);
        let result = self.prepare_classified_launch(launch, &plan, &mut clock);
        self.last_observed_at_unix_ms = clock.last();
        result
    }

    fn prepare_classified_launch(
        &mut self,
        launch: &wire::LaunchAttemptProcess,
        plan: &LaunchPlan,
        clock: &mut LifecycleClockSampler<'_>,
    ) -> Result<PreparedLaunchEmission, SupervisorDriverError<P::Error>> {
        let key = plan.ownership_key();
        let observed_at_unix_ms = clock.sample()?;
        match self.classify_launch(plan, &key) {
            LaunchDisposition::Exact {
                intent_key,
                accepted,
                live_owner,
            } => {
                return self.prepare_existing_launch(
                    plan,
                    &key,
                    intent_key,
                    accepted,
                    live_owner,
                    observed_at_unix_ms,
                );
            }
            LaunchDisposition::Conflict => {
                return Ok(Self::prepare_launch_rejected(
                    plan,
                    FactIntent::Unregistered,
                    LaunchRejection::DuplicateConflict,
                    observed_at_unix_ms,
                ));
            }
            LaunchDisposition::Rejected {
                intent_key,
                rejection,
                rejected_at_unix_ms,
            } => {
                return Ok(Self::prepare_launch_rejected(
                    plan,
                    FactIntent::Registered(intent_key),
                    rejection,
                    rejected_at_unix_ms,
                ));
            }
            LaunchDisposition::Fresh => {}
        }
        if !self.state.is_accepting_launches() {
            return Ok(Self::prepare_launch_rejected(
                plan,
                FactIntent::Unregistered,
                LaunchRejection::AdmissionClosed,
                observed_at_unix_ms,
            ));
        }
        if !plan.trusted_provenance_matches(&self.trusted_runner) {
            return Ok(Self::prepare_launch_rejected(
                plan,
                FactIntent::Unregistered,
                LaunchRejection::ProvenanceDenied,
                observed_at_unix_ms,
            ));
        }
        let Some(intent) = self.launch_registry.reserve(plan, key.clone()) else {
            return Ok(Self::prepare_launch_rejected(
                plan,
                FactIntent::Unregistered,
                LaunchRejection::BudgetUnavailable,
                observed_at_unix_ms,
            ));
        };
        let request = ProtectedLaunchRequest::new(launch, plan, &self.peer_authority);
        let prepared = self.provisioner.prepare(&request);
        drop(request);
        let prepared_at_unix_ms = clock.sample()?;
        if let Some(rejection) = authority_rejection(plan, prepared_at_unix_ms) {
            return self.prepare_reserved_rejection(plan, &intent, rejection, prepared_at_unix_ms);
        }
        let Ok(prepared) = prepared else {
            return self.prepare_reserved_rejection(
                plan,
                &intent,
                LaunchRejection::InvalidEndpoints,
                prepared_at_unix_ms,
            );
        };
        self.spawn_prepared_launch(plan, &key, intent, prepared, clock)
    }
}

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn handle_launch(
        &mut self,
        pending: PendingManagementInbound,
        payload: ValidatedManagementPayload,
        digest: [u8; 32],
        received_at_unix_ms: i64,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let prepared = self
            .core
            .prepare_launch(&payload, digest, received_at_unix_ms, clock);
        drop(payload);
        match prepared {
            Ok(emission) => self.commit_prepared_launch(pending, emission),
            Err(error) => {
                let channel_error = self
                    .channel
                    .reject(pending)
                    .err()
                    .unwrap_or(ManagementChannelError::ChannelPoisoned);
                let now_unix_ms = self
                    .lifecycle_clock
                    .now_unix_ms()
                    .max(self.channel.owner_now_unix_ms());
                self.close_for_channel_failure(&channel_error, now_unix_ms, None)?;
                Err(error)
            }
        }
    }
}
