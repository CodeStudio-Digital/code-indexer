use agent_platform::containment::ContainedLaunch;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ValidatedManagementPayload;

use super::super::cleanup::{FlooredLifecycleClock, LifecycleClockSampler};
use super::super::fact_flow::FactIntent;
use super::super::facts::{LaunchRejection, authority_rejection};
use super::super::launch_registry::LaunchIntentKey;
use super::super::plan::LaunchPlan;
use super::super::provision::ProtectedLaunchPeerAuthority;
use super::super::reporting::PreparedLaunchEmission;
use super::super::{SupervisorDriverError, SupervisorLifecycleCore};
use crate::management::SupervisorLifecycleClock;
use crate::process_table::{OwnershipKey, PendingSpawn};

pub(in crate::management) enum AsyncLaunchStart {
    Immediate(PreparedLaunchEmission),
    Physical {
        state: PhysicalLaunchState,
        worker: Box<PhysicalLaunchWorkerInput>,
    },
}

pub(in crate::management) struct PhysicalLaunchState {
    pub(super) plan: LaunchPlan,
    pub(super) intent: LaunchIntentKey,
    pub(super) clock_floor_unix_ms: i64,
    pub(super) pending_spawn: Option<PendingSpawn>,
    pub(super) last_gate_unix_ms: i64,
    pub(super) last_raw_unix_ms: i64,
}

pub(in crate::management) struct PhysicalLaunchWorkerInput {
    pub(super) launch: wire::LaunchAttemptProcess,
    pub(super) plan: LaunchPlan,
    pub(super) peer_authority: ProtectedLaunchPeerAuthority,
    pub(super) contained_launch: ContainedLaunch,
}

impl PhysicalLaunchState {
    pub(in crate::management) fn ownership_key(&self) -> OwnershipKey {
        self.plan.ownership_key()
    }
}

impl PhysicalLaunchWorkerInput {
    pub(super) fn into_worker_parts(
        self,
    ) -> (
        wire::LaunchAttemptProcess,
        LaunchPlan,
        ProtectedLaunchPeerAuthority,
        ContainedLaunch,
    ) {
        (
            self.launch,
            self.plan,
            self.peer_authority,
            self.contained_launch,
        )
    }
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: agent_platform::containment::ContainmentPort,
    V: super::super::provision::ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn start_async_launch(
        &mut self,
        payload: ValidatedManagementPayload,
        digest: [u8; 32],
        received_at_unix_ms: i64,
        clock: &dyn SupervisorLifecycleClock,
    ) -> Result<AsyncLaunchStart, SupervisorDriverError<P::Error>> {
        if received_at_unix_ms <= 0 {
            return Err(super::super::state::CleanupStateError::InvalidTime.into());
        }
        if self
            .last_observed_at_unix_ms
            .is_some_and(|previous| received_at_unix_ms < previous)
        {
            return Err(super::super::state::CleanupStateError::ClockRegressed.into());
        }
        let launch = payload
            .into_launch_attempt_process()
            .ok_or(SupervisorDriverError::InvalidLaunchPlan)?;
        let plan = LaunchPlan::from_validated(&launch, digest)
            .map_err(|_| SupervisorDriverError::InvalidLaunchPlan)?;
        let floored = FlooredLifecycleClock::new(clock, received_at_unix_ms);
        let mut sampler =
            LifecycleClockSampler::new_floored(&floored, self.last_observed_at_unix_ms);
        let result = self.classify_async_launch(launch, plan, received_at_unix_ms, &mut sampler);
        self.last_observed_at_unix_ms = sampler.last();
        result
    }

    fn classify_async_launch(
        &mut self,
        launch: wire::LaunchAttemptProcess,
        plan: LaunchPlan,
        clock_floor_unix_ms: i64,
        clock: &mut LifecycleClockSampler<'_>,
    ) -> Result<AsyncLaunchStart, SupervisorDriverError<P::Error>> {
        let key = plan.ownership_key();
        let observed_at_unix_ms = clock.sample()?;
        let immediate = match self.classify_launch(&plan, &key) {
            super::LaunchDisposition::Exact {
                intent_key,
                accepted,
                live_owner,
            } => Some(self.prepare_existing_launch(
                &plan,
                &key,
                intent_key,
                accepted,
                live_owner,
                observed_at_unix_ms,
            )?),
            super::LaunchDisposition::Conflict => Some(Self::prepare_launch_rejected(
                &plan,
                FactIntent::Unregistered,
                LaunchRejection::DuplicateConflict,
                observed_at_unix_ms,
            )),
            super::LaunchDisposition::Rejected {
                intent_key,
                rejection,
                rejected_at_unix_ms,
            } => Some(Self::prepare_launch_rejected(
                &plan,
                FactIntent::Registered(intent_key),
                rejection,
                rejected_at_unix_ms,
            )),
            super::LaunchDisposition::Fresh => None,
        };
        if let Some(emission) = immediate {
            return Ok(AsyncLaunchStart::Immediate(emission));
        }
        let rejection = if !self.state.is_accepting_launches() {
            Some(LaunchRejection::AdmissionClosed)
        } else if !plan.trusted_provenance_matches(&self.trusted_runner) {
            Some(LaunchRejection::ProvenanceDenied)
        } else {
            authority_rejection(&plan, observed_at_unix_ms)
        };
        if let Some(rejection) = rejection {
            return Ok(AsyncLaunchStart::Immediate(Self::prepare_launch_rejected(
                &plan,
                FactIntent::Unregistered,
                rejection,
                observed_at_unix_ms,
            )));
        }
        let Some(intent) = self.launch_registry.reserve(&plan, key) else {
            return Ok(AsyncLaunchStart::Immediate(Self::prepare_launch_rejected(
                &plan,
                FactIntent::Unregistered,
                LaunchRejection::BudgetUnavailable,
                observed_at_unix_ms,
            )));
        };
        let state = PhysicalLaunchState {
            plan: plan.clone(),
            intent,
            clock_floor_unix_ms,
            pending_spawn: None,
            last_gate_unix_ms: observed_at_unix_ms,
            last_raw_unix_ms: clock
                .last_raw()
                .ok_or(super::super::state::CleanupStateError::InvalidTransition)?,
        };
        let worker = PhysicalLaunchWorkerInput {
            launch,
            plan,
            peer_authority: self.peer_authority.clone(),
            contained_launch: self.trusted_runner.contained_launch(),
        };
        Ok(AsyncLaunchStart::Physical {
            state,
            worker: Box::new(worker),
        })
    }
}
