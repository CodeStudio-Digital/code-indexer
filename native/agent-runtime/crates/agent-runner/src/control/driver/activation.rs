use std::io::{Read, Write};
use std::sync::Arc;

use agent_protocol::frame::{InboundBinding, PendingInbound};
use agent_protocol::generated::v1 as wire;

use super::{ControlDriverError, ControlDriverEvent, RunnerControlDriver};

impl<R: Read, W: Write> RunnerControlDriver<R, W> {
    pub(super) fn handle_activate(
        &mut self,
        pending: PendingInbound,
        binding: InboundBinding,
        request: wire::ActivateAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, ControlDriverError> {
        let attempt_deadline_at_unix_ms = request.deadline_at_unix_ms;
        let plan = match self
            .session
            .plan_activate(request, digest, binding, observed_at_unix_ms)
        {
            Ok(plan) => plan,
            Err(error) => return self.reject_control(pending, error),
        };
        let write_timeout_ms = match self.session.write_timeout_ms() {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        let response_at_unix_ms = self.clock.now_unix_ms();
        let response_deadline_at_unix_ms = match activation_ack_deadline(
            attempt_deadline_at_unix_ms,
            response_at_unix_ms,
            write_timeout_ms,
        ) {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        if response_at_unix_ms >= response_deadline_at_unix_ms {
            return self.close_with(ControlDriverError::ActivationAckDeadlineElapsed {
                deadline: response_deadline_at_unix_ms,
                observed: response_at_unix_ms,
            });
        }
        let response = activation_ack(
            pending.header().message_id.clone(),
            digest,
            response_at_unix_ms,
        );
        let authority_clock = Arc::clone(&self.clock);
        // `std::io::Write` cannot interrupt a blocked physical write. The
        // negotiated timeout bounds whether its receipt is accepted, and this
        // post-write check fails closed; the process reaper remains the
        // backstop for a writer that never returns.
        let committed = match self
            .channel
            .as_mut()
            .ok_or(ControlDriverError::Closed)?
            .commit_response(pending, &response, response_deadline_at_unix_ms, || {
                response_at_unix_ms
            }) {
            Ok(committed) => committed,
            Err(error) => return self.close_with(error.into()),
        };
        let write_completed_at_unix_ms = self.clock.now_unix_ms();
        if write_completed_at_unix_ms <= 0 {
            return self.close_with(ControlDriverError::InvalidClockReading(
                write_completed_at_unix_ms,
            ));
        }
        if write_completed_at_unix_ms < response_at_unix_ms {
            return self.close_with(ControlDriverError::ActivationAckClockRegressed {
                write_started_at: response_at_unix_ms,
                write_completed_at: write_completed_at_unix_ms,
            });
        }
        if write_completed_at_unix_ms >= response_deadline_at_unix_ms {
            return self.close_with(ControlDriverError::ActivationAckDeadlineElapsed {
                deadline: response_deadline_at_unix_ms,
                observed: write_completed_at_unix_ms,
            });
        }
        let Some(committed) = plan.bind(committed.into_receipt()) else {
            return self.close_with(ControlDriverError::InboundBindingMismatch);
        };
        let outcome = self.session.install_activation(committed, authority_clock);
        Ok(ControlDriverEvent::Activate(outcome))
    }
}

fn activation_ack_deadline(
    attempt_deadline_at_unix_ms: i64,
    write_started_at_unix_ms: i64,
    write_timeout_ms: u64,
) -> Result<i64, ControlDriverError> {
    if write_started_at_unix_ms <= 0 {
        return Err(ControlDriverError::InvalidClockReading(
            write_started_at_unix_ms,
        ));
    }
    let timeout = i64::try_from(write_timeout_ms)
        .map_err(|_| ControlDriverError::InvalidClockReading(write_started_at_unix_ms))?;
    Ok(attempt_deadline_at_unix_ms.min(write_started_at_unix_ms.saturating_add(timeout)))
}

fn activation_ack(
    message_id: String,
    payload_sha256: [u8; 32],
    acknowledged_at_unix_ms: i64,
) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::Ack(wire::Ack {
            acknowledged_message_id: message_id,
            acknowledged_payload_sha256: payload_sha256.to_vec(),
            acknowledged_at_unix_ms,
        })),
    }
}
