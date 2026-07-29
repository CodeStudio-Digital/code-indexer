use super::LaunchRegistry;
use super::record::{LaunchRecord, TerminationRecord};
use crate::management::driver::termination::model::PhysicalTerminationKind;
use crate::management::driver::termination::plan::TerminationCommand;
use crate::process_table::OwnershipKey;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::management::driver) enum TerminationRegistryMatch {
    Fresh,
    Reserved,
    Scheduled,
    Missing,
    Conflict,
}

impl LaunchRegistry {
    pub(in crate::management::driver) fn classify_termination(
        &self,
        command: &TerminationCommand,
        ownership_key: &OwnershipKey,
    ) -> TerminationRegistryMatch {
        if self.by_idempotency_key.values().any(|record| {
            record.identity != *command.identity()
                && uses_idempotency_key(record, command.idempotency_key())
        }) {
            return TerminationRegistryMatch::Conflict;
        }
        let Some(record) = self
            .by_idempotency_key
            .values()
            .find(|record| record.identity == *command.identity())
        else {
            return TerminationRegistryMatch::Missing;
        };
        if !record.is_owned()
            || !record.physical_cleanup_required
            || record.ownership_key != *ownership_key
        {
            return TerminationRegistryMatch::Conflict;
        }
        if other_kind_uses_idempotency_key(record, command) {
            return TerminationRegistryMatch::Conflict;
        }
        if let Some(existing) = slot(record, command.kind()) {
            return if !existing.matches(command) {
                TerminationRegistryMatch::Conflict
            } else if existing.is_scheduled() {
                TerminationRegistryMatch::Scheduled
            } else {
                TerminationRegistryMatch::Reserved
            };
        }
        if record.physical_reaped || superseded(record, command.kind()) {
            TerminationRegistryMatch::Conflict
        } else {
            TerminationRegistryMatch::Fresh
        }
    }

    pub(in crate::management::driver) fn termination_ownership_key(
        &self,
        command: &TerminationCommand,
    ) -> Option<OwnershipKey> {
        self.by_idempotency_key
            .values()
            .find(|record| record.identity == *command.identity())
            .map(|record| record.ownership_key.clone())
    }

    pub(in crate::management::driver) fn reserve_termination(
        &mut self,
        command: &TerminationCommand,
        ownership_key: &OwnershipKey,
    ) -> bool {
        if !matches!(
            self.classify_termination(command, ownership_key),
            TerminationRegistryMatch::Fresh
        ) {
            return false;
        }
        let Some(record) = self
            .by_idempotency_key
            .values_mut()
            .find(|record| record.identity == *command.identity())
        else {
            return false;
        };
        *slot_mut(record, command.kind()) = Some(TerminationRecord::reserved(command));
        true
    }

    pub(in crate::management::driver) fn mark_termination_scheduled(
        &mut self,
        command: &TerminationCommand,
    ) -> bool {
        let Some(record) = self
            .by_idempotency_key
            .values_mut()
            .find(|record| record.identity == *command.identity())
        else {
            return false;
        };
        let Some(intent) = slot_mut(record, command.kind()).as_mut() else {
            return false;
        };
        if !intent.matches(command) {
            return false;
        }
        intent.mark_scheduled();
        true
    }
}

const fn slot(record: &LaunchRecord, kind: PhysicalTerminationKind) -> Option<&TerminationRecord> {
    match kind {
        PhysicalTerminationKind::Cancel => record.cancel_termination.as_ref(),
        PhysicalTerminationKind::Fence => record.fence_termination.as_ref(),
        PhysicalTerminationKind::Reap => record.reap_termination.as_ref(),
    }
}

const fn slot_mut(
    record: &mut LaunchRecord,
    kind: PhysicalTerminationKind,
) -> &mut Option<TerminationRecord> {
    match kind {
        PhysicalTerminationKind::Cancel => &mut record.cancel_termination,
        PhysicalTerminationKind::Fence => &mut record.fence_termination,
        PhysicalTerminationKind::Reap => &mut record.reap_termination,
    }
}

const fn superseded(record: &LaunchRecord, kind: PhysicalTerminationKind) -> bool {
    match kind {
        PhysicalTerminationKind::Cancel => {
            record.fence_termination.is_some() || record.reap_termination.is_some()
        }
        PhysicalTerminationKind::Fence => record.reap_termination.is_some(),
        PhysicalTerminationKind::Reap => false,
    }
}

fn uses_idempotency_key(record: &LaunchRecord, idempotency_key: &str) -> bool {
    termination_slots(record)
        .into_iter()
        .flatten()
        .any(|intent| intent.uses_idempotency_key(idempotency_key))
}

fn other_kind_uses_idempotency_key(record: &LaunchRecord, command: &TerminationCommand) -> bool {
    [
        (
            PhysicalTerminationKind::Cancel,
            record.cancel_termination.as_ref(),
        ),
        (
            PhysicalTerminationKind::Fence,
            record.fence_termination.as_ref(),
        ),
        (
            PhysicalTerminationKind::Reap,
            record.reap_termination.as_ref(),
        ),
    ]
    .into_iter()
    .any(|(kind, intent)| {
        kind != command.kind()
            && intent.is_some_and(|intent| intent.uses_idempotency_key(command.idempotency_key()))
    })
}

const fn termination_slots(record: &LaunchRecord) -> [Option<&TerminationRecord>; 3] {
    [
        record.cancel_termination.as_ref(),
        record.fence_termination.as_ref(),
        record.reap_termination.as_ref(),
    ]
}
