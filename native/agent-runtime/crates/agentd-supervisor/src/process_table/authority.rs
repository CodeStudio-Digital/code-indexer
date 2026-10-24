use super::{Entry, OwnershipError, OwnershipKey, OwnershipRegistry, PhysicalState};

impl<G> OwnershipRegistry<G> {
    pub(crate) fn renew_authority(
        &mut self,
        key: &OwnershipKey,
        lease_expires_at_unix_ms: i64,
        hard_deadline_at_unix_ms: i64,
        now_unix_ms: i64,
    ) -> Result<(), OwnershipError> {
        let metadata = self.metadata(key)?;
        if now_unix_ms <= 0
            || now_unix_ms >= metadata.lease_expires_at_unix_ms
            || hard_deadline_at_unix_ms != metadata.deadline_at_unix_ms
            || lease_expires_at_unix_ms < metadata.lease_expires_at_unix_ms
            || lease_expires_at_unix_ms > hard_deadline_at_unix_ms
        {
            return Err(OwnershipError::InvalidAuthorityWindow);
        }
        let entry = self
            .entries
            .get_mut(key.attempt_id())
            .ok_or(OwnershipError::MissingAttempt)?;
        match entry {
            Entry::Running(owned) => {
                owned.metadata.lease_expires_at_unix_ms = lease_expires_at_unix_ms;
                Ok(())
            }
            Entry::Reserved(owned) => {
                owned.metadata.lease_expires_at_unix_ms = lease_expires_at_unix_ms;
                Ok(())
            }
            _ => Err(OwnershipError::InvalidTransition {
                from: entry.state(),
                requested: PhysicalState::Running,
            }),
        }
    }
}
