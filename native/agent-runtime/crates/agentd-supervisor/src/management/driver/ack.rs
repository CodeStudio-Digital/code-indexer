use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::{
    ManagementChannelError, PendingManagementInbound, ValidatedManagementPayload,
};

use super::fact_flow::{FactIntent, PendingFactAction, PendingFactStage};
use super::provision::ProtectedLaunchProvisionPort;
use super::state::AdmissionClosureReason;
use super::{
    SupervisorDriverError, SupervisorDriverStep, SupervisorLifecycleCore, SupervisorPhysicalDriver,
};
use crate::management::ManagementEnvelopeReceipt;

mod emission;
pub(in crate::management) use emission::PreparedFactEmission;

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(in crate::management) fn contains_management_ack(&self, ack: &wire::ManagementAck) -> bool {
        self.fact_flow.contains_ack(ack)
    }

    pub(in crate::management) fn acknowledge_management_fact(
        &mut self,
        acknowledgement: &wire::ManagementAck,
        now_unix_ms: i64,
    ) -> Result<Option<PreparedFactEmission>, SupervisorDriverError<P::Error>> {
        let action = self
            .fact_flow
            .take_ack(acknowledgement)
            .ok_or(SupervisorDriverError::UntrackedAcknowledgement)?;
        if let Some(intent) = action.registered_intent()
            && !self
                .launch_registry
                .acknowledge_fact(intent, action.makes_host_durable())
        {
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        self.advance_after_ack(action, now_unix_ms)
    }

    pub(in crate::management) fn track_prepared_fact(
        &mut self,
        receipt: &ManagementEnvelopeReceipt,
        emission: PreparedFactEmission,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        if emission.payload.is_some() {
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        self.track_fact(receipt, emission.action)
    }

    fn advance_after_ack(
        &mut self,
        action: PendingFactAction,
        now_unix_ms: i64,
    ) -> Result<Option<PreparedFactEmission>, SupervisorDriverError<P::Error>> {
        let (intent, stage) = action.into_parts();
        match stage {
            PendingFactStage::Accepted {
                key,
                authority,
                spawned,
                containment,
            } => {
                if authority.is_expired_at(now_unix_ms) {
                    self.close_owned_attempt(
                        AdmissionClosureReason::AuthorityExpired,
                        &key,
                        now_unix_ms,
                    )?;
                    return Ok(None);
                }
                Ok(Some(PreparedFactEmission::new(
                    spawned.to_wire(),
                    PendingFactAction::new(
                        intent,
                        PendingFactStage::Spawned {
                            key: key.clone(),
                            authority,
                            containment,
                        },
                    ),
                    key,
                )))
            }
            PendingFactStage::Spawned {
                key,
                authority,
                containment,
            } => {
                if authority.is_expired_at(now_unix_ms) {
                    self.close_owned_attempt(
                        AdmissionClosureReason::AuthorityExpired,
                        &key,
                        now_unix_ms,
                    )?;
                    return Ok(None);
                }
                Ok(Some(PreparedFactEmission::new(
                    containment.to_wire(),
                    PendingFactAction::new(intent, PendingFactStage::Containment),
                    key,
                )))
            }
            PendingFactStage::Containment
            | PendingFactStage::AcceptedReplay
            | PendingFactStage::Rejected => Ok(None),
            PendingFactStage::Reaped { outbox_attempt_id } => {
                if let Some(outbox) = &mut self.durable_lifecycle_outbox {
                    outbox
                        .acknowledge(&outbox_attempt_id)
                        .map_err(SupervisorDriverError::OutboxPersistence)?;
                }
                Ok(None)
            }
            PendingFactStage::Exited { key, reaped } => {
                let payload = reaped.to_wire();
                let Some(wire::management_payload::Body::AttemptProcessReaped(value)) =
                    &payload.body
                else {
                    return Err(SupervisorDriverError::FactFlowInvariant);
                };
                let outbox_attempt_id = value
                    .identity
                    .as_ref()
                    .ok_or(SupervisorDriverError::FactFlowInvariant)?
                    .attempt_id
                    .clone();
                Ok(Some(PreparedFactEmission::new(
                    payload,
                    PendingFactAction::new(
                        FactIntent::Unregistered,
                        PendingFactStage::Reaped { outbox_attempt_id },
                    ),
                    key,
                )))
            }
        }
    }

    pub(super) fn track_fact(
        &mut self,
        receipt: &ManagementEnvelopeReceipt,
        action: PendingFactAction,
    ) -> Result<(), SupervisorDriverError<P::Error>> {
        if let Some(intent) = action.registered_intent()
            && !self.launch_registry.record_fact_sent(intent)
        {
            return Err(SupervisorDriverError::FactFlowInvariant);
        }
        self.fact_flow
            .track(receipt, action)
            .then_some(())
            .ok_or(SupervisorDriverError::FactFlowInvariant)
    }
}

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn handle_management_ack(
        &mut self,
        pending: PendingManagementInbound,
        payload: ValidatedManagementPayload,
        now_unix_ms: i64,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let acknowledgement = payload
            .management_ack()
            .expect("ack kind checked by coordinator")
            .clone();
        drop(payload);
        if !self.core.contains_management_ack(&acknowledgement) {
            let rejected = self.channel.reject(pending);
            let channel_error = rejected
                .err()
                .unwrap_or(ManagementChannelError::ChannelPoisoned);
            self.close_for_channel_failure(&channel_error, now_unix_ms, None)?;
            return Err(SupervisorDriverError::UntrackedAcknowledgement);
        }
        if let Err(error) = self.channel.commit_accepted(pending) {
            self.close_for_channel_failure(&error, now_unix_ms, None)?;
            return Err(SupervisorDriverError::Channel(error));
        }
        let Some(mut emission) = self
            .core
            .acknowledge_management_fact(&acknowledgement, now_unix_ms)?
        else {
            return Ok(SupervisorDriverStep::ManagementAcknowledged);
        };
        let failure_key = emission.failure_key().clone();
        let payload = emission.take_payload();
        let sent = match self.channel.send_management_fact(&payload) {
            Ok(sent) => sent,
            Err(error) => {
                self.close_for_channel_failure(&error, now_unix_ms, Some(failure_key))?;
                return Err(SupervisorDriverError::Channel(error));
            }
        };
        self.core.track_prepared_fact(&sent, emission)?;
        Ok(SupervisorDriverStep::ManagementAcknowledged)
    }
}
