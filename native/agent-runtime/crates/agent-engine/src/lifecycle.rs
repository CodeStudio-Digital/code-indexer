use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Created,
    Hydrating,
    Ready,
    Composing,
    ProviderStream,
    CapabilityDispatch,
    Compacting,
    Waiting,
    ProviderFallback,
    Stopping,
    Terminalizing,
    AttemptExit,
    Completed,
    Failed,
    Aborted,
    Interrupted,
}

impl RunState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Aborted | Self::Interrupted
        )
    }

    #[must_use]
    pub const fn finishes_attempt(self) -> bool {
        self.is_terminal() || matches!(self, Self::AttemptExit)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidRunTransition {
    pub from: RunState,
    pub to: RunState,
}

impl Display for InvalidRunTransition {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid logical run transition from {:?} to {:?}",
            self.from, self.to
        )
    }
}

impl Error for InvalidRunTransition {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunLifecycle {
    state: RunState,
}

impl Default for RunLifecycle {
    fn default() -> Self {
        Self {
            state: RunState::Created,
        }
    }
}

impl RunLifecycle {
    #[must_use]
    pub const fn state(self) -> RunState {
        self.state
    }

    /// Moves the logical run to a directly reachable state.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidRunTransition`] when `next` is not reachable from the
    /// current state.
    pub const fn transition(&mut self, next: RunState) -> Result<(), InvalidRunTransition> {
        if !can_transition(self.state, next) {
            return Err(InvalidRunTransition {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        Ok(())
    }
}

#[must_use]
pub const fn can_transition(from: RunState, to: RunState) -> bool {
    use RunState::{
        Aborted, AttemptExit, CapabilityDispatch, Compacting, Completed, Composing, Created,
        Failed, Hydrating, Interrupted, ProviderFallback, ProviderStream, Ready, Stopping,
        Terminalizing, Waiting,
    };

    match from {
        Created => matches!(to, Hydrating | AttemptExit),
        Hydrating => matches!(to, Ready | AttemptExit),
        Ready => matches!(to, Composing | Stopping | AttemptExit),
        Composing => matches!(
            to,
            ProviderStream
                | Compacting
                | Waiting
                | ProviderFallback
                | Stopping
                | Terminalizing
                | AttemptExit
        ),
        ProviderStream => matches!(
            to,
            CapabilityDispatch
                | Composing
                | Compacting
                | Waiting
                | ProviderFallback
                | Stopping
                | Terminalizing
                | AttemptExit
        ),
        CapabilityDispatch | Compacting => matches!(
            to,
            Composing | Waiting | ProviderFallback | Stopping | Terminalizing | AttemptExit
        ),
        Waiting | ProviderFallback => matches!(to, AttemptExit),
        Stopping => matches!(to, AttemptExit | Terminalizing),
        Terminalizing => matches!(to, Completed | Failed | Aborted | Interrupted),
        AttemptExit | Completed | Failed | Aborted | Interrupted => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{RunLifecycle, RunState};

    #[test]
    fn completed_requires_terminalizing_barrier() {
        let mut lifecycle = RunLifecycle::default();
        assert!(lifecycle.transition(RunState::Completed).is_err());

        for next in [
            RunState::Hydrating,
            RunState::Ready,
            RunState::Composing,
            RunState::Terminalizing,
            RunState::Completed,
        ] {
            lifecycle.transition(next).expect("valid completion path");
        }
        assert!(lifecycle.state().is_terminal());
    }

    #[test]
    fn every_durable_terminal_requires_terminalizing_barrier() {
        for terminal in [
            RunState::Completed,
            RunState::Failed,
            RunState::Aborted,
            RunState::Interrupted,
        ] {
            let mut lifecycle = RunLifecycle {
                state: RunState::Stopping,
            };
            assert!(lifecycle.transition(terminal).is_err());
            lifecycle
                .transition(RunState::Terminalizing)
                .expect("terminal proposal");
            lifecycle
                .transition(terminal)
                .expect("host durable commit acknowledgement");
        }
    }

    #[test]
    fn waiting_exits_attempt_without_terminalizing_run() {
        let mut lifecycle = RunLifecycle::default();
        for next in [
            RunState::Hydrating,
            RunState::Ready,
            RunState::Composing,
            RunState::Waiting,
            RunState::AttemptExit,
        ] {
            lifecycle.transition(next).expect("valid waiting path");
        }

        assert!(lifecycle.state().finishes_attempt());
        assert!(!lifecycle.state().is_terminal());
    }

    #[test]
    fn terminal_state_rejects_all_follow_up_transitions() {
        let mut lifecycle = RunLifecycle {
            state: RunState::Interrupted,
        };

        for candidate in [
            RunState::Created,
            RunState::Hydrating,
            RunState::Ready,
            RunState::Composing,
            RunState::Terminalizing,
            RunState::Completed,
        ] {
            assert!(lifecycle.transition(candidate).is_err());
        }
    }
}
