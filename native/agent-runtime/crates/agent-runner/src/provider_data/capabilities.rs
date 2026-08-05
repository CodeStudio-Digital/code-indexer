use agent_protocol::frame::{CommittedOutbound, FrameReceiveOutcome};
use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};

use super::validation::timestamp_within_local_peer;
use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};

const MAX_NATIVE_READ_BYTES: u64 = 64 * 1_024 * 1_024;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Requests a pre-dispatch capability decision while preserving provider
    /// events that race on the shared Data stream.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid authority, correlation, decision or I/O.
    pub async fn prepare_capability<C: ProviderDataClock>(
        &mut self,
        prepare: wire::CapabilityPrepare,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::CapabilityUpdate, ProviderDataError> {
        validate_prepare(&prepare, &self.identity, &self.runtime_instance_id)?;
        let deadline = prepare.deadline_at_unix_ms;
        let operation_id = prepare.operation_id.clone();
        let tool_use_id = prepare.tool_use_id.clone();
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::CapabilityPrepare(prepare)),
        };
        let request = self
            .channel
            .send_new(&payload, deadline, timing.hard_deadline, || {
                clock.now_unix_ms()
            })
            .await?;
        loop {
            let outcome = self
                .channel
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || clock.now_unix_ms(),
                )
                .await?;
            let FrameReceiveOutcome::Pending(mut pending) = outcome else {
                continue;
            };
            let binding = pending.binding();
            let header = pending.header().clone();
            let (body, _) = pending.take_body_and_digest()?;
            if matches!(&body, wire::frame_payload::Body::CapabilityUpdate(_)) {
                let update = validate_update(
                    body,
                    &header,
                    &request,
                    &self.identity,
                    &self.runtime_instance_id,
                    &operation_id,
                    &tool_use_id,
                    clock.now_unix_ms(),
                )?;
                let receipt = self.channel.commit_accepted(*pending)?;
                if !receipt.matches(&binding) {
                    return Err(ProviderDataError::ForeignCommitReceipt);
                }
                return Ok(update);
            }
            let event = self.validate_bufferable_event(body, &header)?;
            let receipt = self.channel.commit_accepted(*pending)?;
            if !receipt.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            self.advance_provider_event(&event)?;
            self.buffered_events.push_back(event);
        }
    }
}

