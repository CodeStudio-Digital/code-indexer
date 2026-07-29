use std::io::{Read, Write};
use std::sync::Arc;

use agent_protocol::frame::EstablishedAttemptChannel;

use crate::lifecycle::RunnerState;

use super::authority::EffectClock;
#[cfg(test)]
use super::authority::{AuthorityError, EffectDispatchPermit, EffectToken};
use super::session::RunnerControlSession;
use super::{EffectivePreparedFacts, HydrationToken};

mod activation;
mod clock;
mod error;
mod lifecycle;
mod model;
mod transaction;

pub(super) use clock::SystemControlClock;
pub use error::ControlDriverError;
pub use model::ControlDriverEvent;
use model::HeldPrepare;

/// Sole owner of an established control channel and its attempt state.
///
/// Staged state is installed only after the matching inbound frame has been
/// committed. Dropping or closing the driver revokes effects and drops the
/// underlying streams.
#[derive(Debug)]
pub struct RunnerControlDriver<R, W> {
    channel: Option<EstablishedAttemptChannel<R, W>>,
    session: RunnerControlSession,
    clock: Arc<dyn EffectClock>,
    pending_prepare: Option<HeldPrepare>,
}

impl<R: Read, W: Write> RunnerControlDriver<R, W> {
    #[must_use]
    pub const fn state(&self) -> RunnerState {
        self.session.state()
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.channel.is_none()
    }

    /// Receives and transactionally handles the next control frame.
    ///
    /// # Errors
    ///
    /// Fails closed on transport, framing, context, lifecycle, or validation
    /// errors. It also rejects reads while a Prepare is awaiting hydration.
    pub fn receive_next(&mut self) -> Result<ControlDriverEvent, ControlDriverError> {
        self.receive_next_inner()
    }

    /// Commits the retained Prepare response before installing Prepared state.
    ///
    /// # Errors
    ///
    /// Fails closed if hydration validation, response bounding, receiver
    /// commit, or receipt binding validation fails.
    pub fn finish_prepare(
        &mut self,
        token: HydrationToken,
        facts: EffectivePreparedFacts,
    ) -> Result<(), ControlDriverError> {
        self.finish_prepare_inner(token, facts)
    }

    pub(in crate::control) fn from_shared_clock(
        channel: EstablishedAttemptChannel<R, W>,
        session: RunnerControlSession,
        clock: Arc<dyn EffectClock>,
    ) -> Self {
        Self {
            channel: Some(channel),
            session,
            clock,
            pending_prepare: None,
        }
    }

    /// Issues a non-cloneable token from the currently committed authority.
    ///
    /// # Errors
    ///
    /// Returns an error when activation has not committed or authority is
    /// expired, revoked, or clock-invalid.
    #[cfg(test)]
    pub(in crate::control) fn effect_token(&self) -> Result<EffectToken, AuthorityError> {
        self.session.effect_token()
    }

    /// Executes one synchronous effect admission while holding the revoke gate.
    ///
    /// Internal only: `dispatch` must synchronously cross a proven dispatch
    /// boundary. It must never merely enqueue or return deferred work.
    ///
    /// # Errors
    ///
    /// Returns an error without calling `dispatch` when the token is not backed
    /// by the current live authority.
    #[cfg(test)]
    pub(in crate::control) fn with_effect_dispatch<T>(
        &self,
        token: &EffectToken,
        dispatch: impl FnOnce(&EffectDispatchPermit<'_>) -> T,
    ) -> Result<T, AuthorityError> {
        self.session.with_effect_dispatch(token, dispatch)
    }

    fn close_with<T>(&mut self, error: ControlDriverError) -> Result<T, ControlDriverError> {
        self.close();
        Err(error)
    }

    fn close(&mut self) {
        self.session.connection_lost();
        self.pending_prepare = None;
        self.channel = None;
    }
}

impl<R, W> Drop for RunnerControlDriver<R, W> {
    fn drop(&mut self) {
        self.session.connection_lost();
        self.pending_prepare = None;
        self.channel = None;
    }
}
