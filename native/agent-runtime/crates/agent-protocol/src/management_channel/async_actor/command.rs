use std::fmt::{self, Debug, Formatter};

use tokio::sync::{OwnedSemaphorePermit, mpsc, oneshot};
use tokio::time::Instant;

use super::AsyncManagementActorError;
use crate::generated::v1 as wire;
use crate::management_channel::ManagementPayloadKind;
use crate::management_secrets::scrub_protected_body;

mod port;

pub use port::AsyncManagementCommandPort;

#[derive(Debug)]
pub struct AsyncSentManagementFrame {
    stream_seq: u64,
    message_id: String,
    payload_digest: [u8; 32],
}

impl AsyncSentManagementFrame {
    pub(super) const fn new(stream_seq: u64, message_id: String, payload_digest: [u8; 32]) -> Self {
        Self {
            stream_seq,
            message_id,
            payload_digest,
        }
    }

    #[must_use]
    pub const fn stream_seq(&self) -> u64 {
        self.stream_seq
    }

    #[must_use]
    pub fn message_id(&self) -> &str {
        &self.message_id
    }

    #[must_use]
    pub const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }
}

pub struct AsyncQueuedManagementWrite {
    written: oneshot::Receiver<Result<AsyncSentManagementFrame, AsyncManagementActorError>>,
}

impl Debug for AsyncQueuedManagementWrite {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncQueuedManagementWrite")
            .finish_non_exhaustive()
    }
}

impl AsyncQueuedManagementWrite {
    pub(super) const fn new(
        written: oneshot::Receiver<Result<AsyncSentManagementFrame, AsyncManagementActorError>>,
    ) -> Self {
        Self { written }
    }

    /// # Errors
    ///
    /// Returns the actor's terminal protocol or physical write failure.
    pub async fn written(self) -> Result<AsyncSentManagementFrame, AsyncManagementActorError> {
        self.written
            .await
            .unwrap_or(Err(AsyncManagementActorError::ActorClosed))
    }
}

pub(super) struct CommandQueues {
    pub urgent: mpsc::Receiver<OutboundCommand>,
    pub normal: mpsc::Receiver<OutboundCommand>,
    pub urgent_open: bool,
    pub normal_open: bool,
}

pub(super) struct OutboundCommand {
    payload: ScrubbedPayload,
    _byte_permit: OwnedSemaphorePermit,
    _admission_permit: OwnedSemaphorePermit,
    deadline: Instant,
    written: Option<oneshot::Sender<Result<AsyncSentManagementFrame, AsyncManagementActorError>>>,
}

impl OutboundCommand {
    const fn new(
        payload: ScrubbedPayload,
        admission_permit: OwnedSemaphorePermit,
        byte_permit: OwnedSemaphorePermit,
        deadline: Instant,
        written: oneshot::Sender<Result<AsyncSentManagementFrame, AsyncManagementActorError>>,
    ) -> Self {
        Self {
            payload,
            _byte_permit: byte_permit,
            _admission_permit: admission_permit,
            deadline,
            written: Some(written),
        }
    }

    pub(super) const fn take_payload(&mut self) -> wire::ManagementPayload {
        self.payload.take()
    }

    pub(super) fn is_expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    pub(super) fn finish(
        mut self,
        result: Result<AsyncSentManagementFrame, AsyncManagementActorError>,
    ) {
        if let Some(written) = self.written.take() {
            let _ = written.send(result);
        }
    }
}

struct ScrubbedPayload(Option<wire::ManagementPayload>);

impl ScrubbedPayload {
    const fn new(payload: wire::ManagementPayload) -> Self {
        Self(Some(payload))
    }

    const fn get(&self) -> &wire::ManagementPayload {
        self.0.as_ref().expect("guarded payload is present")
    }

    const fn take(&mut self) -> wire::ManagementPayload {
        self.0.take().expect("guarded payload is consumed once")
    }
}

impl Drop for ScrubbedPayload {
    fn drop(&mut self) {
        if let Some(payload) = &mut self.0
            && let Some(body) = &mut payload.body
        {
            scrub_protected_body(body);
        }
    }
}

#[derive(Clone, Copy)]
enum OutboundPriority {
    Urgent,
    Normal,
}

const fn priority(payload: &wire::ManagementPayload) -> OutboundPriority {
    let Some(body) = payload.body.as_ref() else {
        return OutboundPriority::Normal;
    };
    match ManagementPayloadKind::from_body(body) {
        ManagementPayloadKind::ManagementAck
        | ManagementPayloadKind::UpdateAttemptAuthority
        | ManagementPayloadKind::CancelAttemptProcess
        | ManagementPayloadKind::FenceAttemptProcess
        | ManagementPayloadKind::ReapAttemptProcess
        | ManagementPayloadKind::ShutdownSupervisor
        | ManagementPayloadKind::SupervisorFault => OutboundPriority::Urgent,
        _ => OutboundPriority::Normal,
    }
}
