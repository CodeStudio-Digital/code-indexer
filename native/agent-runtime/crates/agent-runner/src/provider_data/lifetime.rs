use std::time::Duration;

use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::{
    ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming, ProviderWireEvent,
};

pub const IDENTITY_BUDGET_REASON: &str = "ipc_identity_budget";

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    pub(crate) fn identity_budget_reached(&self, reserve: usize) -> bool {
        self.channel.remaining_identity_capacity() <= reserve
    }

    /// Consume the bounded cancellation tail before writing the durable terminal.
    /// An unresponsive/invalid peer still fails closed; never discard its frames.
    pub(crate) async fn interrupt_at_identity_budget<C: ProviderDataClock>(
        &mut self,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<ProviderWireEvent, ProviderDataError> {
        let timing = ProviderDataTiming {
            hard_deadline: timing
                .hard_deadline
                .min(Instant::now() + Duration::from_secs(2)),
            ..timing
        };
        if let Some(active) = &self.active {
            self.cancel(
                wire::ProviderCancel {
                    identity: Some(self.identity.clone()),
                    operation_id: active.operation_id.clone(),
                    reason_code: IDENTITY_BUDGET_REASON.into(),
                    idempotency_key: format!("identity-budget:{}", active.operation_id),
                },
                timing.settlement_deadline_at_unix_ms,
                timing,
                clock,
            )
            .await?;
        }
        // The product has one unconsumed data credit plus a terminal slot.
        // A small allowance also handles a usage event already being settled.
        for _ in 0..8 {
            if let ProviderWireEvent::Terminal(mut terminal) = self.next(timing, clock).await? {
                terminal.classification = wire::ProviderTerminalClassification::Cancelled as i32;
                terminal.reason_code = IDENTITY_BUDGET_REASON.into();
                terminal.response_id = None;
                terminal.response_message_count = None;
                return Ok(ProviderWireEvent::Terminal(terminal));
            }
        }
        Err(ProviderDataError::UnexpectedPayload(
            "provider did not settle its identity-budget cancellation",
        ))
    }
}
