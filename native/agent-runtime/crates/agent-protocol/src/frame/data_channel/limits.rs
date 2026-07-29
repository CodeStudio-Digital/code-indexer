use std::time::Duration;

use crate::frame::DATA_FRAME_MAX_BYTES;
use crate::generated::v1 as wire;

use super::DataChannelError;

const MAX_DATA_IO_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const DATA_FRAME_OVERHEAD_RESERVE_BYTES: u64 = 16 * 1_024;

/// Protocol-bounded limits advertised only after the data endpoint is bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataChannelLimits {
    wire: wire::FrameLimits,
    maximum_frame_bytes: usize,
}

impl DataChannelLimits {
    /// Validates the runner-selected stop-and-wait data policy.
    ///
    /// Resource-budget checks remain the runner's responsibility; this layer
    /// enforces transport truthfulness and immutable protocol caps.
    ///
    /// # Errors
    ///
    /// Rejects zero, widening, pipelined, CRC, or unbounded timeout settings.
    pub fn new(value: wire::FrameLimits) -> Result<Self, DataChannelError> {
        let maximum_frame_bytes = usize::try_from(value.max_frame_bytes)
            .map_err(|_| DataChannelError::InvalidLimits("frame cap exceeds usize"))?;
        if maximum_frame_bytes == 0 || maximum_frame_bytes > DATA_FRAME_MAX_BYTES {
            return Err(DataChannelError::InvalidLimits(
                "frame cap exceeds the immutable data cap",
            ));
        }
        if value.max_frame_bytes <= DATA_FRAME_OVERHEAD_RESERVE_BYTES
            || value.max_chunk_bytes == 0
            || value.max_chunk_bytes > value.max_frame_bytes - DATA_FRAME_OVERHEAD_RESERVE_BYTES
        {
            return Err(DataChannelError::InvalidLimits(
                "chunk cap does not reserve bounded envelope overhead",
            ));
        }
        if value.max_in_flight_frames != 1 || value.max_in_flight_bytes != value.max_frame_bytes {
            return Err(DataChannelError::InvalidLimits(
                "data transport must use one-frame stop-and-wait credit",
            ));
        }
        if value.read_timeout_ms == 0
            || value.read_timeout_ms > MAX_DATA_IO_TIMEOUT_MS
            || value.write_timeout_ms == 0
            || value.write_timeout_ms > MAX_DATA_IO_TIMEOUT_MS
        {
            return Err(DataChannelError::InvalidLimits(
                "I/O timeout is zero or exceeds the hard policy cap",
            ));
        }
        if value.transport_crc32c {
            return Err(DataChannelError::InvalidLimits(
                "CRC32C is not negotiated by protocol v1",
            ));
        }
        Ok(Self {
            wire: value,
            maximum_frame_bytes,
        })
    }

    #[must_use]
    pub const fn as_wire(&self) -> &wire::FrameLimits {
        &self.wire
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> usize {
        self.maximum_frame_bytes
    }

    #[must_use]
    pub const fn maximum_chunk_bytes(&self) -> u64 {
        self.wire.max_chunk_bytes
    }

    #[must_use]
    pub const fn read_timeout(&self) -> Duration {
        Duration::from_millis(self.wire.read_timeout_ms)
    }

    #[must_use]
    pub const fn write_timeout(&self) -> Duration {
        Duration::from_millis(self.wire.write_timeout_ms)
    }
}