fn validate_prepare(
    value: &wire::CapabilityPrepare,
    identity: &wire::AttemptIdentity,
    runtime_instance_id: &str,
) -> Result<(), ProviderDataError> {
    let class = wire::CapabilityExecutionClass::try_from(value.execution_class).ok();
    if value.identity.as_ref() != Some(identity)
        || value.runtime_instance_id != runtime_instance_id
        || [
            value.operation_id.as_str(),
            value.provider_operation_id.as_str(),
            value.tool_use_id.as_str(),
            value.capability_id.as_str(),
            value.capability_version.as_str(),
            value.idempotency_key.as_str(),
        ]
        .iter()
        .any(|field| field.is_empty())
        || class.is_none_or(|class| class == wire::CapabilityExecutionClass::Unspecified)
        || (value.mutates && class == Some(wire::CapabilityExecutionClass::NativeRead))
        || value.encoded_json_input.is_empty()
        || value.input_sha256.len() != 32
        || value.capability_set_sha256.len() != 32
        || Sha256::digest(&value.encoded_json_input).as_slice() != value.input_sha256
        || value.deadline_at_unix_ms <= 0
    {
        return Err(ProviderDataError::InvalidRequest(
            "capability prepare authority is invalid",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_update(
    body: wire::frame_payload::Body,
    header: &wire::FrameHeader,
    request: &CommittedOutbound,
    identity: &wire::AttemptIdentity,
    runtime_instance_id: &str,
    operation_id: &str,
    tool_use_id: &str,
    observed_at_unix_ms: i64,
) -> Result<wire::CapabilityUpdate, ProviderDataError> {
    let wire::frame_payload::Body::CapabilityUpdate(update) = body else {
        return Err(ProviderDataError::UnexpectedPayload(
            "expected CapabilityUpdate",
        ));
    };
    if header.reply_to_message_id.as_deref() != Some(request.message_id())
        || update.identity.as_ref() != Some(identity)
        || update.runtime_instance_id != runtime_instance_id
        || update.operation_id != operation_id
        || update.tool_use_id != tool_use_id
    {
        return Err(ProviderDataError::Correlation(
            "CapabilityUpdate contradicts prepare",
        ));
    }
    validate_decision(&update, request.sent_at_unix_ms(), observed_at_unix_ms)?;
    Ok(update)
}

fn validate_decision(
    update: &wire::CapabilityUpdate,
    requested_at_unix_ms: i64,
    observed_at_unix_ms: i64,
) -> Result<(), ProviderDataError> {
    use wire::capability_update::Decision;
    let valid = match update.decision.as_ref() {
        Some(Decision::Rejected(value)) => {
            decision_fields(
                &value.decision_id,
                &value.reason_code,
                &value.policy_version,
            ) && timestamp_within_local_peer(
                value.decided_at_unix_ms,
                requested_at_unix_ms,
                observed_at_unix_ms,
            )
        }
        Some(Decision::ApprovalRequired(value)) => {
            decision_fields(
                &value.decision_id,
                &value.reason_code,
                &value.policy_version,
            ) && !value.interaction_id.is_empty()
                && timestamp_within_local_peer(
                    value.decided_at_unix_ms,
                    requested_at_unix_ms,
                    observed_at_unix_ms,
                )
        }
        Some(Decision::Accepted(value)) => grant_fields(value, update, requested_at_unix_ms),
        None => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ProviderDataError::Correlation(
            "capability decision is invalid",
        ))
    }
}

const fn decision_fields(decision_id: &str, reason_code: &str, policy_version: &str) -> bool {
    !decision_id.is_empty() && !reason_code.is_empty() && !policy_version.is_empty()
}

fn grant_fields(
    grant: &wire::SealedExecutionGrant,
    update: &wire::CapabilityUpdate,
    requested_at_unix_ms: i64,
) -> bool {
    !grant.grant_id.is_empty()
        && !grant.decision_id.is_empty()
        && grant.operation_id == update.operation_id
        && grant.tool_use_id == update.tool_use_id
        && !grant.capability_id.is_empty()
        && !grant.capability_version.is_empty()
        && grant.effective_input_sha256.len() == 32
        && wire::CapabilityExecutionClass::try_from(grant.execution_class)
            .is_ok_and(|class| class != wire::CapabilityExecutionClass::Unspecified)
        && !grant.environment_id.is_empty()
        && grant.environment_version > 0
        && !grant.resource_binding_id.is_empty()
        && grant.constraints_sha256.len() == 32
        && !grant.policy_version.is_empty()
        && !grant.nonce.is_empty()
        && grant.issued_at_unix_ms >= requested_at_unix_ms.saturating_sub(50)
        && grant.expires_at_unix_ms > grant.issued_at_unix_ms
        && lease_fields_coherent(grant)
        && native_read_binding_coherent(grant)
}

fn native_read_binding_coherent(grant: &wire::SealedExecutionGrant) -> bool {
    let is_native_read = grant.execution_class == wire::CapabilityExecutionClass::NativeRead as i32;
    let Some(binding) = grant.native_filesystem_read.as_ref() else {
        return !is_native_read;
    };
    is_native_read
        && !grant.mutates
        && !binding.canonical_root_path.is_empty()
        && !binding.canonical_root_path.contains('\0')
        && binding.max_read_bytes > 0
        && binding.max_read_bytes <= MAX_NATIVE_READ_BYTES
        && binding.max_output_bytes > 0
        && binding.max_output_bytes <= MAX_NATIVE_READ_BYTES
        && Sha256::digest(binding.encode_to_vec()).as_slice() == grant.constraints_sha256
}

fn lease_fields_coherent(grant: &wire::SealedExecutionGrant) -> bool {
    let count = usize::from(grant.workspace_lease_id.is_some())
        + usize::from(grant.workspace_lease_version.is_some())
        + usize::from(grant.workspace_fencing_epoch.is_some());
    (count == 0 || count == 3)
        && grant
            .workspace_lease_id
            .as_ref()
            .is_none_or(|value| !value.is_empty())
        && grant.workspace_lease_version.is_none_or(|value| value > 0)
        && grant.workspace_fencing_epoch.is_none_or(|value| value > 0)
}
