use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::generated::v1 as wire;

use super::super::launch::RunnerLaunchContext;
use super::ControlError;

const MAX_CONTROL_CHUNK_BYTES: u64 = 64 * 1024;
const MAX_CONTROL_IN_FLIGHT_FRAMES: u64 = 1_024;
const MAX_CONTROL_IN_FLIGHT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CONTROL_IO_TIMEOUT_MS: u64 = 5 * 60 * 1_000;

pub(super) struct ValidatedFrameLimits {
    pub maximum_frame_bytes: usize,
    pub read_timeout_ms: u64,
    pub write_timeout_ms: u64,
}

pub(super) fn validate_frame_limits(
    value: &wire::FrameLimits,
    launch: &RunnerLaunchContext,
) -> Result<ValidatedFrameLimits, ControlError> {
    let max_frame = usize::try_from(value.max_frame_bytes)
        .map_err(|_| ControlError::InvalidHostHello("frame limit exceeds usize"))?;
    let budget = launch.resource_budget();
    if max_frame == 0
        || max_frame > CONTROL_FRAME_MAX_BYTES
        || value.max_chunk_bytes == 0
        || value.max_chunk_bytes > value.max_frame_bytes
        || value.max_chunk_bytes > MAX_CONTROL_CHUNK_BYTES
        || value.max_in_flight_frames == 0
        || value.max_in_flight_frames > MAX_CONTROL_IN_FLIGHT_FRAMES
        || value.max_in_flight_frames > u64::from(budget.max_ipc_frames)
        || value.max_in_flight_bytes < value.max_frame_bytes
        || value.max_in_flight_bytes > MAX_CONTROL_IN_FLIGHT_BYTES
        || value.max_in_flight_bytes > budget.max_ipc_bytes
        || value.read_timeout_ms == 0
        || value.read_timeout_ms > MAX_CONTROL_IO_TIMEOUT_MS
        || value.read_timeout_ms > budget.max_wall_ms
        || value.write_timeout_ms == 0
        || value.write_timeout_ms > MAX_CONTROL_IO_TIMEOUT_MS
        || value.write_timeout_ms > budget.max_wall_ms
        || value.transport_crc32c
    {
        return Err(ControlError::InvalidHostHello(
            "frame limits are invalid or exceed the hard control cap",
        ));
    }
    Ok(ValidatedFrameLimits {
        maximum_frame_bytes: max_frame,
        read_timeout_ms: value.read_timeout_ms,
        write_timeout_ms: value.write_timeout_ms,
    })
}
