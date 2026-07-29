use std::time::Duration;

use tokio::io::DuplexStream;
use tokio::time::Instant;

use super::super::{AsyncDelimitedFrameChannel, AsyncFramingError};
use crate::framing::DelimitedFrameCodec;
use crate::management_frame::MANAGEMENT_FRAME_MAX_BYTES;

pub(super) const TEST_TIMEOUT: Duration = Duration::from_millis(25);

pub(super) fn management_channel(stream: DuplexStream) -> AsyncDelimitedFrameChannel<DuplexStream> {
    let maximum = u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management cap fits u32");
    let codec = DelimitedFrameCodec::new(maximum).expect("management codec");
    AsyncDelimitedFrameChannel::new(codec, stream)
}

pub(super) fn deadline() -> Instant {
    Instant::now() + TEST_TIMEOUT
}

pub(super) async fn assert_permanently_poisoned(
    channel: &mut AsyncDelimitedFrameChannel<DuplexStream>,
) {
    assert!(channel.is_poisoned());
    let error = channel
        .receive(deadline())
        .await
        .expect_err("permanent poison");
    assert!(matches!(error, AsyncFramingError::ChannelPoisoned));
}
