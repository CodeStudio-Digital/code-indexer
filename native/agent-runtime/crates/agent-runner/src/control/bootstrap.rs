use std::io::{Read, Write};
use std::sync::Arc;

use agent_protocol::frame::{
    BootstrapAttemptChannel, BootstrapReceiveOutcome, CONTROL_FRAME_MAX_BYTES, FrameDirection,
    MAX_REPLAY_WINDOW_ENTRIES, MAX_TRACKED_MESSAGE_IDS,
};
use agent_protocol::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::PendingRunnerLaunchNonce;

use super::authority::EffectClock;
use super::driver::SystemControlClock;
use super::session::RunnerControlSession;
use super::{RunnerControlDriver, RunnerLaunchContext};

mod error;

pub use error::RunnerBootstrapError;

const MAX_CONTROL_REPLAY_ENTRIES: usize = 64;
const MAX_CONTROL_REPLAY_BYTES: usize = 8 * 1024 * 1024;

/// Sole public path from trusted launch authority to an established driver.
///
/// The same private monotonic clock owns bootstrap send/receive, established
/// send/receive, activation, and deadline reaping.
#[derive(Debug)]
pub struct RunnerBootstrapDriver<R, W> {
    channel: Option<BootstrapAttemptChannel<R, W>>,
    session: Option<RunnerControlSession>,
    clock: Arc<dyn EffectClock>,
    replay_capacity: usize,
    total_identity_capacity: usize,
    max_replay_bytes: usize,
}

impl<R: Read, W: Write> RunnerBootstrapDriver<R, W> {
    pub(crate) fn from_validated_launch(
        reader: R,
        writer: W,
        launch: RunnerLaunchContext,
    ) -> Result<Self, RunnerBootstrapError> {
        Self::build(reader, writer, launch, SystemControlClock::new())
    }

    #[must_use]
    pub const fn is_closed(&self) -> bool {
        self.channel.is_none()
    }

    /// Sends `AgentHello`, receives `HostHello`, and consumes this owner into
    /// an established driver.
    ///
    /// # Errors
    ///
    /// Any receive, negotiation, seed, cap, or handoff failure closes the
    /// transport and discards staged session state.
    pub fn establish_with_nonce(
        mut self,
        agent_hello_draft: wire::AgentHello,
        launch_nonce: PendingRunnerLaunchNonce,
    ) -> Result<RunnerControlDriver<R, W>, RunnerBootstrapError> {
        self.send_agent_hello_with_nonce(agent_hello_draft, launch_nonce)?;
        self.finish_establish()
    }

    fn finish_establish(mut self) -> Result<RunnerControlDriver<R, W>, RunnerBootstrapError> {
        let clock = Arc::clone(&self.clock);
        let received = match self
            .channel
            .as_mut()
            .ok_or(RunnerBootstrapError::Closed)?
            .receive(|| clock.now_unix_ms())
        {
            Ok(received) => received,
            Err(error) => return self.close_with(error.into()),
        };
        let BootstrapReceiveOutcome::HostHello(host_hello) = received else {
            return self.close_with(RunnerBootstrapError::UnexpectedHello);
        };
        let staged = match self
            .session
            .as_ref()
            .ok_or(RunnerBootstrapError::Closed)?
            .plan_host_hello(host_hello)
        {
            Ok(staged) => staged,
            Err(error) => return self.close_with(error.into()),
        };
        let (seed, committed) = staged.into_parts();
        let channel = self.channel.take().ok_or(RunnerBootstrapError::Closed)?;
        let established = match channel.into_established(
            seed,
            self.replay_capacity,
            self.total_identity_capacity,
            self.max_replay_bytes,
        ) {
            Ok(established) => established,
            Err(error) => return self.close_with(error.into()),
        };
        let mut session = self.session.take().ok_or(RunnerBootstrapError::Closed)?;
        session.install_host_hello(committed);
        Ok(RunnerControlDriver::from_shared_clock(
            established,
            session,
            Arc::clone(&self.clock),
        ))
    }

    #[cfg(test)]
    pub(in crate::control) fn with_clock<C: EffectClock + 'static>(
        reader: R,
        writer: W,
        launch: RunnerLaunchContext,
        clock: C,
    ) -> Result<Self, RunnerBootstrapError> {
        Self::build(reader, writer, launch, clock)
    }

    fn build<C: EffectClock + 'static>(
        reader: R,
        writer: W,
        launch: RunnerLaunchContext,
        clock: C,
    ) -> Result<Self, RunnerBootstrapError> {
        let physical_cap = u32::try_from(CONTROL_FRAME_MAX_BYTES)
            .map_err(|_| RunnerBootstrapError::InvalidControlCap(CONTROL_FRAME_MAX_BYTES))?;
        let codec = DelimitedFrameCodec::new(physical_cap)?;
        let expected_identity = launch.identity().clone();
        let expected_connection = launch.expected_connection_id().clone();
        let budget = launch.resource_budget();
        let frame_budget = budget.max_ipc_frames as usize;
        let replay_capacity = frame_budget
            .min(MAX_CONTROL_REPLAY_ENTRIES)
            .min(MAX_REPLAY_WINDOW_ENTRIES);
        // In-flight credits bound concurrency, not the lifetime of heartbeat ACKs.
        let total_identity_capacity = MAX_TRACKED_MESSAGE_IDS;
        let max_replay_bytes = usize::try_from(budget.max_ipc_bytes)
            .unwrap_or(usize::MAX)
            .min(MAX_CONTROL_REPLAY_BYTES);
        let transport = DelimitedFrameChannel::new(codec, reader, writer);
        let channel = BootstrapAttemptChannel::new(
            transport,
            expected_identity,
            expected_connection,
            FrameDirection::HostToRunner,
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

    fn send_agent_hello_with_nonce(
        &mut self,
        draft: wire::AgentHello,
        launch_nonce: PendingRunnerLaunchNonce,
    ) -> Result<(), RunnerBootstrapError> {
        let pending = match self.session.as_ref() {
            Some(session) => session.plan_agent_hello_draft(&draft),
            None => return Err(RunnerBootstrapError::Closed),
        };
        let pending = match pending {
            Ok(pending) => pending,
            Err(error) => return self.close_with(error.into()),
        };
        let hello = match launch_nonce.prepare_agent_hello(draft) {
            Ok(hello) => hello,
            Err(error) => return self.close_with(error.into()),
        };
        let clock = Arc::clone(&self.clock);
        let sent = hello.commit(
            self.channel.as_mut().ok_or(RunnerBootstrapError::Closed)?,
            || clock.now_unix_ms(),
        );
        if let Err(error) = sent {
            return self.close_with(error.into());
        }
        self.session
            .as_mut()
            .ok_or(RunnerBootstrapError::Closed)?
            .install_agent_hello(pending);
        Ok(())
    }
}

impl<R, W> RunnerBootstrapDriver<R, W> {
    fn close_with<T>(&mut self, error: RunnerBootstrapError) -> Result<T, RunnerBootstrapError> {
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

impl<R, W> Drop for RunnerBootstrapDriver<R, W> {
    fn drop(&mut self) {
        self.close();
    }
}
