use std::fmt::Debug;
use std::sync::Arc;

use agent_protocol::frame::{
    AsyncBootstrapAttemptChannel, BootstrapReceiveOutcome, CONTROL_FRAME_MAX_BYTES,
    MAX_REPLAY_WINDOW_ENTRIES, MAX_TRACKED_MESSAGE_IDS,
};
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::PendingRunnerLaunchNonce;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::authority::EffectClock;
use super::driver::SystemControlClock;
use super::session::RunnerControlSession;
use super::{AsyncRunnerControlDriver, RunnerLaunchContext};

mod error;

pub use error::AsyncRunnerBootstrapError;

const MAX_CONTROL_REPLAY_ENTRIES: usize = 64;
const MAX_CONTROL_REPLAY_BYTES: usize = 8 * 1024 * 1024;

/// Async, single-use path from a validated launch to an established driver.
pub struct AsyncRunnerBootstrapDriver<S> {
    channel: Option<AsyncBootstrapAttemptChannel<S>>,
    session: Option<RunnerControlSession>,
    clock: Arc<dyn EffectClock>,
    replay_capacity: usize,
    total_identity_capacity: usize,
    max_replay_bytes: usize,
}

impl<S> Debug for AsyncRunnerBootstrapDriver<S> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsyncRunnerBootstrapDriver")
            .field("channel_open", &self.channel.is_some())
            .field("session", &self.session)
            .field("replay_capacity", &self.replay_capacity)
            .field("total_identity_capacity", &self.total_identity_capacity)
            .field("max_replay_bytes", &self.max_replay_bytes)
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerBootstrapDriver<S> {
    pub(crate) fn from_validated_launch(
        stream: S,
        launch: RunnerLaunchContext,
    ) -> Result<Self, AsyncRunnerBootstrapError> {
        Self::build(stream, launch, SystemControlClock::new())
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.channel.is_none()
    }

    pub async fn establish_with_nonce(
        mut self,
        agent_hello_draft: wire::AgentHello,
        launch_nonce: PendingRunnerLaunchNonce,
        deadline: Instant,
    ) -> Result<AsyncRunnerControlDriver<S>, AsyncRunnerBootstrapError> {
        self.send_agent_hello(agent_hello_draft, launch_nonce, deadline)
            .await?;
        self.finish_establish(deadline).await
    }

    async fn finish_establish(
        mut self,
        deadline: Instant,
    ) -> Result<AsyncRunnerControlDriver<S>, AsyncRunnerBootstrapError> {
        let clock = Arc::clone(&self.clock);
        let received = match self
            .channel
            .as_mut()
            .ok_or(AsyncRunnerBootstrapError::Closed)?
            .receive(deadline, || clock.now_unix_ms())
            .await
        {
            Ok(received) => received,
            Err(error) => return self.close_with(error.into()),
        };
        let BootstrapReceiveOutcome::HostHello(host_hello) = received else {
            return self.close_with(AsyncRunnerBootstrapError::UnexpectedHello);
        };
        let staged = match self
            .session
            .as_ref()
            .ok_or(AsyncRunnerBootstrapError::Closed)?
            .plan_host_hello(host_hello)
        {
            Ok(staged) => staged,
            Err(error) => return self.close_with(error.into()),
        };
        let (seed, committed) = staged.into_parts();
        let channel = self
            .channel
            .take()
            .ok_or(AsyncRunnerBootstrapError::Closed)?;
        let established = match channel.into_established(
            seed,
            self.replay_capacity,
            self.total_identity_capacity,
            self.max_replay_bytes,
        ) {
            Ok(established) => established,
            Err(error) => return self.close_with(error.into()),
        };
        let mut session = self
            .session
            .take()
            .ok_or(AsyncRunnerBootstrapError::Closed)?;
        session.install_host_hello(committed);
        Ok(AsyncRunnerControlDriver::from_shared_clock(
            established,
            session,
            Arc::clone(&self.clock),
        ))
    }

    #[cfg(test)]
    pub(in crate::control) fn with_clock<C: EffectClock + 'static>(
        stream: S,
        launch: RunnerLaunchContext,
        clock: C,
    ) -> Result<Self, AsyncRunnerBootstrapError> {
        Self::build(stream, launch, clock)
    }

    fn build<C: EffectClock + 'static>(
        stream: S,
        launch: RunnerLaunchContext,
        clock: C,
    ) -> Result<Self, AsyncRunnerBootstrapError> {
        u32::try_from(CONTROL_FRAME_MAX_BYTES)
            .map_err(|_| AsyncRunnerBootstrapError::InvalidControlCap(CONTROL_FRAME_MAX_BYTES))?;
        let expected_identity = launch.identity().clone();
        let expected_connection = launch.expected_connection_id().clone();
        let frame_budget = launch.resource_budget().max_ipc_frames as usize;
        let replay_capacity = frame_budget
            .min(MAX_CONTROL_REPLAY_ENTRIES)
            .min(MAX_REPLAY_WINDOW_ENTRIES);
        // In-flight credits bound concurrency, not the lifetime of heartbeat ACKs.
        let total_identity_capacity = MAX_TRACKED_MESSAGE_IDS;
        let max_replay_bytes = usize::try_from(launch.resource_budget().max_ipc_bytes)
            .unwrap_or(usize::MAX)
            .min(MAX_CONTROL_REPLAY_BYTES);
        let channel = AsyncBootstrapAttemptChannel::new(
            stream,
            expected_identity,
            expected_connection,
            CONTROL_FRAME_MAX_BYTES,
        )?;
        let session = RunnerControlSession::new(launch)?;
        Ok(Self {
            channel: Some(channel),
            session: Some(session),
            clock: Arc::new(clock),
            replay_capacity,
            total_identity_capacity,
            max_replay_bytes,
        })
    }

    async fn send_agent_hello(
        &mut self,
        draft: wire::AgentHello,
        nonce: PendingRunnerLaunchNonce,
        deadline: Instant,
    ) -> Result<(), AsyncRunnerBootstrapError> {
        let pending = self
            .session
            .as_ref()
            .ok_or(AsyncRunnerBootstrapError::Closed)?
            .plan_agent_hello_draft(&draft)
            .map_err(AsyncRunnerBootstrapError::from)?;
        let hello = nonce.prepare_agent_hello(draft)?;
        let clock = Arc::clone(&self.clock);
        if let Err(error) = hello
            .commit_async(
                self.channel
                    .as_mut()
                    .ok_or(AsyncRunnerBootstrapError::Closed)?,
                deadline,
                || clock.now_unix_ms(),
            )
            .await
        {
            return self.close_with(error.into());
        }
        self.session
            .as_mut()
            .ok_or(AsyncRunnerBootstrapError::Closed)?
            .install_agent_hello(pending);
        Ok(())
    }

    fn close_with<T>(
        &mut self,
        error: AsyncRunnerBootstrapError,
    ) -> Result<T, AsyncRunnerBootstrapError> {
        self.close();
        Err(error)
    }

    fn close(&mut self) {
        if let Some(session) = self.session.as_mut() {
            session.connection_lost();
        }
        self.session = None;
        self.channel = None;
    }
}

impl<S> Drop for AsyncRunnerBootstrapDriver<S> {
    fn drop(&mut self) {
        if let Some(session) = self.session.as_mut() {
            session.connection_lost();
        }
        self.session = None;
        self.channel = None;
    }
}
