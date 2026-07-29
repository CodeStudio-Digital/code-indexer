use agent_protocol::frame::AsyncEstablishedChannelError;
use agent_protocol::framing::AsyncFramingError;

use super::ActiveRunnerExitReason;
use crate::control::{
    ActivationOutcome, AsyncControlDriverError, ControlDriverEvent, PrepareOutcome,
};

pub(super) enum PostActiveDisposition {
    Continue,
    Cleanup(ActiveRunnerExitReason),
}

pub(super) fn classify_post_active_event(event: ControlDriverEvent) -> PostActiveDisposition {
    match event {
        ControlDriverEvent::Replayed(_)
        | ControlDriverEvent::Prepare(PrepareOutcome::AlreadyPrepared)
        | ControlDriverEvent::Activate(ActivationOutcome::AlreadyActive) => {
            PostActiveDisposition::Continue
        }
        ControlDriverEvent::Cancel(outcome) => {
            PostActiveDisposition::Cleanup(ActiveRunnerExitReason::RemoteCancelled(outcome))
        }
        ControlDriverEvent::Fence(outcome) => {
            PostActiveDisposition::Cleanup(ActiveRunnerExitReason::Fenced(outcome))
        }
        ControlDriverEvent::Prepare(
            PrepareOutcome::HydrationRequired(_) | PrepareOutcome::HydrationInProgress,
        )
        | ControlDriverEvent::Activate(ActivationOutcome::Activated) => {
            PostActiveDisposition::Cleanup(ActiveRunnerExitReason::UnexpectedPostActiveEvent)
        }
    }
}

pub(super) fn classify_hard_deadline(error: AsyncControlDriverError) -> ActiveRunnerExitReason {
    if matches!(error, AsyncControlDriverError::DeadlineElapsed { .. }) {
        ActiveRunnerExitReason::HardDeadlineElapsed
    } else {
        ActiveRunnerExitReason::ProtocolFailure(error)
    }
}

pub(super) const fn is_control_eof(error: &AsyncControlDriverError) -> bool {
    matches!(
        error,
        AsyncControlDriverError::Channel(AsyncEstablishedChannelError::Framing(
            AsyncFramingError::PeerClosed
        ))
    )
}
