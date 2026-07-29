use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;

use prost::Message;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio::time::Instant;

use super::{
    AsyncQueuedManagementWrite, AsyncSentManagementFrame, CommandQueues, OutboundCommand,
    OutboundPriority, ScrubbedPayload, priority,
};
use crate::generated::v1 as wire;
use crate::management_channel::ManagementChannelError;
use crate::management_channel::async_actor::{AsyncManagementActorError, AsyncManagementPolicy};

#[derive(Clone)]
pub struct AsyncManagementCommandPort {
    urgent: mpsc::Sender<OutboundCommand>,
    normal: mpsc::Sender<OutboundCommand>,
    urgent_bytes: Arc<Semaphore>,
    normal_bytes: Arc<Semaphore>,
    admission: Arc<Semaphore>,
    reservation_bytes: u32,
    queue_timeout: std::time::Duration,
}

impl Debug for AsyncManagementCommandPort {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncManagementCommandPort")
            .field("reservation_bytes", &self.reservation_bytes)
            .finish_non_exhaustive()
    }
}

impl AsyncManagementCommandPort {
    /// # Errors
    ///
    /// Rejects oversized payloads, saturated bounds, and closed actors.
    pub fn enqueue(
        &self,
        payload: wire::ManagementPayload,
    ) -> Result<AsyncQueuedManagementWrite, AsyncManagementActorError> {
        let guarded = ScrubbedPayload::new(payload);
        let encoded_len = guarded.get().encoded_len();
        if encoded_len > self.reservation_bytes as usize {
            return Err(ManagementChannelError::FrameTooLarge {
                length: encoded_len,
                maximum: self.reservation_bytes as usize,
            }
            .into());
        }
        let priority = priority(guarded.get());
        let byte_budget = match priority {
            OutboundPriority::Urgent => Arc::clone(&self.urgent_bytes),
            OutboundPriority::Normal => Arc::clone(&self.normal_bytes),
        };
        let (written, receiver) = oneshot::channel();
        let command = OutboundCommand::new(
            guarded,
            Arc::clone(&self.admission)
                .try_acquire_owned()
                .map_err(|_| AsyncManagementActorError::CommandQueueSaturated)?,
            byte_budget
                .try_acquire_many_owned(self.reservation_bytes)
                .map_err(|_| AsyncManagementActorError::CommandQueueSaturated)?,
            Instant::now() + self.queue_timeout,
            written,
        );
        let sender = match priority {
            OutboundPriority::Urgent => &self.urgent,
            OutboundPriority::Normal => &self.normal,
        };
        sender.try_send(command).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => AsyncManagementActorError::CommandQueueSaturated,
            mpsc::error::TrySendError::Closed(_) => AsyncManagementActorError::CommandQueueClosed,
        })?;
        Ok(AsyncQueuedManagementWrite::new(receiver))
    }

    /// # Errors
    ///
    /// Propagates admission, protocol, physical write, and lifecycle failures.
    pub async fn send(
        &self,
        payload: wire::ManagementPayload,
    ) -> Result<AsyncSentManagementFrame, AsyncManagementActorError> {
        self.enqueue(payload)?.written().await
    }
}

impl CommandQueues {
    pub(in crate::management_channel::async_actor) fn new(
        policy: &AsyncManagementPolicy,
    ) -> (AsyncManagementCommandPort, Self) {
        let (urgent_sender, urgent) = mpsc::channel(policy.urgent_queue_frames());
        let (normal_sender, normal) = mpsc::channel(policy.normal_queue_frames());
        let port = AsyncManagementCommandPort {
            urgent: urgent_sender,
            normal: normal_sender,
            urgent_bytes: Arc::new(Semaphore::new(policy.urgent_queue_bytes() as usize)),
            normal_bytes: Arc::new(Semaphore::new(policy.normal_queue_bytes() as usize)),
            admission: Arc::new(Semaphore::new(
                policy
                    .urgent_queue_frames()
                    .saturating_add(policy.normal_queue_frames()),
            )),
            reservation_bytes: policy.maximum_frame_bytes(),
            queue_timeout: policy.write_timeout(),
        };
        (
            port,
            Self {
                urgent,
                normal,
                urgent_open: true,
                normal_open: true,
            },
        )
    }
}
