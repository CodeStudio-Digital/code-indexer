use super::record::{AcceptedLaunchSnapshot, LaunchOutcome, LaunchRecord, record_matches_plan};
use super::{LaunchIntentKey, LaunchRegistry};
use crate::management::driver::facts::LaunchRejection;
use crate::management::driver::plan::LaunchPlan;
use crate::process_table::OwnershipKey;

impl LaunchRegistry {
    pub(in crate::management::driver) fn mark_owned(
        &mut self,
        intent: &LaunchIntentKey,
        plan: &LaunchPlan,
        accepted: AcceptedLaunchSnapshot,
    ) -> bool {
        let Some(record) = self.matching_mut(intent) else {
            return false;
        };
        if !record_matches_plan(record, plan) || !matches!(record.outcome, LaunchOutcome::Pending) {
            return false;
        }
        record.outcome = LaunchOutcome::Owned(Box::new(accepted));
        record.physical_cleanup_required = true;
        true
    }

    pub(in crate::management::driver) fn mark_rejected(
        &mut self,
        intent: &LaunchIntentKey,
        plan: &LaunchPlan,
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
        physical_cleanup_required: bool,
    ) -> bool {
        let Some(record) = self.matching_mut(intent) else {
            return false;
        };
        if !record_matches_plan(record, plan) {
            return false;
        }
        record.outcome = LaunchOutcome::Rejected {
            rejection,
            rejected_at_unix_ms,
        };
        record.host_durable = false;
        record.physical_cleanup_required |= physical_cleanup_required;
        true
    }

    pub(in crate::management::driver) fn record_fact_sent(
        &mut self,
        intent: &LaunchIntentKey,
    ) -> bool {
        let Some(record) = self.matching_mut(intent) else {
            return false;
        };
        let Some(updated) = record.unacked_facts.checked_add(1) else {
            return false;
        };
        record.unacked_facts = updated;
        true
    }

    pub(in crate::management::driver) fn acknowledge_fact(
        &mut self,
        intent: &LaunchIntentKey,
        durable: bool,
    ) -> bool {
        let Some(record) = self.matching_mut(intent) else {
            return false;
        };
        let Some(updated) = record.unacked_facts.checked_sub(1) else {
            return false;
        };
        record.unacked_facts = updated;
        record.host_durable |= durable;
        true
    }

    pub(in crate::management::driver) fn mark_physical_reaped(
        &mut self,
        ownership_key: &OwnershipKey,
    ) {
        if let Some(record) = self
            .by_idempotency_key
            .values_mut()
            .find(|record| &record.ownership_key == ownership_key)
        {
            record.physical_reaped = true;
        }
    }

    pub(in crate::management::driver) fn confirms_physical_reap(
        &self,
        ownership_key: &OwnershipKey,
    ) -> bool {
        self.by_idempotency_key
            .values()
            .any(|record| record.physical_reaped && &record.ownership_key == ownership_key)
    }

    fn matching_mut(&mut self, intent: &LaunchIntentKey) -> Option<&mut LaunchRecord> {
        self.by_idempotency_key
            .get_mut(&intent.idempotency_key)
            .filter(|record| record.ordinal == intent.ordinal)
    }
}
