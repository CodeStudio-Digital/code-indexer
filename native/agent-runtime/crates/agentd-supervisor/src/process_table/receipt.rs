use super::{Entry, OwnershipError, OwnershipKey, OwnershipRegistry, PhysicalSpawnReceipt};

impl<G> Entry<G> {
    fn physical_spawn_receipt(&self) -> Option<PhysicalSpawnReceipt> {
        match self {
            Self::Launching(_) | Self::Quarantined(_) => None,
            Self::BootstrapPending(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.physical.process_id,
                owned.state.physical.report.clone(),
            )),
            Self::Reserved(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.0.process_id,
                owned.state.0.report.clone(),
            )),
            Self::Running(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.0.process_id,
                owned.state.0.report.clone(),
            )),
            Self::Cancelling(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.0.process_id,
                owned.state.0.report.clone(),
            )),
            Self::Exited(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.physical.process_id,
                owned.state.physical.report.clone(),
            )),
            Self::Reaping(owned) => Some(PhysicalSpawnReceipt::new(
                owned.metadata.clone(),
                owned.reservation.opaque_id(),
                owned.state.physical.process_id,
                owned.state.physical.report.clone(),
            )),
        }
    }
}

impl<G> OwnershipRegistry<G> {
    pub(crate) fn physical_spawn_receipt(
        &self,
        key: &OwnershipKey,
    ) -> Result<PhysicalSpawnReceipt, OwnershipError> {
        self.matching(key)?
            .physical_spawn_receipt()
            .ok_or(OwnershipError::MissingPhysicalReceipt)
    }

    pub(crate) fn owned_keys(&self) -> Vec<OwnershipKey> {
        self.entries
            .values()
            .map(|entry| OwnershipKey::from_metadata(entry.metadata()))
            .collect()
    }
}
