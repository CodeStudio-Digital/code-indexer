use std::time::Duration;

use super::ManagementSemantics;
use crate::generated::v1 as wire;
use crate::management_channel::{ManagementChannelError, PendingManagementInbound};

impl ManagementSemantics {
    pub(in crate::management_channel::async_actor) fn outstanding_wait(&self) -> Option<Duration> {
        self.sender
            .earliest_outstanding_deadline_at()
            .map(|deadline| {
                let remaining = deadline.saturating_sub(self.clock.now_unix_ms());
                Duration::from_millis(u64::try_from(remaining).unwrap_or(0))
            })
    }

    pub(in crate::management_channel::async_actor) fn pending_wait(
        &self,
        pending: &PendingManagementInbound,
    ) -> Duration {
        let now = self.clock.now_unix_ms();
        pending_deadline(pending).map_or_else(
            || Duration::from_millis(self.session.frame_limits().read_timeout_ms),
            |deadline| {
                Duration::from_millis(u64::try_from(deadline.saturating_sub(now)).unwrap_or(0))
            },
        )
    }

    pub(in crate::management_channel::async_actor) fn write_wait(
        &self,
        deadline_at: i64,
    ) -> Result<Duration, ManagementChannelError> {
        let observed_at = self.clock.now_unix_ms();
        if observed_at >= deadline_at {
            return Err(ManagementChannelError::DeadlineExpired {
                deadline_at,
                observed_at,
            });
        }
        Ok(Duration::from_millis(
            u64::try_from(deadline_at - observed_at).unwrap_or(0),
        ))
    }

    pub(super) fn ensure_pending_live(
        &self,
        pending: &PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        let observed_at = self.clock.now_unix_ms();
        if let Some(deadline_at) = pending_deadline(pending)
            && observed_at >= deadline_at
        {
            return Err(ManagementChannelError::DeadlineExpired {
                deadline_at,
                observed_at,
            });
        }
        Ok(())
    }
}

const fn payload_deadline(body: &wire::management_payload::Body) -> Option<i64> {
    use wire::management_payload::Body;
    match body {
        Body::LaunchAttemptProcess(value) => Some(value.hard_deadline_at_unix_ms),
        Body::UpdateAttemptAuthority(value) => Some(value.authority_lease_expires_at_unix_ms),
        Body::CancelAttemptProcess(value) => Some(value.grace_deadline_at_unix_ms),
        Body::ReapAttemptProcess(value) => Some(value.reap_deadline_at_unix_ms),
        Body::ShutdownSupervisor(value) => Some(value.shutdown_deadline_at_unix_ms),
        _ => None,
    }
}

fn pending_deadline(pending: &PendingManagementInbound) -> Option<i64> {
    let frame = pending.header().deadline_at_unix_ms;
    let payload = pending.body().and_then(payload_deadline);
    match (frame, payload) {
        (Some(frame), Some(payload)) => Some(frame.min(payload)),
        (Some(frame), None) => Some(frame),
        (None, Some(payload)) => Some(payload),
        (None, None) => None,
    }
}
