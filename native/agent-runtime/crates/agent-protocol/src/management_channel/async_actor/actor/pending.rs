use tokio::io::AsyncWrite;
use tokio::time::{Instant, sleep_until};

use super::ManagementActor;
use super::writer::FrameWriteDeadline;
use crate::generated::v1 as wire;
use crate::management_channel::PendingManagementInbound;
use crate::management_channel::async_actor::event::{
    AsyncManagementEvent, AsyncPendingManagementInbound, EventSender, InboundResolution,
    InboundResolutionKind,
};
use crate::management_channel::async_actor::semantics::PreparedResponse;
use crate::management_channel::async_actor::worker::ReaderWorker;
use crate::management_channel::async_actor::{AsyncManagementActorError, AsyncSentManagementFrame};

type WrittenSender =
    tokio::sync::oneshot::Sender<Result<AsyncSentManagementFrame, AsyncManagementActorError>>;

impl<W: AsyncWrite + Unpin> ManagementActor<W> {
    pub(super) async fn process_pending(
        &mut self,
        pending: Box<PendingManagementInbound>,
        worker: &ReaderWorker,
        events: &EventSender,
    ) -> bool {
        let pending_wait = self.semantics.pending_wait(&pending);
        let (pending, mut resolution) =
            AsyncPendingManagementInbound::new(pending, self.durable_ack_required);
        if events
            .try_send(Ok(AsyncManagementEvent::Pending(pending)))
            .is_err()
        {
            return false;
        }
        let pending_at = Instant::now() + pending_wait;
        let outstanding_wait = self.semantics.outstanding_wait();
        let outstanding =
            tokio::time::sleep(outstanding_wait.unwrap_or(std::time::Duration::from_hours(1)));
        let deadline = sleep_until(pending_at);
        tokio::pin!(outstanding);
        tokio::pin!(deadline);
        tokio::select! {
            biased;
            () = &mut deadline => {
                let _ = events.try_send(Err(
                    AsyncManagementActorError::PendingInboundDeadlineElapsed,
                ));
                false
            }
            () = &mut outstanding, if outstanding_wait.is_some() => {
                let _ = events.try_send(Err(
                    AsyncManagementActorError::OutstandingDeadlineElapsed,
                ));
                false
            }
            resolved = &mut resolution => match resolved {
                Ok(resolved) => self.resolve_pending(resolved, worker, pending_at).await,
                Err(_) => false,
            },
        }
    }

    async fn resolve_pending(
        &mut self,
        resolved: InboundResolution,
        worker: &ReaderWorker,
        pending_at: Instant,
    ) -> bool {
        match resolved.kind {
            InboundResolutionKind::Reject => {
                let _ = self.semantics.reject(resolved.pending);
                false
            }
            InboundResolutionKind::Respond(payload) => {
                self.write_response(
                    resolved.pending,
                    (*payload).take(),
                    resolved.written,
                    pending_at,
                )
                .await
                    && worker.request_next().is_ok()
            }
            InboundResolutionKind::Acknowledge => {
                self.write_ack(resolved.pending, resolved.written, pending_at)
                    .await
                    && worker.request_next().is_ok()
            }
        }
    }

    async fn write_ack(
        &mut self,
        inbound: Box<PendingManagementInbound>,
        written: Option<WrittenSender>,
        pending_at: Instant,
    ) -> bool {
        let prepared = match self.semantics.prepare_ack(inbound) {
            Ok(prepared) => prepared,
            Err(error) => return finish_response(written, Err(error.into())),
        };
        self.write_prepared_response(prepared, written, pending_at)
            .await
    }

    async fn write_response(
        &mut self,
        inbound: Box<PendingManagementInbound>,
        payload: wire::ManagementPayload,
        written: Option<WrittenSender>,
        pending_at: Instant,
    ) -> bool {
        let prepared = match self.semantics.prepare_response(inbound, payload) {
            Ok(prepared) => prepared,
            Err(error) => return finish_response(written, Err(error.into())),
        };
        self.write_prepared_response(prepared, written, pending_at)
            .await
    }

    async fn write_prepared_response(
        &mut self,
        prepared: PreparedResponse,
        written: Option<WrittenSender>,
        pending_at: Instant,
    ) -> bool {
        let deadline = FrameWriteDeadline::Header(prepared.deadline_at_unix_ms());
        if let Err(error) = self
            .write_frame(prepared.encoded(), deadline, Some(pending_at))
            .await
        {
            return finish_response(written, Err(error));
        }
        let result = self.semantics.commit_response(prepared).map_err(Into::into);
        finish_response(written, result)
    }
}

fn finish_response(
    written: Option<WrittenSender>,
    result: Result<AsyncSentManagementFrame, AsyncManagementActorError>,
) -> bool {
    let success = result.is_ok();
    if let Some(written) = written {
        let _ = written.send(result);
    }
    success
}
