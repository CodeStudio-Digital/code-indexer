use std::time::Duration;

use crate::management_channel::{
    MAX_MANAGEMENT_REPLAY_BYTES, MAX_MANAGEMENT_REPLAY_ENTRIES, MAX_MANAGEMENT_TRACKED_IDS,
    ManagementChannelError, ManagementReplayLimits, ManagementSessionPolicy,
};

const MAX_URGENT_QUEUE_FRAMES: usize = 8;
const MAX_NORMAL_QUEUE_FRAMES: usize = 64;

#[derive(Debug, Clone)]
pub struct AsyncManagementPolicy {
    session: ManagementSessionPolicy,
    maximum_frame_bytes: u32,
    maximum_chunk_bytes: u64,
    read_progress_timeout: Duration,
    write_timeout: Duration,
    urgent_queue_frames: usize,
    normal_queue_frames: usize,
    event_queue_frames: usize,
    normal_queue_bytes: u32,
    urgent_queue_bytes: u32,
    replay: ManagementReplayLimits,
}

impl AsyncManagementPolicy {
    pub(super) fn derive(
        session: &ManagementSessionPolicy,
    ) -> Result<Self, ManagementChannelError> {
        let frame = session.frame_limits();
        let limits = session.limits();
        let maximum_frame_bytes = u32::try_from(frame.max_frame_bytes)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
        let in_flight_frames = usize::try_from(frame.max_in_flight_frames)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
        let normal_queue_frames = usize::try_from(limits.max_pending_launches)
            .map_err(|_| ManagementChannelError::InvalidSupervisorLimits)?;
        let normal_queue_bytes = u32::try_from(frame.max_in_flight_bytes)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
        let entries = in_flight_frames.min(MAX_MANAGEMENT_REPLAY_ENTRIES);
        // Lifetime replay identities are independent of simultaneous commands.
        // Renewals must not exhaust a small in-flight window after a few minutes.
        let tracked = MAX_MANAGEMENT_TRACKED_IDS;
        let replay_bytes = usize::try_from(frame.max_in_flight_bytes)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?
            .min(MAX_MANAGEMENT_REPLAY_BYTES);
        Ok(Self {
            session: session.clone(),
            maximum_frame_bytes,
            maximum_chunk_bytes: frame.max_chunk_bytes,
            read_progress_timeout: Duration::from_millis(frame.read_timeout_ms),
            write_timeout: Duration::from_millis(frame.write_timeout_ms),
            urgent_queue_frames: in_flight_frames.clamp(1, MAX_URGENT_QUEUE_FRAMES),
            normal_queue_frames: normal_queue_frames.clamp(1, MAX_NORMAL_QUEUE_FRAMES),
            event_queue_frames: in_flight_frames.max(1),
            normal_queue_bytes,
            urgent_queue_bytes: maximum_frame_bytes,
            replay: ManagementReplayLimits::new(entries, tracked, replay_bytes)?,
        })
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> u32 {
        self.maximum_frame_bytes
    }

    #[must_use]
    pub const fn maximum_chunk_bytes(&self) -> u64 {
        self.maximum_chunk_bytes
    }

    #[must_use]
    pub const fn read_progress_timeout(&self) -> Duration {
        self.read_progress_timeout
    }

    #[must_use]
    pub const fn write_timeout(&self) -> Duration {
        self.write_timeout
    }

    #[must_use]
    pub const fn session_policy(&self) -> &ManagementSessionPolicy {
        &self.session
    }

    pub(super) const fn urgent_queue_frames(&self) -> usize {
        self.urgent_queue_frames
    }

    pub(super) const fn normal_queue_frames(&self) -> usize {
        self.normal_queue_frames
    }

    pub(super) const fn event_queue_frames(&self) -> usize {
        self.event_queue_frames
    }

    pub(super) const fn normal_queue_bytes(&self) -> u32 {
        self.normal_queue_bytes
    }

    pub(super) const fn urgent_queue_bytes(&self) -> u32 {
        self.urgent_queue_bytes
    }

    pub(super) const fn replay_limits(&self) -> ManagementReplayLimits {
        self.replay
    }
}
