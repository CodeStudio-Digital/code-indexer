use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{AsyncManagementActorError, ManagementChannelError};

use super::{
    ServiceMode, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorManagementTerminal,
};
use crate::management::{
    AdmissionClosureReason, ProtectedLaunchProvisionPort, SupervisorLifecycleClock,
    SupervisorOnlineLifecycleTimer,
};

impl<P, V, C, T> SupervisorAsyncService<P, V, C, T>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
    C: SupervisorLifecycleClock,
    T: SupervisorOnlineLifecycleTimer,
{
    pub(super) fn fail_channel(
        &mut self,
        error: AsyncManagementActorError,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let terminal = terminal_for(&error);
        let closure = closure_for(&error);
        match self.close_admission(terminal, closure, None) {
            Ok(()) => SupervisorAsyncServiceAdvance::ChannelDraining(error),
            Err(failure) => failure,
        }
    }

    pub(super) fn fail_unsupported(
        &mut self,
        kind: &'static str,
        error: crate::management::SupervisorDriverError<P::Error>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        match self.close_admission(
            SupervisorManagementTerminal::UnsupportedInbound(kind),
            AdmissionClosureReason::ChannelPoisoned,
            None,
        ) {
            Ok(()) => SupervisorAsyncServiceAdvance::DriverFailure(error),
            Err(failure) => failure,
        }
    }

    pub(super) fn fail_driver(
        &mut self,
        error: crate::management::SupervisorDriverError<P::Error>,
        immediate_key: Option<crate::process_table::OwnershipKey>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        let hard_restart = match &error {
            crate::management::SupervisorDriverError::CleanupState(state) => Some(*state),
            _ => None,
        };
        match self.close_admission(
            SupervisorManagementTerminal::ProtocolFailure,
            AdmissionClosureReason::ChannelPoisoned,
            immediate_key,
        ) {
            Ok(()) => {
                if let Some(state) = hard_restart {
                    self.mode = ServiceMode::HardRestart(state);
                }
                SupervisorAsyncServiceAdvance::DriverFailure(error)
            }
            Err(failure) => failure,
        }
    }

    pub(super) fn close_after_write_failure(
        &mut self,
        error: AsyncManagementActorError,
        immediate_key: Option<crate::process_table::OwnershipKey>,
    ) -> SupervisorAsyncServiceAdvance<P::Error> {
        match self.close_admission(
            SupervisorManagementTerminal::WriteFailure,
            AdmissionClosureReason::PostSpawnWriteFailure,
            immediate_key,
        ) {
            Ok(()) => SupervisorAsyncServiceAdvance::ChannelDraining(error),
            Err(failure) => failure,
        }
    }

    fn close_admission(
        &mut self,
        terminal: SupervisorManagementTerminal,
        closure: AdmissionClosureReason,
        immediate_key: Option<crate::process_table::OwnershipKey>,
    ) -> Result<(), SupervisorAsyncServiceAdvance<P::Error>> {
        let now_unix_ms = self.lifecycle.owner_now_unix_ms();
        if let Err(error) = self.lifecycle.owner_mut().close_for_management_loss(
            closure,
            now_unix_ms,
            immediate_key,
        ) {
            let restart = match &error {
                crate::management::SupervisorDriverError::CleanupState(state) => *state,
                _ => crate::management::CleanupStateError::InvalidTransition,
            };
            self.mode = ServiceMode::HardRestart(restart);
            return Err(SupervisorAsyncServiceAdvance::DriverFailure(error));
        }
        self.mode = ServiceMode::Draining(terminal);
        Ok(())
    }
}

const fn terminal_for(error: &AsyncManagementActorError) -> SupervisorManagementTerminal {
    match error {
        AsyncManagementActorError::PeerClosed
        | AsyncManagementActorError::ActorClosed
        | AsyncManagementActorError::Management(ManagementChannelError::UnexpectedEof) => {
            SupervisorManagementTerminal::PeerClosed
        }
        AsyncManagementActorError::PhysicalReadDeadlineElapsed => {
            SupervisorManagementTerminal::ReadFailure
        }
        AsyncManagementActorError::PhysicalWriteDeadlineElapsed
        | AsyncManagementActorError::CommandQueueClosed
        | AsyncManagementActorError::CommandQueueDeadlineElapsed => {
            SupervisorManagementTerminal::WriteFailure
        }
        _ => SupervisorManagementTerminal::ProtocolFailure,
    }
}

const fn closure_for(error: &AsyncManagementActorError) -> AdmissionClosureReason {
    if matches!(
        error,
        AsyncManagementActorError::PeerClosed
            | AsyncManagementActorError::ActorClosed
            | AsyncManagementActorError::Management(ManagementChannelError::UnexpectedEof)
    ) {
        AdmissionClosureReason::UnexpectedEof
    } else {
        AdmissionClosureReason::ChannelPoisoned
    }
}
