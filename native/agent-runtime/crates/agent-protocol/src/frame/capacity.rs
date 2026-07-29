use crate::generated::v1 as wire;

pub const MANAGEMENT_FRAME_MAX_BYTES: usize = 64 * 1024;
pub const PULSE_FRAME_MAX_BYTES: usize = 4 * 1024;
pub const CONTROL_FRAME_MAX_BYTES: usize = 256 * 1024;
pub const DATA_FRAME_MAX_BYTES: usize = 1_024 * 1_024;

#[must_use]
pub const fn maximum_frame_bytes(channel: wire::TransportChannel) -> Option<usize> {
    match channel {
        wire::TransportChannel::Management => Some(MANAGEMENT_FRAME_MAX_BYTES),
        wire::TransportChannel::Pulse => Some(PULSE_FRAME_MAX_BYTES),
        wire::TransportChannel::Control => Some(CONTROL_FRAME_MAX_BYTES),
        wire::TransportChannel::Data => Some(DATA_FRAME_MAX_BYTES),
        wire::TransportChannel::Unspecified => None,
    }
}
