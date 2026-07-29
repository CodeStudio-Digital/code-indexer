use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    ManagementChannelError, PendingManagementInbound, ValidatedManagementPayload,
};

use self::model::{PhysicalTerminationKind, PhysicalTerminationPlan};
use self::plan::TerminationCommand;
use super::launch_registry::TerminationRegistryMatch;
use super::provision::ProtectedLaunchProvisionPort;
use super::state::CleanupTrigger;
use super::{
    SupervisorDriverError, SupervisorDriverStep, SupervisorLifecycleCore, SupervisorPhysicalDriver,
};
use crate::process_table::OwnershipKey;

pub(super) mod model;
pub(super) mod plan;

pub(in crate::management) struct ScheduledTermination {
    key: OwnershipKey,
    step: SupervisorDriverStep,
}

impl ScheduledTermination {
    pub(in crate::management) const fn key(&self) -> &OwnershipKey {
        &self.key
    }

    pub(in crate::management) const fn step(&self) -> SupervisorDriverStep {
        self.step
    }
}

pub(in crate::management) struct TerminationScheduleFailure<P> {
    error: Box<SupervisorDriverError<P>>,
    immediate_key: Option<OwnershipKey>,
}

impl<P> TerminationScheduleFailure<P> {
    fn new(error: SupervisorDriverError<P>, immediate_key: Option<OwnershipKey>) -> Box<Self> {
        Box::new(Self {
            error: Box::new(error),
            immediate_key,
        })
    }

    pub(in crate::management) fn into_parts(
        self,
    ) -> (SupervisorDriverError<P>, Option<OwnershipKey>) {
        (*self.error, self.immediate_key)
    }
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn schedule_termination(
        &mut self,
        payload: &ValidatedManagementPayload,
        digest: [u8; 32],
        now_unix_ms: i64,
    ) -> Result<ScheduledTermination, Box<TerminationScheduleFailure<P::Error>>> {
        let command = TerminationCommand::from_validated(payload, digest).map_err(|_| {
            TerminationScheduleFailure::new(SupervisorDriverError::InvalidTerminationPlan, None)
        })?;
        let physical_key = self.ownership.key_for_identity(command.identity()).ok();
        let key = self
            .launch_registry
            .termination_ownership_key(&command)
            .ok_or_else(|| {
                TerminationScheduleFailure::new(
                    SupervisorDriverError::UnknownTerminationTarget,
                    physical_key.clone(),
                )
            })?;
        let registration = self.launch_registry.classify_termination(&command, &key);
        if matches!(registration, TerminationRegistryMatch::Conflict) {
            let immediate_key = physical_key.filter(|physical| physical == &key);
            return Err(TerminationScheduleFailure::new(
                SupervisorDriverError::TerminationConflict,
                immediate_key,
            ));
        }
        if matches!(registration, TerminationRegistryMatch::Scheduled) {
            return Ok(ScheduledTermination {
                key,
                step: step(command.kind(), true),
            });
        }
        if physical_key.as_ref() != Some(&key) {
            return Err(TerminationScheduleFailure::new(
                SupervisorDriverError::UnknownTerminationTarget,
                None,
            ));
        }
        let metadata = self.ownership.metadata(&key).cloned().map_err(|error| {
            TerminationScheduleFailure::new(
                SupervisorDriverError::Ownership(error),
                Some(key.clone()),
            )
        })?;
        let plan = command
            .bind(&metadata, key.clone(), now_unix_ms)
            .map_err(|_| {
                TerminationScheduleFailure::new(SupervisorDriverError::InvalidTerminationPlan, None)
            })?;
        if matches!(registration, TerminationRegistryMatch::Fresh)
            && !self.launch_registry.reserve_termination(&command, &key)
        {
            return Err(TerminationScheduleFailure::new(
                SupervisorDriverError::TerminationConflict,
                Some(key),
            ));
        }
        self.install_termination(&plan, now_unix_ms)
            .map_err(|error| {
                TerminationScheduleFailure::new(
                    SupervisorDriverError::CleanupState(error),
                    Some(key.clone()),
                )
            })?;
        if !self.launch_registry.mark_termination_scheduled(&command) {
            return Err(TerminationScheduleFailure::new(
                SupervisorDriverError::TerminationConflict,
                Some(key),
            ));
        }
        Ok(ScheduledTermination {
            key,
            step: step(command.kind(), false),
        })
    }

    fn install_termination(
        &mut self,
        plan: &PhysicalTerminationPlan,
        now_unix_ms: i64,
    ) -> Result<(), super::state::CleanupStateError> {
        self.state.schedule_physical_termination(
            trigger(plan.kind()),
            now_unix_ms,
            plan.terminate_at_unix_ms(),
            plan.hard_cleanup_deadline_at_unix_ms(),
            [plan.ownership_key().clone()],
        )
    }
}

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn handle_termination(
        &mut self,
        pending: PendingManagementInbound,
        payload: ValidatedManagementPayload,
        digest: [u8; 32],
        now_unix_ms: i64,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let scheduled = match self
            .core
            .schedule_termination(&payload, digest, now_unix_ms)
        {
            Ok(scheduled) => scheduled,
            Err(failure) => {
                drop(payload);
                let (error, immediate_key) = (*failure).into_parts();
                return self.reject_termination(pending, now_unix_ms, immediate_key, error);
            }
        };
        drop(payload);
        self.acknowledge_termination(pending, &scheduled, now_unix_ms)
    }

    fn acknowledge_termination(
        &mut self,
        pending: PendingManagementInbound,
        scheduled: &ScheduledTermination,
        now_unix_ms: i64,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        if let Err(error) = self.channel.respond_acknowledged(pending) {
            let immediate_key = self
                .ownership
                .state(scheduled.key())
                .ok()
                .map(|_| scheduled.key().clone());
            self.close_for_channel_failure(&error, now_unix_ms, immediate_key)?;
            return Err(SupervisorDriverError::Channel(error));
        }
        Ok(scheduled.step())
    }

    fn reject_termination(
        &mut self,
        pending: PendingManagementInbound,
        now_unix_ms: i64,
        immediate_key: Option<OwnershipKey>,
        error: SupervisorDriverError<P::Error>,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let channel_error = self
            .channel
            .reject(pending)
            .err()
            .unwrap_or(ManagementChannelError::ChannelPoisoned);
        self.close_for_channel_failure(&channel_error, now_unix_ms, immediate_key)?;
        Err(error)
    }
}

const fn trigger(kind: PhysicalTerminationKind) -> CleanupTrigger {
    match kind {
        PhysicalTerminationKind::Cancel => CleanupTrigger::Cancel,
        PhysicalTerminationKind::Fence => CleanupTrigger::Fence,
        PhysicalTerminationKind::Reap => CleanupTrigger::Reap,
    }
}

const fn step(kind: PhysicalTerminationKind, reused_existing: bool) -> SupervisorDriverStep {
    match kind {
        PhysicalTerminationKind::Cancel => {
            SupervisorDriverStep::CancelScheduled { reused_existing }
        }
        PhysicalTerminationKind::Fence => SupervisorDriverStep::FenceScheduled { reused_existing },
        PhysicalTerminationKind::Reap => SupervisorDriverStep::ReapScheduled { reused_existing },
    }
}
