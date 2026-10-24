use super::{ProviderDataClock, ProviderDataGateway, ProviderGatewayError, provider_start};
use agent_engine::ports::{ProviderFrontierPort, ProviderRequest};
use tokio::io::{AsyncRead, AsyncWrite};

impl<S, C> ProviderDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    /// Shares the authenticated Data owner; never duplicates an active stream.
    pub(crate) fn frontier_port(&self) -> Self {
        Self {
            client: self.client.clone(),
            identity: self.identity.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            binding: self.binding.clone(),
            timing: self.timing,
            clock: self.clock.clone(),
            max_context_bytes: self.max_context_bytes,
            first_start_signal: None,
            identity_reserve: self.identity_reserve,
        }
    }
}

impl<S, C> ProviderFrontierPort for ProviderDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    type Error = ProviderGatewayError;
    async fn checkpoint(&mut self, request: ProviderRequest) -> Result<(), Self::Error> {
        let (start, _) = provider_start(
            &self.identity,
            &self.binding,
            self.max_context_bytes,
            &request,
        )?;
        self.client
            .lock()
            .await
            .checkpoint(start, self.timing, self.clock.as_ref())
            .await
            .map_err(ProviderGatewayError::Data)
    }
}
