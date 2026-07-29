use std::sync::Arc;

use super::{AttemptFrameReceiver, InboundFrameError, ReplayedFrame};

#[derive(Debug)]
pub(super) struct ReplayReservation {
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
    response: Option<Arc<[u8]>>,
}

impl ReplayReservation {
    pub(super) fn new(frame: &ReplayedFrame, response: Option<Arc<[u8]>>) -> Self {
        Self {
            message_id: frame.message_id().to_owned(),
            stream_seq: frame.stream_seq(),
            envelope_digest: *frame.envelope_digest(),
            response,
        }
    }

    fn matches(&self, replay: &ReplayedFrame) -> bool {
        self.message_id == replay.message_id()
            && self.stream_seq == replay.stream_seq()
            && self.envelope_digest == *replay.envelope_digest()
    }
}

impl AttemptFrameReceiver {
    pub(in crate::frame) fn take_replay_response(
        &mut self,
        replay: &ReplayedFrame,
    ) -> Result<Option<Arc<[u8]>>, InboundFrameError> {
        let reservation = self
            .replay
            .take()
            .ok_or(InboundFrameError::InvalidReplayReservation)?;
        if !reservation.matches(replay) {
            self.poison();
            return Err(InboundFrameError::InvalidReplayReservation);
        }
        Ok(reservation.response)
    }
}
