use agent_protocol::management_channel::{AsyncSentManagementFrame, SentManagementFrame};

/// Transport-neutral correlation for one management frame committed to I/O.
///
/// This receipt is not authority: it carries only the message ID and verified
/// payload digest needed by the bounded physical-fact ledger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::management) struct ManagementEnvelopeReceipt {
    message_id: String,
    payload_digest: [u8; 32],
}

impl ManagementEnvelopeReceipt {
    pub(in crate::management) fn message_id(&self) -> &str {
        &self.message_id
    }

    pub(in crate::management) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }

    #[cfg(test)]
    pub(crate) fn for_test(message_id: &str, payload_digest: [u8; 32]) -> Self {
        Self {
            message_id: message_id.into(),
            payload_digest,
        }
    }
}

impl From<&SentManagementFrame> for ManagementEnvelopeReceipt {
    fn from(sent: &SentManagementFrame) -> Self {
        Self {
            message_id: sent.message_id().to_owned(),
            payload_digest: *sent.payload_digest(),
        }
    }
}

impl From<&AsyncSentManagementFrame> for ManagementEnvelopeReceipt {
    fn from(sent: &AsyncSentManagementFrame) -> Self {
        Self {
            message_id: sent.message_id().to_owned(),
            payload_digest: *sent.payload_digest(),
        }
    }
}
