use super::super::fact_flow::PendingFactAction;
use crate::process_table::OwnershipKey;
use agent_protocol::generated::v1 as wire;

#[derive(Debug)]
pub(in crate::management) struct PreparedFactEmission {
    pub(super) payload: Option<wire::ManagementPayload>,
    pub(super) action: PendingFactAction,
    failure_key: OwnershipKey,
}

impl PreparedFactEmission {
    pub(in crate::management::driver) const fn new(
        payload: wire::ManagementPayload,
        action: PendingFactAction,
        failure_key: OwnershipKey,
    ) -> Self {
        Self {
            payload: Some(payload),
            action,
            failure_key,
        }
    }

    pub(in crate::management) const fn take_payload(&mut self) -> wire::ManagementPayload {
        self.payload.take().expect("fact payload is consumed once")
    }

    pub(in crate::management) const fn failure_key(&self) -> &OwnershipKey {
        &self.failure_key
    }

    pub(in crate::management::driver) fn lifecycle_entry(
        &self,
        connection_id: &str,
    ) -> Option<wire::SupervisorLifecycleOutboxEntryV1> {
        let wire::management_payload::Body::AttemptProcessExited(exited) =
            self.payload.as_ref()?.body.as_ref()?
        else {
            return None;
        };
        let wire::management_payload::Body::AttemptProcessReaped(reaped) =
            self.action.reap_successor()?.to_wire().body?
        else {
            return None;
        };
        Some(wire::SupervisorLifecycleOutboxEntryV1 {
            schema_version: 1,
            connection_id: connection_id.to_owned(),
            exited: Some(exited.clone()),
            reaped: Some(reaped),
            host_acknowledged: false,
        })
    }
}
