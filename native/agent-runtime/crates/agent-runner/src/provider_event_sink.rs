use std::sync::Arc;

use agent_engine::ports::{EngineEvent, EventSinkPort, TerminalRecord};
use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use crate::provider_data::{ProviderDataClient, ProviderDataClock, ProviderDataTiming};

mod content;
mod error;
mod mapping;

pub use error::ProviderEventSinkError;
use mapping::{event_body, terminal_body};

const ENGINE_EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct ProviderEventDataSink<S, C> {
    client: Arc<Mutex<ProviderDataClient<S>>>,
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    semantic_deadline_at_unix_ms: i64,
    timing: ProviderDataTiming,
    clock: Arc<C>,
    next_local_sequence: u64,
    terminal_committed: bool,
    last_receipt: Option<wire::CommitSessionRecordReceipt>,
}

impl<S, C> ProviderEventDataSink<S, C> {
    pub(crate) const fn new(
        client: Arc<Mutex<ProviderDataClient<S>>>,
        identity: wire::AttemptIdentity,
        runtime_instance_id: String,
        semantic_deadline_at_unix_ms: i64,
        timing: ProviderDataTiming,
        clock: Arc<C>,
        next_local_sequence: u64,
    ) -> Self {
        Self {
            client,
            identity,
            runtime_instance_id,
            semantic_deadline_at_unix_ms,
            timing,
            clock,
            next_local_sequence,
            terminal_committed: false,
            last_receipt: None,
        }
    }

    #[must_use]
    pub const fn next_local_sequence(&self) -> u64 {
        self.next_local_sequence
    }

    #[must_use]
    pub const fn last_receipt(&self) -> Option<&wire::CommitSessionRecordReceipt> {
        self.last_receipt.as_ref()
    }
}

impl<S, C> ProviderEventDataSink<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock + 'static,
{
    async fn commit(
        &mut self,
        body: wire::engine_event_record_v1::Body,
    ) -> Result<(), ProviderEventSinkError> {
        if self.terminal_committed {
            return Err(ProviderEventSinkError::TerminalAlreadyCommitted);
        }
        let local_sequence = self.next_local_sequence;
        if local_sequence == 0 {
            return Err(ProviderEventSinkError::InvalidAuthority("local_sequence"));
        }
        let record = wire::EngineEventRecordV1 {
            schema_version: ENGINE_EVENT_SCHEMA_VERSION,
            identity: Some(self.identity.clone()),
            runtime_instance_id: self.runtime_instance_id.clone(),
            local_sequence,
            body: Some(body),
        };
        let digest = Sha256::digest(record.encode_to_vec()).to_vec();
        let proposal = wire::EngineEventProposal {
            identity: Some(self.identity.clone()),
            runtime_instance_id: self.runtime_instance_id.clone(),
            record: Some(record),
            expected_payload_sha256: digest,
        };
        let receipt = self
            .client
            .lock()
            .await
            .commit_engine_event(
                proposal,
                self.semantic_deadline_at_unix_ms,
                self.timing,
                self.clock.as_ref(),
            )
            .await?;
        self.next_local_sequence = local_sequence
            .checked_add(1)
            .ok_or(ProviderEventSinkError::SequenceExhausted)?;
        self.last_receipt = Some(receipt);
        Ok(())
    }
}

impl<S, C> EventSinkPort for ProviderEventDataSink<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock + 'static,
{
    type Error = ProviderEventSinkError;

    async fn append(&mut self, event: EngineEvent<'_>) -> Result<(), Self::Error> {
        if let Some(content) = content::event_content(&event) {
            let transcript = content.kind == wire::EngineContentKindV1::Transcript;
            self.commit_content(content).await?;
            if transcript {
                return Ok(());
            }
        }
        self.commit(event_body(event)?).await
    }

    async fn commit_terminal(&mut self, terminal: TerminalRecord<'_>) -> Result<(), Self::Error> {
        self.commit(terminal_body(terminal)?).await?;
        self.terminal_committed = true;
        Ok(())
    }
}
