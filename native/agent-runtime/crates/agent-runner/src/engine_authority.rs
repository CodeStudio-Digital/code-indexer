use std::future::{Future, ready};

use agent_engine::ports::{AuthorityCheckpoint, AuthorityPort};

use crate::control::authority::{AuthorityError, EffectGate};

/// Engine-facing verifier backed by the Control owner's revocable authority.
#[derive(Debug)]
pub struct EngineAuthority {
    gate: EffectGate,
}

impl EngineAuthority {
    pub const fn new(gate: EffectGate) -> Self {
        Self { gate }
    }
}

impl AuthorityPort for EngineAuthority {
    type Error = AuthorityError;

    fn verify(
        &mut self,
        _checkpoint: AuthorityCheckpoint,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        ready(self.gate.verify_live())
    }
}
