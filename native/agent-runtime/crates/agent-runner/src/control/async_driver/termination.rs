use agent_protocol::frame::{
    AsyncEstablishedAttemptChannel, CommittedInbound, InboundBinding, PendingInbound,
};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncControlDriverError, AsyncRunnerControlDriver};
use crate::control::ack::control_ack;
use crate::control::driver::ControlDriverEvent;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(super) async fn handle_cancel(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        binding: InboundBinding,
        request: wire::CancelAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        let grace_deadline_at_unix_ms = request.grace_deadline_at_unix_ms;
        let plan = match self
            .session
            .plan_cancel(request, digest, binding, observed_at_unix_ms)
        {
            Ok(plan) => plan,
            Err(error) => return self.reject_control(channel, pending, error),
        };

        self.session.revoke_effects();
        let receipt = self
            .commit_termination_ack(
                channel,
                pending,
                digest,
                grace_deadline_at_unix_ms,
                "CancelAttempt Ack write",
            )
            .await?;
        let Some(committed) = plan.bind(receipt) else {
            return self.close_with(AsyncControlDriverError::InboundBindingMismatch);
        };
        Ok(ControlDriverEvent::Cancel(
            self.session.install_cancel(committed),
        ))
    }

    pub(super) async fn handle_fence(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        binding: InboundBinding,
        request: wire::FenceAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        let plan = match self
            .session
            .plan_fence(request, digest, binding, observed_at_unix_ms)
        {
            Ok(plan) => plan,
            Err(error) => return self.reject_control(channel, pending, error),
        };

        self.session.revoke_effects();
        let receipt = self
            .commit_termination_ack(
                channel,
                pending,
                digest,
                self.session.effective_deadline_at_unix_ms(),
                "FenceAttempt Ack write",
            )
            .await?;
        let Some(committed) = plan.bind(receipt) else {
            return self.close_with(AsyncControlDriverError::InboundBindingMismatch);
        };
        Ok(ControlDriverEvent::Fence(
            self.session.install_fence(committed),
        ))
    }

    async fn commit_termination_ack(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        digest: [u8; 32],
        semantic_limit_at_unix_ms: i64,
        operation: &'static str,
    ) -> Result<CommittedInbound, AsyncControlDriverError> {
        let response_at_unix_ms = match self.now() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        let write_timeout_ms = match self.session.write_timeout_ms() {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        let timeout_deadline =
            response_at_unix_ms.saturating_add(i64::try_from(write_timeout_ms).unwrap_or(i64::MAX));
        let response_deadline = semantic_limit_at_unix_ms
            .min(self.session.effective_deadline_at_unix_ms())
            .min(timeout_deadline);
        if response_at_unix_ms >= response_deadline {
            return self.close_with(AsyncControlDriverError::DeadlineElapsed {
                operation,
                deadline: response_deadline,
                observed: response_at_unix_ms,
            });
        }
        let physical_deadline = match self.write_deadline(response_deadline, operation) {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        let response = control_ack(
            pending.header().message_id.clone(),
            digest,
            response_at_unix_ms,
        );
        let committed = match channel
            .commit_response(
                pending,
                &response,
                response_deadline,
                physical_deadline,
                || response_at_unix_ms,
            )
            .await
        {
            Ok(committed) => committed,
            Err(error) => return self.close_with(error.into()),
        };
        let completed_at = match self.now() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        if completed_at < response_at_unix_ms {
            return self.close_with(AsyncControlDriverError::ClockRegressed {
                operation,
                started_at: response_at_unix_ms,
                completed_at,
            });
        }
        if completed_at >= response_deadline {
            return self.close_with(AsyncControlDriverError::DeadlineElapsed {
                operation,
                deadline: response_deadline,
                observed: completed_at,
            });
        }
        Ok(committed.into_receipt())
    }
}
