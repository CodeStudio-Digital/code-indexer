use agent_protocol::frame::{AsyncEstablishedAttemptChannel, PendingInbound};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncControlDriverError, AsyncRunnerControlDriver};
use crate::control::ControlError;
use crate::control::driver::ControlDriverEvent;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(super) async fn handle_pending(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        mut pending: PendingInbound,
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        let decoded = self.session.take_inbound(&mut pending);
        let (binding, body, digest) = match decoded {
            Ok(decoded) => decoded,
            Err(error) => return self.reject_control(channel, pending, error),
        };
        match body {
            wire::frame_payload::Body::PrepareAttempt(request) => {
                self.handle_prepare(
                    channel,
                    pending,
                    &binding,
                    request,
                    digest,
                    observed_at_unix_ms,
                )
                .await
            }
            wire::frame_payload::Body::ActivateAttempt(request) => {
                self.handle_activate(
                    channel,
                    pending,
                    binding,
                    request,
                    digest,
                    observed_at_unix_ms,
                )
                .await
            }
            wire::frame_payload::Body::CancelAttempt(request) => {
                self.handle_cancel(
                    channel,
                    pending,
                    binding,
                    request,
                    digest,
                    observed_at_unix_ms,
                )
                .await
            }
            wire::frame_payload::Body::FenceAttempt(request) => {
                self.handle_fence(
                    channel,
                    pending,
                    binding,
                    request,
                    digest,
                    observed_at_unix_ms,
                )
                .await
            }
            _ => self.reject_control(
                channel,
                pending,
                ControlError::UnexpectedInboundMessage(
                    "not PrepareAttempt, ActivateAttempt, CancelAttempt, or FenceAttempt",
                ),
            ),
        }
    }
}
