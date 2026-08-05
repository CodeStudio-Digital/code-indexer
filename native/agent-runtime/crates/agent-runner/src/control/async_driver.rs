use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use agent_protocol::frame::{AsyncEstablishedAttemptChannel, PendingInbound};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use crate::lifecycle::RunnerState;

use super::RunnerExecutionSeed;
use super::authority::EffectClock;
use super::driver::ControlDriverEvent;
use super::session::RunnerControlSession;
use super::{EffectivePreparedFacts, HydrationToken};

mod activation;
mod active;
mod debug;
mod error;
mod heartbeat;
mod inbound;
mod operation;
mod provider_context;
mod termination;
mod transaction;

pub use error::AsyncControlDriverError;
use operation::AsyncControlOperation;

#[derive(Debug)]
struct AsyncHeldPrepare {
    inbound: PendingInbound,
}

/// Sole async owner of an established control channel and attempt state.
///
/// A cancelled I/O future poisons and drops its stream. Dropping this driver
/// revokes any installed effect authority.
pub struct AsyncRunnerControlDriver<S> {
    channel: Option<AsyncEstablishedAttemptChannel<S>>,
    session: RunnerControlSession,
    clock: Arc<dyn EffectClock>,
    pending_prepare: Option<AsyncHeldPrepare>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    #[must_use]
    pub const fn state(&self) -> RunnerState {
        self.session.state()
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.channel.is_none()
    }

    pub(crate) fn owner_now_unix_ms(&self) -> i64 {
        self.clock.now_unix_ms()
    }

    pub(crate) fn take_execution_seed(&mut self) -> Option<RunnerExecutionSeed> {
        self.session.take_execution_seed()
    }

    pub(crate) fn active_effect_gate(&self) -> Option<super::authority::EffectGate> {
        self.session.active_effect_gate()
    }

    #[cfg(test)]
    pub(in crate::control) fn effect_gate_for_test(&self) -> Option<super::authority::EffectGate> {
        self.session.effect_gate.clone()
    }

    pub fn receive_next(
        &mut self,
    ) -> impl Future<Output = Result<ControlDriverEvent, AsyncControlDriverError>> + '_ {
        let operation = if self.pending_prepare.is_some() {
            Err(AsyncControlDriverError::PrepareInFlight)
        } else {
            AsyncControlOperation::new(self)
        };
        async move {
            let mut operation = operation?;
            let result = {
                let (driver, channel) = operation.parts();
                driver.receive_next_inner(channel).await
            };
            if result.is_ok() {
                operation.commit();
            }
            result
        }
    }

    pub fn finish_prepare(
        &mut self,
        token: HydrationToken,
        facts: EffectivePreparedFacts,
    ) -> impl Future<Output = Result<(), AsyncControlDriverError>> + '_ {
        let operation = if self.pending_prepare.is_none() {
            Err(AsyncControlDriverError::NoPrepareInFlight)
        } else {
            AsyncControlOperation::new(self)
        };
        async move {
            let mut operation = operation?;
            let result = {
                let (driver, channel) = operation.parts();
                driver.finish_prepare_inner(channel, token, facts).await
            };
            if result.is_ok() {
                operation.commit();
            }
            result
        }
    }

    pub fn abort_prepare(&mut self) -> Result<(), AsyncControlDriverError> {
        let pending = self
            .pending_prepare
            .take()
            .ok_or(AsyncControlDriverError::NoPrepareInFlight)?
            .inbound;
        let rejected = self
            .channel
            .as_mut()
            .map_or(Err(AsyncControlDriverError::Closed), |channel| {
                channel.reject(pending).map_err(Into::into)
            });
        self.close();
        rejected
    }

    pub fn reap_if_expired(&mut self) -> Result<bool, AsyncControlDriverError> {
        if self.is_closed() {
            return Ok(false);
        }
        let observed = match self.now() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        if observed < self.session.effective_deadline_at_unix_ms() {
            return Ok(false);
        }
        if self.pending_prepare.is_some() {
            self.abort_prepare()?;
        } else {
            self.close();
        }
        Ok(true)
    }

    pub(in crate::control) fn from_shared_clock(
        channel: AsyncEstablishedAttemptChannel<S>,
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

    pub(crate) fn hard_deadline(&self) -> Result<Instant, AsyncControlDriverError> {
        self.physical_deadline(
            self.session.effective_deadline_at_unix_ms(),
            None,
            "attempt",
        )
    }

    pub(crate) fn close(&mut self) {
        self.session.connection_lost();
        self.pending_prepare = None;
        self.channel = None;
    }

    fn read_deadline(&self) -> Result<Instant, AsyncControlDriverError> {
        self.physical_deadline(
            self.session.effective_deadline_at_unix_ms(),
            Some(self.session.read_timeout_ms()?),
            "control read",
        )
    }

    fn write_deadline(
        &self,
        semantic_deadline: i64,
        operation: &'static str,
    ) -> Result<Instant, AsyncControlDriverError> {
        self.physical_deadline(
            semantic_deadline.min(self.session.effective_deadline_at_unix_ms()),
            Some(self.session.write_timeout_ms()?),
            operation,
        )
    }

    fn physical_deadline(
        &self,
        semantic_deadline: i64,
        timeout_ms: Option<u64>,
        operation: &'static str,
    ) -> Result<Instant, AsyncControlDriverError> {
        let now = self.now()?;
        let timeout_deadline = timeout_ms
            .and_then(|timeout| i64::try_from(timeout).ok())
            .map_or(i64::MAX, |timeout| now.saturating_add(timeout));
        let deadline = semantic_deadline.min(timeout_deadline);
        if now >= deadline {
            return Err(AsyncControlDriverError::DeadlineElapsed {
                operation,
                deadline,
                observed: now,
            });
        }
        let remaining = u64::try_from(deadline - now)
            .map_err(|_| AsyncControlDriverError::InvalidClockReading(now))?;
        Instant::now()
            .checked_add(Duration::from_millis(remaining))
            .ok_or(AsyncControlDriverError::InvalidClockReading(now))
    }

    fn now(&self) -> Result<i64, AsyncControlDriverError> {
        let value = self.clock.now_unix_ms();
        if value <= 0 {
            return Err(AsyncControlDriverError::InvalidClockReading(value));
        }
        Ok(value)
    }

    fn close_with<T>(
        &mut self,
        error: AsyncControlDriverError,
    ) -> Result<T, AsyncControlDriverError> {
        self.close();
        Err(error)
    }
}

impl<S> Drop for AsyncRunnerControlDriver<S> {
    fn drop(&mut self) {
        self.session.connection_lost();
        self.pending_prepare = None;
        self.channel = None;
    }
}
