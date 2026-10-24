use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{
    ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming, ProviderWireEvent,
};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    pub(super) async fn acknowledge_consumed<C: ProviderDataClock>(
        &mut self,
        event: &ProviderWireEvent,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<(), ProviderDataError> {
        if !self.consumption_ack_required {
            return Ok(());
        }
        let (operation_id, event_sequence) = match event {
            ProviderWireEvent::Text(value) => (&value.operation_id, value.event_sequence),
            ProviderWireEvent::Thinking(value) => (&value.operation_id, value.event_sequence),
            ProviderWireEvent::ToolCall(value) => (&value.operation_id, value.event_sequence),
            ProviderWireEvent::Usage(value) => (&value.operation_id, value.event_sequence),
            ProviderWireEvent::Terminal(_) => return Ok(()),
        };
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::ProviderEventConsumed(
                wire::ProviderEventConsumed {
                    identity: Some(self.identity.clone()),
                    operation_id: operation_id.clone(),
                    event_sequence,
                },
            )),
        };
        self.channel
            .send_new(
                &payload,
                timing.settlement_deadline_at_unix_ms,
                timing.hard_deadline,
                || clock.now_unix_ms(),
            )
            .await?;
        Ok(())
    }

    pub(super) fn buffer_event(
        &mut self,
        event: ProviderWireEvent,
    ) -> Result<(), ProviderDataError> {
        // Cancellation may terminate the stream while its single data credit
        // is still buffered. Reserve one extra slot for that terminal only.
        if self.consumption_ack_required
            && !self.buffered_events.is_empty()
            && (!event.is_terminal() || self.buffered_events.len() >= 2)
        {
            return Err(ProviderDataError::UnexpectedPayload(
                "provider exceeded its unconsumed event credit",
            ));
        }
        self.buffered_events.push_back(event);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_protocol::testing::established_data_duplex;

    #[tokio::test]
    async fn credit_bounds_buffered_events_and_reserves_one_cancellation_terminal() {
        let identity = crate::provider_data::tests::identity();
        let (runner, _host) = established_data_duplex(&identity).unwrap();
        let mut client = ProviderDataClient::new(runner, identity, "runtime/credit".into());
        client.consumption_ack_required = true;
        let text = ProviderWireEvent::Text(wire::ProviderTextDelta::default());
        client.buffer_event(text.clone()).unwrap();
        assert!(client.buffer_event(text).is_err());
        let terminal = ProviderWireEvent::Terminal(wire::ProviderTerminal::default());
        client.buffer_event(terminal.clone()).unwrap();
        assert!(client.buffer_event(terminal).is_err());
        assert_eq!(client.buffered_events.len(), 2);
    }
}
