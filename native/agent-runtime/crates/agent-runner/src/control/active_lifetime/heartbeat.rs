use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::super::{AsyncControlDriverError, AsyncRunnerControlDriver};

pub(super) struct ActiveHeartbeatSchedule {
    interval: std::time::Duration,
    next_at: Instant,
    last_progress_at_unix_ms: i64,
    last_event_seq: u64,
}

impl ActiveHeartbeatSchedule {
    pub(super) fn new<S>(
        driver: &AsyncRunnerControlDriver<S>,
    ) -> Result<Self, AsyncControlDriverError>
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static,
    {
        let interval = driver.heartbeat_interval()?;
        let next_at = Instant::now()
            .checked_add(interval)
            .ok_or(AsyncControlDriverError::InvalidHeartbeatSchedule)?;
        let last_progress_at_unix_ms = driver.owner_now_unix_ms();
        if last_progress_at_unix_ms <= 0 {
            return Err(AsyncControlDriverError::InvalidClockReading(
                last_progress_at_unix_ms,
            ));
        }
        Ok(Self {
            interval,
            next_at,
            last_progress_at_unix_ms,
            last_event_seq: 0,
        })
    }

    pub(super) fn next_wake(&self, hard_deadline: Instant) -> Instant {
        self.next_at.min(hard_deadline)
    }

    pub(super) async fn emit<S>(
        &mut self,
        driver: &mut AsyncRunnerControlDriver<S>,
        resources: wire::ResourceSample,
    ) -> Result<(), AsyncControlDriverError>
    where
        S: AsyncRead + AsyncWrite + Unpin + 'static,
    {
        driver
            .send_heartbeat(
                self.last_progress_at_unix_ms,
                self.last_event_seq,
                resources,
            )
            .await?;
        self.next_at = Instant::now()
            .checked_add(self.interval)
            .ok_or(AsyncControlDriverError::InvalidHeartbeatSchedule)?;
        Ok(())
    }
}
