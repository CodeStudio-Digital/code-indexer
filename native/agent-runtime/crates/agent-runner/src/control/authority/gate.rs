use std::fmt::{self, Debug, Formatter};
#[cfg(test)]
use std::marker::PhantomData;
#[cfg(test)]
use std::rc::Rc;
#[cfg(test)]
use std::sync::MutexGuard;
use std::sync::{Arc, Mutex};

use super::ActiveAuthority;
#[cfg(test)]
use super::{AuthorityError, EffectToken, GateIdentity};

/// Trusted time source installed once by the control owner.
pub trait EffectClock: Debug + Send + Sync {
    /// Returns Unix milliseconds from a source that must never move backwards.
    fn now_unix_ms(&self) -> i64;
}

#[derive(Clone)]
pub struct EffectGate {
    inner: Arc<EffectGateInner>,
}

struct EffectGateInner {
    #[cfg(test)]
    identity: Arc<GateIdentity>,
    #[cfg(test)]
    clock: Arc<dyn EffectClock>,
    state: Mutex<GateState>,
}

#[derive(Debug)]
struct GateState {
    #[cfg(test)]
    fencing_epoch: u64,
    #[cfg(test)]
    deadline_at_unix_ms: i64,
    #[cfg(test)]
    authority_tag: [u8; 32],
    generation: u64,
    #[cfg(test)]
    last_observed_at_unix_ms: Option<i64>,
    revoked: bool,
}

impl EffectGate {
    #[must_use]
    pub(super) fn new(authority: &ActiveAuthority, clock: Arc<dyn EffectClock>) -> Self {
        #[cfg(not(test))]
        let _ = (authority, clock);

        Self {
            inner: Arc::new(EffectGateInner {
                #[cfg(test)]
                identity: Arc::new(GateIdentity),
                #[cfg(test)]
                clock,
                state: Mutex::new(GateState {
                    #[cfg(test)]
                    fencing_epoch: authority.identity.fencing_epoch,
                    #[cfg(test)]
                    deadline_at_unix_ms: authority.deadline_at_unix_ms,
                    #[cfg(test)]
                    authority_tag: authority.authority_tag,
                    generation: 1,
                    #[cfg(test)]
                    last_observed_at_unix_ms: None,
                    revoked: false,
                }),
            }),
        }
    }

    /// Issues a non-cloneable token from a live authority.
    #[cfg(test)]
    pub(crate) fn token(&self) -> Result<EffectToken, AuthorityError> {
        let mut state = self.lock_for_dispatch()?;
        self.observe_time(&mut state)?;
        state.validate_live()?;
        Ok(EffectToken {
            gate_identity: Arc::clone(&self.inner.identity),
            generation: state.generation,
            fencing_epoch: state.fencing_epoch,
            authority_tag: state.authority_tag,
        })
    }

    /// Authorizes and synchronously dispatches one effect under one lock.
    ///
    /// Revocation cannot complete between validation and the closure return.
    #[cfg(test)]
    #[allow(clippy::significant_drop_tightening)]
    pub(crate) fn with_effect_dispatch<R>(
        &self,
        token: &EffectToken,
        dispatch: impl FnOnce(&EffectDispatchPermit<'_>) -> R,
    ) -> Result<R, AuthorityError> {
        if !Arc::ptr_eq(&token.gate_identity, &self.inner.identity) {
            return Err(AuthorityError::InvalidToken);
        }
        let mut state = self.lock_for_dispatch()?;
        self.observe_time(&mut state)?;
        state.validate_token(token)?;
        let permit = EffectDispatchPermit {
            guard: state,
            not_send: PhantomData,
        };
        Ok(dispatch(&permit))
    }

    /// Revokes under the same lock used by dispatch admission.
    pub(crate) fn revoke(&self) {
        let mut state = match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.revoke();
    }

    #[cfg(test)]
    fn lock_for_dispatch(&self) -> Result<MutexGuard<'_, GateState>, AuthorityError> {
        self.inner
            .state
            .lock()
            .map_err(|_| AuthorityError::GatePoisoned)
    }

    #[cfg(test)]
    fn observe_time(&self, state: &mut GateState) -> Result<(), AuthorityError> {
        let observed = self.inner.clock.now_unix_ms();
        if let Some(previous) = state.last_observed_at_unix_ms
            && observed < previous
        {
            state.revoke();
            return Err(AuthorityError::ClockRegressed { previous, observed });
        }
        state.last_observed_at_unix_ms = Some(observed);
        Ok(())
    }
}

impl GateState {
    #[cfg(test)]
    fn validate_live(&self) -> Result<(), AuthorityError> {
        if self.revoked {
            return Err(AuthorityError::Revoked);
        }
        let now = self.last_observed_at_unix_ms.unwrap_or_default();
        if now <= 0 || now >= self.deadline_at_unix_ms {
            return Err(AuthorityError::Expired {
                deadline: self.deadline_at_unix_ms,
                now,
            });
        }
        Ok(())
    }

    #[cfg(test)]
    fn validate_token(&self, token: &EffectToken) -> Result<(), AuthorityError> {
        self.validate_live()?;
        if token.generation != self.generation
            || token.fencing_epoch != self.fencing_epoch
            || token.authority_tag != self.authority_tag
        {
            return Err(AuthorityError::InvalidToken);
        }
        Ok(())
    }

    const fn revoke(&mut self) {
        if !self.revoked {
            self.revoked = true;
            self.generation = self.generation.saturating_add(1);
        }
    }
}

/// Stack-bound proof that effect admission is still locked.
#[cfg(test)]
pub struct EffectDispatchPermit<'gate> {
    guard: MutexGuard<'gate, GateState>,
    not_send: PhantomData<Rc<()>>,
}

#[cfg(test)]
impl Debug for EffectDispatchPermit<'_> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EffectDispatchPermit")
            .field("fencing_epoch", &self.guard.fencing_epoch)
            .field("deadline_at_unix_ms", &self.guard.deadline_at_unix_ms)
            .finish_non_exhaustive()
    }
}

impl Debug for EffectGate {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("EffectGate").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests;
