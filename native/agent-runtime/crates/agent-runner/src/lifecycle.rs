use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_protocol::identity::AttemptIdentity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerState {
    Allocated,
    Spawning,
    Handshaking,
    Hydrating,
    Prepared,
    Active,
    Checkpointing,
    Cancelling,
    Terminalizing,
    AttemptExitPending,
    Exiting,
    Reaped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerLifecycleError {
    AlreadyAssigned,
    AssignmentTooLate { state: RunnerState },
    MissingAttempt { target: RunnerState },
    DurableCommitRequired { state: RunnerState },
    InvalidTransition { from: RunnerState, to: RunnerState },
}

impl Display for RunnerLifecycleError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyAssigned => {
                formatter.write_str("runner is already single-tenant assigned")
            }
            Self::AssignmentTooLate { state } => {
                write!(formatter, "runner cannot be assigned while in {state:?}")
            }
            Self::MissingAttempt { target } => {
                write!(
                    formatter,
                    "runner needs an attempt before entering {target:?}"
                )
            }
            Self::DurableCommitRequired { state } => {
                write!(formatter, "runner cannot exit {state:?} before host commit")
            }
            Self::InvalidTransition { from, to } => {
                write!(
                    formatter,
                    "invalid runner transition from {from:?} to {to:?}"
                )
            }
        }
    }
}

impl Error for RunnerLifecycleError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerLifecycle {
    state: RunnerState,
    identity: Option<AttemptIdentity>,
    exit_commit_acknowledged: bool,
}

impl Default for RunnerLifecycle {
    fn default() -> Self {
        Self {
            state: RunnerState::Allocated,
            identity: None,
            exit_commit_acknowledged: false,
        }
    }
}

impl RunnerLifecycle {
    #[must_use]
    pub const fn state(&self) -> RunnerState {
        self.state
    }

    #[must_use]
    pub const fn identity(&self) -> Option<&AttemptIdentity> {
        self.identity.as_ref()
    }

    #[must_use]
    pub const fn effects_allowed(&self) -> bool {
        matches!(self.state, RunnerState::Active)
    }

    /// Assigns this process to its only attempt.
    ///
    /// # Errors
    ///
    /// Returns [`RunnerLifecycleError`] if the process was already assigned or
    /// has passed the handshake phase.
    pub fn assign(&mut self, identity: AttemptIdentity) -> Result<(), RunnerLifecycleError> {
        if self.identity.is_some() {
            return Err(RunnerLifecycleError::AlreadyAssigned);
        }
        if !matches!(
            self.state,
            RunnerState::Allocated | RunnerState::Spawning | RunnerState::Handshaking
        ) {
            return Err(RunnerLifecycleError::AssignmentTooLate { state: self.state });
        }
        self.identity = Some(identity);
        Ok(())
    }

    /// Moves the physical process lifecycle to a directly reachable state.
    ///
    /// # Errors
    ///
    /// Returns [`RunnerLifecycleError`] for an invalid transition or hydration
    /// before an attempt is assigned.
    pub const fn transition(&mut self, next: RunnerState) -> Result<(), RunnerLifecycleError> {
        if matches!(next, RunnerState::Hydrating) && self.identity.is_none() {
            return Err(RunnerLifecycleError::MissingAttempt { target: next });
        }
        if matches!(
            self.state,
            RunnerState::Terminalizing | RunnerState::AttemptExitPending
        ) && matches!(next, RunnerState::Exiting)
            && !self.exit_commit_acknowledged
        {
            return Err(RunnerLifecycleError::DurableCommitRequired { state: self.state });
        }
        if !can_transition(self.state, next) {
            return Err(RunnerLifecycleError::InvalidTransition {
                from: self.state,
                to: next,
            });
        }
        self.state = next;
        Ok(())
    }

    /// Records the host's durable terminal or attempt-exit acknowledgement.
    ///
    /// # Errors
    ///
    /// Returns [`RunnerLifecycleError::InvalidTransition`] unless the runner is
    /// waiting at a durable exit barrier.
    pub const fn acknowledge_exit_commit(&mut self) -> Result<(), RunnerLifecycleError> {
        if !matches!(
            self.state,
            RunnerState::Terminalizing | RunnerState::AttemptExitPending
        ) {
            return Err(RunnerLifecycleError::InvalidTransition {
                from: self.state,
                to: RunnerState::Exiting,
            });
        }
        self.exit_commit_acknowledged = true;
        Ok(())
    }

    /// Records an exceptional physical exit such as crash, hard kill or failed
    /// bootstrap. It never implies that a logical terminal was committed.
    ///
    /// # Errors
    ///
    /// Returns [`RunnerLifecycleError::InvalidTransition`] after reaping.
    pub const fn force_exit(&mut self) -> Result<(), RunnerLifecycleError> {
        if matches!(self.state, RunnerState::Reaped) {
            return Err(RunnerLifecycleError::InvalidTransition {
                from: self.state,
                to: RunnerState::Exiting,
            });
        }
        self.state = RunnerState::Exiting;
        Ok(())
    }
}

#[must_use]
pub const fn can_transition(from: RunnerState, to: RunnerState) -> bool {
    use RunnerState::{
        Active, Allocated, AttemptExitPending, Cancelling, Checkpointing, Exiting, Handshaking,
        Hydrating, Prepared, Reaped, Spawning, Terminalizing,
    };

    match from {
        Allocated => matches!(to, Spawning),
        Spawning => matches!(to, Handshaking),
        Handshaking => matches!(to, Hydrating),
        Hydrating => matches!(to, Prepared),
        Prepared => matches!(to, Active),
        Active => matches!(
            to,
            Checkpointing | Cancelling | Terminalizing | AttemptExitPending
        ),
        Checkpointing => matches!(to, Active | Cancelling | Terminalizing | AttemptExitPending),
        Cancelling => matches!(to, Terminalizing | AttemptExitPending),
        Terminalizing | AttemptExitPending => matches!(to, Exiting),
        Exiting => matches!(to, Reaped),
        Reaped => false,
    }
}

#[cfg(test)]
mod tests;
