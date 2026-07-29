use std::sync::Arc;

use agent_protocol::frame::{AsyncEstablishedAttemptChannel, InboundBinding, PendingInbound};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncControlDriverError, AsyncRunnerControlDriver};
use crate::control::ack::control_ack;
use crate::control::driver::ControlDriverEvent;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(super) async fn handle_activate(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        binding: InboundBinding,
        request: wire::ActivateAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        let attempt_deadline_at_unix_ms = request.deadline_at_unix_ms;
        let plan = match self
            .session
            .plan_activate(request, digest, binding, observed_at_unix_ms)
        {
            Ok(plan) => plan,
            Err(error) => return self.reject_control(channel, pending, error),
        };
        let response_at_unix_ms = match self.now() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        let write_timeout_ms = match self.session.write_timeout_ms() {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        let response_deadline_at_unix_ms = response_at_unix_ms
            .saturating_add(i64::try_from(write_timeout_ms).unwrap_or(i64::MAX))
            .min(attempt_deadline_at_unix_ms);
        if response_at_unix_ms >= response_deadline_at_unix_ms {
            return self.close_with(AsyncControlDriverError::DeadlineElapsed {
                operation: "ActivateAck write",
                deadline: response_deadline_at_unix_ms,
                observed: response_at_unix_ms,
            });
        }
        let physical_deadline =
            match self.write_deadline(response_deadline_at_unix_ms, "ActivateAck write") {
                Ok(value) => value,
                Err(error) => return self.close_with(error),
            };
        let response = control_ack(
            pending.header().message_id.clone(),
            digest,
            response_at_unix_ms,
        );
        let authority_clock = Arc::clone(&self.clock);
        let committed = match channel
            .commit_response(
                pending,
                &response,
                response_deadline_at_unix_ms,
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
                operation: "ActivateAck write",
                started_at: response_at_unix_ms,
                completed_at,
            });
        }
        if completed_at >= response_deadline_at_unix_ms {
            return self.close_with(AsyncControlDriverError::DeadlineElapsed {
                operation: "ActivateAck write",
                deadline: response_deadline_at_unix_ms,
                observed: completed_at,
            });
        }
        let Some(committed) = plan.bind(committed.into_receipt()) else {
            return self.close_with(AsyncControlDriverError::InboundBindingMismatch);
        };
        let outcome = self.session.install_activation(committed, authority_clock);
        Ok(ControlDriverEvent::Activate(outcome))
    }
}
