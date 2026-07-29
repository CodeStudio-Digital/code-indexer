#[derive(Clone)]
pub struct InboundBinding {
    receiver_id: u64,
    token: u64,
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
}

impl InboundBinding {
    pub(super) const fn new(
        receiver_id: u64,
        token: u64,
        message_id: String,
        stream_seq: u64,
        envelope_digest: [u8; 32],
    ) -> Self {
        Self {
            receiver_id,
            token,
            message_id,
            stream_seq,
            envelope_digest,
        }
    }

    #[must_use]
    pub fn matches(&self, other: &Self) -> bool {
        self.receiver_id == other.receiver_id
            && self.token == other.token
            && self.message_id == other.message_id
            && self.stream_seq == other.stream_seq
            && self.envelope_digest == other.envelope_digest
    }
}

impl std::fmt::Debug for InboundBinding {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("InboundBinding(<opaque>)")
    }
}

/// Opaque proof emitted only after an inbound transaction is committed.
///
/// It intentionally has no public constructor and is not `Clone`.
///
/// ```compile_fail
/// use agent_protocol::frame::CommittedInbound;
/// let _forged = CommittedInbound {};
/// ```
pub struct CommittedInbound {
    receiver_id: u64,
    token: u64,
    message_id: String,
    stream_seq: u64,
    envelope_digest: [u8; 32],
}

impl CommittedInbound {
    pub(super) const fn new(
        receiver_id: u64,
        token: u64,
        message_id: String,
        stream_seq: u64,
        envelope_digest: [u8; 32],
    ) -> Self {
        Self {
            receiver_id,
            token,
            message_id,
            stream_seq,
            envelope_digest,
        }
    }

    #[must_use]
    pub fn matches(&self, binding: &InboundBinding) -> bool {
        self.receiver_id == binding.receiver_id
            && self.token == binding.token
            && self.message_id == binding.message_id
            && self.stream_seq == binding.stream_seq
            && self.envelope_digest == binding.envelope_digest
    }
}

impl std::fmt::Debug for CommittedInbound {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CommittedInbound(<opaque>)")
    }
}
