use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::identity::AttemptId;
use crate::version::NegotiatedProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeState {
    New,
    AwaitingHostHello,
    AwaitingPreparation,
    Hydrating,
    AwaitingActivation,
    Active,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandshakeEventKind {
    AgentHelloSent,
    HostHelloAccepted,
    PrepareAccepted,
    AttemptPrepared,
    ActivateAccepted,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeEvent {
    AgentHelloSent,
    HostHelloAccepted(NegotiatedProtocol),
    PrepareAccepted(AttemptId),
    AttemptPrepared,
    ActivateAccepted(AttemptId),
    Close,
}

impl HandshakeEvent {
    #[must_use]
    pub const fn kind(&self) -> HandshakeEventKind {
        match self {
            Self::AgentHelloSent => HandshakeEventKind::AgentHelloSent,
            Self::HostHelloAccepted(_) => HandshakeEventKind::HostHelloAccepted,
            Self::PrepareAccepted(_) => HandshakeEventKind::PrepareAccepted,
            Self::AttemptPrepared => HandshakeEventKind::AttemptPrepared,
            Self::ActivateAccepted(_) => HandshakeEventKind::ActivateAccepted,
            Self::Close => HandshakeEventKind::Close,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    InvalidTransition {
        state: HandshakeState,
        event: HandshakeEventKind,
    },
    AttemptMismatch {
        prepared: AttemptId,
        activated: AttemptId,
    },
}

impl Display for HandshakeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition { state, event } => {
                write!(
                    formatter,
                    "invalid handshake event {event:?} while in {state:?}"
                )
            }
            Self::AttemptMismatch {
                prepared,
                activated,
            } => write!(
                formatter,
                "activation attempt {activated} does not match prepared attempt {prepared}"
            ),
        }
    }
}

impl Error for HandshakeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeMachine {
    state: HandshakeState,
    negotiated: Option<NegotiatedProtocol>,
    attempt_id: Option<AttemptId>,
}

impl Default for HandshakeMachine {
    fn default() -> Self {
        Self {
            state: HandshakeState::New,
            negotiated: None,
            attempt_id: None,
        }
    }
}

impl HandshakeMachine {
    #[must_use]
    pub const fn state(&self) -> HandshakeState {
        self.state
    }

    #[must_use]
    pub const fn negotiated(&self) -> Option<NegotiatedProtocol> {
        self.negotiated
    }

    #[must_use]
    pub const fn attempt_id(&self) -> Option<&AttemptId> {
        self.attempt_id.as_ref()
    }

    #[must_use]
    pub fn effects_allowed(&self) -> bool {
        self.state == HandshakeState::Active
    }

    /// Applies one ordered handshake event.
    ///
    /// # Errors
    ///
    /// Returns [`HandshakeError::InvalidTransition`] for an out-of-order event,
    /// or [`HandshakeError::AttemptMismatch`] when activation targets a
    /// different attempt than preparation.
    pub fn apply(&mut self, event: HandshakeEvent) -> Result<(), HandshakeError> {
        let event_kind = event.kind();
        match (self.state, event) {
            (HandshakeState::New, HandshakeEvent::AgentHelloSent) => {
                self.state = HandshakeState::AwaitingHostHello;
            }
            (HandshakeState::AwaitingHostHello, HandshakeEvent::HostHelloAccepted(negotiated)) => {
                self.negotiated = Some(negotiated);
                self.state = HandshakeState::AwaitingPreparation;
            }
            (HandshakeState::AwaitingPreparation, HandshakeEvent::PrepareAccepted(attempt_id)) => {
                self.attempt_id = Some(attempt_id);
                self.state = HandshakeState::Hydrating;
            }
            (HandshakeState::Hydrating, HandshakeEvent::AttemptPrepared) => {
                self.state = HandshakeState::AwaitingActivation;
            }
            (HandshakeState::AwaitingActivation, HandshakeEvent::ActivateAccepted(activated)) => {
                let Some(prepared) = self.attempt_id.as_ref() else {
                    return Err(HandshakeError::InvalidTransition {
                        state: self.state,
                        event: event_kind,
                    });
                };
                if prepared != &activated {
                    return Err(HandshakeError::AttemptMismatch {
                        prepared: prepared.clone(),
                        activated,
                    });
                }
                self.state = HandshakeState::Active;
            }
            (state, HandshakeEvent::Close) if state != HandshakeState::Closed => {
                self.state = HandshakeState::Closed;
            }
            (state, _) => {
                return Err(HandshakeError::InvalidTransition {
                    state,
                    event: event_kind,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{HandshakeError, HandshakeEvent, HandshakeMachine, HandshakeState};
    use crate::identity::AttemptId;
    use crate::version::{FeatureSet, NegotiatedProtocol, ProtocolVersion};

    fn negotiated() -> NegotiatedProtocol {
        NegotiatedProtocol {
            version: ProtocolVersion::new(1, 0),
            features: FeatureSet::NONE,
        }
    }

    fn advance_to_prepared(machine: &mut HandshakeMachine, attempt: &AttemptId) {
        machine
            .apply(HandshakeEvent::AgentHelloSent)
            .expect("agent hello");
        machine
            .apply(HandshakeEvent::HostHelloAccepted(negotiated()))
            .expect("host hello");
        machine
            .apply(HandshakeEvent::PrepareAccepted(attempt.clone()))
            .expect("prepare");
        machine
            .apply(HandshakeEvent::AttemptPrepared)
            .expect("prepared");
    }

    #[test]
    fn effects_are_blocked_until_activation() {
        let attempt = AttemptId::new("44444444-4444-4444-8444-444444444444").expect("valid ID");
        let mut machine = HandshakeMachine::default();

        advance_to_prepared(&mut machine, &attempt);
        assert!(!machine.effects_allowed());

        machine
            .apply(HandshakeEvent::ActivateAccepted(attempt))
            .expect("activation");
        assert!(machine.effects_allowed());
        assert_eq!(machine.state(), HandshakeState::Active);
    }

    #[test]
    fn activation_is_bound_to_the_prepared_attempt() {
        let prepared = AttemptId::new("44444444-4444-4444-8444-444444444444").expect("valid ID");
        let stale = AttemptId::new("99999999-9999-4999-8999-999999999999").expect("valid ID");
        let mut machine = HandshakeMachine::default();
        advance_to_prepared(&mut machine, &prepared);

        assert!(matches!(
            machine.apply(HandshakeEvent::ActivateAccepted(stale)),
            Err(HandshakeError::AttemptMismatch { .. })
        ));
        assert_eq!(machine.state(), HandshakeState::AwaitingActivation);
    }

    #[test]
    fn preparation_cannot_be_replayed() {
        let attempt = AttemptId::new("44444444-4444-4444-8444-444444444444").expect("valid ID");
        let mut machine = HandshakeMachine::default();
        advance_to_prepared(&mut machine, &attempt);

        assert!(matches!(
            machine.apply(HandshakeEvent::PrepareAccepted(attempt)),
            Err(HandshakeError::InvalidTransition { .. })
        ));
    }
}
