use std::future::Future;
use std::sync::Arc;

use agent_engine::ports::{ProviderEvent, ProviderGatewayPort, ProviderRequest};
use agent_protocol::frame::AsyncEstablishedAttemptChannel;
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, oneshot};

use crate::capability_gateway::CapabilityDataGateway;
use crate::provider_data::{ProviderDataClient, ProviderDataClock, ProviderDataTiming};
use crate::provider_event_sink::ProviderEventDataSink;

mod error;
mod mapping;
mod operation;
mod request;

pub use error::ProviderGatewayError;
use mapping::map_wire_event;
pub use operation::ProviderDataOperation;
use operation::settle_provider_event;
use request::provider_start;

#[derive(Debug)]
pub struct ProviderDataGateway<S, C> {
    client: Arc<Mutex<ProviderDataClient<S>>>,
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    binding: wire::ProviderBinding,
    timing: ProviderDataTiming,
    clock: Arc<C>,
    max_context_bytes: usize,
    first_start_signal: Option<oneshot::Sender<()>>,
}

impl<S, C> ProviderDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    /// Creates the single-attempt provider port from sealed runtime authority.
    ///
    /// # Errors
    ///
    /// Rejects an empty context budget or unresolved provider binding.
    pub fn new(
        channel: AsyncEstablishedAttemptChannel<S>,
        identity: wire::AttemptIdentity,
        runtime_instance_id: String,
        binding: wire::ProviderBinding,
        timing: ProviderDataTiming,
        clock: C,
        max_context_bytes: usize,
    ) -> Result<Self, ProviderGatewayError> {
        if max_context_bytes == 0
            || binding.effective_provider.is_empty()
            || binding.effective_model.is_empty()
        {
            return Err(ProviderGatewayError::InvalidAuthority);
        }
        Ok(Self {
            client: Arc::new(Mutex::new(ProviderDataClient::new(
                channel,
                identity.clone(),
                runtime_instance_id.clone(),
            ))),
            identity,
            runtime_instance_id,
            binding,
            timing,
            clock: Arc::new(clock),
            max_context_bytes,
            first_start_signal: None,
        })
    }

    /// Installs the startup barrier completed after `ProviderStart` has been
    /// physically written, without waiting for the Host/provider response.
    pub(crate) fn signal_first_start_with(&mut self, signal: oneshot::Sender<()>) {
        self.first_start_signal = Some(signal);
    }

    /// Creates the event half of the single-owner Data plane. Both ports share
    /// one authenticated channel; the provider client serializes access and
    /// buffers stream events that arrive while a durable receipt is pending.
    ///
    /// # Errors
    ///
    /// Rejects a missing semantic deadline or zero local event sequence.
    pub fn event_sink(
        &self,
        semantic_deadline_at_unix_ms: i64,
        next_local_sequence: u64,
    ) -> Result<ProviderEventDataSink<S, C>, ProviderGatewayError> {
        if semantic_deadline_at_unix_ms <= 0 || next_local_sequence == 0 {
            return Err(ProviderGatewayError::InvalidAuthority);
        }
        Ok(ProviderEventDataSink::new(
            Arc::clone(&self.client),
            self.identity.clone(),
            self.runtime_instance_id.clone(),
            semantic_deadline_at_unix_ms,
            self.timing,
            Arc::clone(&self.clock),
            next_local_sequence,
        ))
    }

    /// Creates the pre-dispatch capability port over the same authenticated
    /// Data owner used by provider events and durable engine receipts.
    ///
    /// # Errors
    ///
    /// Rejects an empty input budget or invalid capability-set digest.
    pub(crate) fn capability_gateway(
        &self,
        capability_set_sha256: &[u8],
        maximum_input_bytes: usize,
    ) -> Result<CapabilityDataGateway<S, C>, ProviderGatewayError> {
        let capability_set_sha256 = capability_set_sha256
            .try_into()
            .map_err(|_| ProviderGatewayError::InvalidAuthority)?;
        if maximum_input_bytes == 0 {
            return Err(ProviderGatewayError::InvalidAuthority);
        }
        Ok(CapabilityDataGateway::new(
            Arc::clone(&self.client),
            self.identity.clone(),
            self.runtime_instance_id.clone(),
            self.timing,
            Arc::clone(&self.clock),
            capability_set_sha256,
            maximum_input_bytes,
        ))
    }

    async fn start_inner(
        &mut self,
        request: ProviderRequest,
    ) -> Result<ProviderDataOperation, ProviderGatewayError> {
        let operation_id = request.operation_id.clone();
        let (start, tools) = provider_start(
            &self.identity,
            &self.binding,
            self.max_context_bytes,
            &request,
        )?;
        let signal = self.first_start_signal.take();
        self.client
            .lock()
            .await
            .start_observed(start, self.timing, self.clock.as_ref(), move || {
                if let Some(signal) = signal {
                    let _ = signal.send(());
                }
            })
            .await
            .map_err(ProviderGatewayError::Data)?;
        Ok(ProviderDataOperation::new(operation_id, tools))
    }

    async fn next_inner(
        &self,
        operation: &mut ProviderDataOperation,
    ) -> Result<Option<ProviderEvent>, ProviderGatewayError> {
        loop {
            if operation.terminal_delivered {
                return Ok(None);
            }
            if let Some(event) = operation.buffered.take() {
                operation.terminal_delivered = true;
                return settle_provider_event(operation, event);
            }
            let event = self
                .client
                .lock()
                .await
                .next(self.timing, self.clock.as_ref())
                .await
                .map_err(ProviderGatewayError::Data)?;
            let mapped = map_wire_event(event, &operation.operation_id, &operation.tools)?;
            operation.buffered = mapped.buffered;
            operation.terminal_delivered = mapped.terminal_delivered;
            if let Some(event) = settle_provider_event(operation, mapped.event)? {
                return Ok(Some(event));
            }
        }
    }
}

impl<S, C> ProviderGatewayPort for ProviderDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    type Operation = ProviderDataOperation;
    type Error = ProviderGatewayError;

    fn start(
        &mut self,
        request: ProviderRequest,
    ) -> impl Future<Output = Result<Self::Operation, Self::Error>> + Send {
        self.start_inner(request)
    }

    fn next(
        &mut self,
        operation: &mut Self::Operation,
    ) -> impl Future<Output = Result<Option<ProviderEvent>, Self::Error>> + Send {
        self.next_inner(operation)
    }
}

#[cfg(test)]
mod tests;
