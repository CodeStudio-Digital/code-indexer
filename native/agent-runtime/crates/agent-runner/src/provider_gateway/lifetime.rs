use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{ProviderDataClock, ProviderDataGateway, ProviderGatewayError};
use crate::provider_data::ProviderWireEvent;

// Reserve enough identities to settle the admitted 256-tool response, its
// checkpoint and terminal. Stop a provider stream before spending this reserve.
const SETTLEMENT_IDENTITIES: usize = 8_192;

impl<S, C> ProviderDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    pub(crate) const fn enforce_identity_budget(&mut self) {
        self.identity_reserve = Some(SETTLEMENT_IDENTITIES);
    }

    pub(super) async fn start_or_checkpoint(
        &mut self,
        start: wire::ProviderStart,
    ) -> Result<bool, ProviderGatewayError> {
        let signal = self.first_start_signal.take();
        let mut client = self.client.lock().await;
        if self
            .identity_reserve
            .is_some_and(|reserve| client.identity_budget_reached(reserve))
        {
            // Persist the new settled frontier even though no provider is opened.
            client
                .checkpoint(start, self.timing, self.clock.as_ref())
                .await
                .map_err(ProviderGatewayError::Data)?;
            drop(client);
            if let Some(signal) = signal {
                let _ = signal.send(());
            }
            return Ok(false);
        }
        client
            .start_observed(start, self.timing, self.clock.as_ref(), move || {
                if let Some(signal) = signal {
                    let _ = signal.send(());
                }
            })
            .await
            .map_err(ProviderGatewayError::Data)?;
        drop(client);
        Ok(true)
    }

    pub(super) async fn next_with_budget(&self) -> Result<ProviderWireEvent, ProviderGatewayError> {
        let mut client = self.client.lock().await;
        if self
            .identity_reserve
            .is_some_and(|reserve| client.identity_budget_reached(reserve))
        {
            return client
                .interrupt_at_identity_budget(self.timing, self.clock.as_ref())
                .await
                .map_err(ProviderGatewayError::Data);
        }
        client
            .next(self.timing, self.clock.as_ref())
            .await
            .map_err(ProviderGatewayError::Data)
    }
}
