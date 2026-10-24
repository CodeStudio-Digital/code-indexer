use std::io::{Read, Write};

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::{
    ManagementChannelError, PendingManagementInbound, ValidatedManagementPayload,
};
use agent_protocol::wire_identity::identity_from_wire;

use super::{
    ProtectedLaunchProvisionPort, SupervisorDriverError, SupervisorDriverStep,
    SupervisorLifecycleCore, SupervisorPhysicalDriver,
};
use crate::process_table::OwnershipKey;

impl<P: ContainmentPort, V: ProtectedLaunchProvisionPort> SupervisorLifecycleCore<P, V> {
    pub(in crate::management) fn update_authority(
        &mut self,
        payload: &ValidatedManagementPayload,
        digest: [u8; 32],
        now_unix_ms: i64,
    ) -> Result<(OwnershipKey, SupervisorDriverStep), SupervisorDriverError<P::Error>> {
        let update = payload
            .update_attempt_authority()
            .ok_or(SupervisorDriverError::InvalidAuthorityUpdate)?;
        let identity = update
            .identity
            .as_ref()
            .and_then(|value| identity_from_wire(value).ok())
            .ok_or(SupervisorDriverError::InvalidAuthorityUpdate)?;
        let key = self
            .ownership
            .key_for_identity(&identity)
            .map_err(SupervisorDriverError::Ownership)?;
        let metadata = self
            .ownership
            .metadata(&key)
            .map_err(SupervisorDriverError::Ownership)?;
        if !self.state.is_accepting_launches()
            || !self.state.can_renew_authority(&key, now_unix_ms)
            || !self.launch_registry.authority_ready(&key)
            || now_unix_ms <= 0
            || now_unix_ms >= metadata.lease_expires_at_unix_ms
            || update.updated_at_unix_ms <= 0
            || update.updated_at_unix_ms > now_unix_ms
            || update.hard_deadline_at_unix_ms != metadata.deadline_at_unix_ms
        {
            return Err(SupervisorDriverError::InvalidAuthorityUpdate);
        }
        let reused_existing = self
            .authority_registry
            .classify(&identity.attempt_id, &update.idempotency_key, &key, digest)
            .map_err(|()| SupervisorDriverError::AuthorityUpdateConflict)?;
        if !reused_existing {
            self.ownership
                .renew_authority(
                    &key,
                    update.authority_lease_expires_at_unix_ms,
                    update.hard_deadline_at_unix_ms,
                    now_unix_ms,
                )
                .map_err(SupervisorDriverError::Ownership)?;
            self.state.install_authority_watchdog(
                now_unix_ms,
                update.authority_lease_expires_at_unix_ms,
                key.clone(),
            )?;
            self.authority_registry.insert(
                identity.attempt_id,
                update.idempotency_key.clone(),
                key.clone(),
                digest,
            );
        }
        Ok((
            key,
            SupervisorDriverStep::AuthorityUpdated { reused_existing },
        ))
    }
}

impl<R: Read, W: Write, P: ContainmentPort, V: ProtectedLaunchProvisionPort>
    SupervisorPhysicalDriver<R, W, P, V>
{
    pub(super) fn handle_authority_update(
        &mut self,
        pending: PendingManagementInbound,
        payload: ValidatedManagementPayload,
        digest: [u8; 32],
        now_unix_ms: i64,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let (key, step) = match self.core.update_authority(&payload, digest, now_unix_ms) {
            Ok(result) => result,
            Err(error) => {
                let channel_error = self
                    .channel
                    .reject(pending)
                    .err()
                    .unwrap_or(ManagementChannelError::ChannelPoisoned);
                self.close_for_channel_failure(&channel_error, now_unix_ms, None)?;
                return Err(error);
            }
        };
        drop(payload);
        if let Err(error) = self.channel.respond_acknowledged(pending) {
            self.close_for_channel_failure(&error, now_unix_ms, Some(key))?;
            return Err(SupervisorDriverError::Channel(error));
        }
        Ok(step)
    }
}
