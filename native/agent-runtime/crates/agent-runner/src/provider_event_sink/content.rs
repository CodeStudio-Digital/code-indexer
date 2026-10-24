use agent_engine::ports::EngineEvent;
use agent_protocol::generated::v1 as wire;
use agent_tools::capability::CapabilityExecutionOutcome;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};

use super::{ProviderDataClock, ProviderEventDataSink, ProviderEventSinkError};

const CHUNK_BYTES: usize = 128 * 1024;

pub(super) struct Content<'a> {
    pub(super) kind: wire::EngineContentKindV1,
    operation_id: &'a str,
    tool_use_id: &'a str,
    schema_id: &'a str,
    schema_version: u32,
    bytes: &'a [u8],
    thinking: bool,
}

pub(super) const fn event_content<'a>(event: &'a EngineEvent<'a>) -> Option<Content<'a>> {
    use wire::EngineContentKindV1 as Kind;
    let (kind, operation_id, tool_use_id, schema_id, schema_version, bytes, thinking) = match event
    {
        EngineEvent::ProviderDelta { operation_id, text } => (
            Kind::Transcript,
            *operation_id,
            "",
            "text/utf8",
            1,
            text.as_bytes(),
            false,
        ),
        EngineEvent::ProviderThinkingDelta { operation_id, text } => (
            Kind::Transcript,
            *operation_id,
            "",
            "text/utf8",
            1,
            text.as_bytes(),
            true,
        ),
        EngineEvent::CapabilityBoundary {
            operation_id,
            tool_use_id,
            call,
        } => (
            Kind::ToolInput,
            *operation_id,
            *tool_use_id,
            "application/json",
            1,
            call.encoded_arguments.as_slice(),
            false,
        ),
        EngineEvent::CapabilityTerminal {
            operation_id,
            tool_use_id,
            outcome: CapabilityExecutionOutcome::Succeeded(output),
            ..
        } => (
            Kind::ToolResult,
            *operation_id,
            *tool_use_id,
            output.schema_id.as_str(),
            output.schema_version,
            output.encoded_result.as_slice(),
            false,
        ),
        _ => return None,
    };
    Some(Content {
        kind,
        operation_id,
        tool_use_id,
        schema_id,
        schema_version,
        bytes,
        thinking,
    })
}

impl<S, C> ProviderEventDataSink<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock + 'static,
{
    pub(super) async fn commit_content(
        &mut self,
        content: Content<'_>,
    ) -> Result<(), ProviderEventSinkError> {
        if content.bytes.is_empty() {
            return Ok(());
        }
        let total_bytes = u64::try_from(content.bytes.len())
            .map_err(|_| ProviderEventSinkError::SequenceExhausted)?;
        let content_id = format!(
            "{}:content:{}",
            content.operation_id, self.next_local_sequence
        );
        let digest = Sha256::digest(content.bytes).to_vec();
        for (index, chunk) in content.bytes.chunks(CHUNK_BYTES).enumerate() {
            self.commit(wire::engine_event_record_v1::Body::Content(
                wire::EngineContentRecordV1 {
                    kind: content.kind as i32,
                    content_id: content_id.clone(),
                    operation_id: content.operation_id.to_owned(),
                    tool_use_id: content.tool_use_id.to_owned(),
                    content_schema_id: content.schema_id.to_owned(),
                    content_schema_version: content.schema_version,
                    content_sha256: digest.clone(),
                    total_bytes,
                    chunk_offset: (index * CHUNK_BYTES) as u64,
                    encoded_chunk: chunk.to_vec(),
                    thinking: content.thinking,
                },
            ))
            .await?;
        }
        Ok(())
    }
}
