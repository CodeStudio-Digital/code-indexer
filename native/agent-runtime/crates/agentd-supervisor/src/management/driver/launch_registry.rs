use std::collections::BTreeMap;
use std::fmt::{self, Debug, Formatter};

use super::facts::LaunchRejection;
use super::plan::LaunchPlan;
use crate::process_table::OwnershipKey;

mod outcome;
mod record;
mod termination;
#[cfg(test)]
mod tests_api;

pub(super) use record::AcceptedLaunchSnapshot;
use record::{LaunchOutcome, LaunchRecord, record_matches_plan};
pub(in crate::management::driver) use termination::TerminationRegistryMatch;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct LaunchIntentKey {
    idempotency_key: String,
    ordinal: u64,
}

impl Debug for LaunchIntentKey {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LaunchIntentKey")
            .field("idempotency_key", &"[REDACTED]")
            .field("ordinal", &self.ordinal)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LaunchRegistryMatch {
    Fresh,
    Pending(LaunchIntentKey),
    Owned {
        intent_key: LaunchIntentKey,
        accepted: Box<AcceptedLaunchSnapshot>,
        physical_reaped: bool,
    },
    Rejected {
        intent_key: LaunchIntentKey,
        rejection: LaunchRejection,
        rejected_at_unix_ms: i64,
    },
    Conflict,
}

/// Bounded, secret-free idempotency registry for physical launch intents.
pub(super) struct LaunchRegistry {
    maximum_entries: usize,
    next_ordinal: u64,
    by_idempotency_key: BTreeMap<String, LaunchRecord>,
}

impl Debug for LaunchRegistry {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LaunchRegistry")
            .field("maximum_entries", &self.maximum_entries)
            .field("retained_entries", &self.by_idempotency_key.len())
            .field("records", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl LaunchRegistry {
    pub(super) fn authority_ready(&self, key: &OwnershipKey) -> bool {
        self.by_idempotency_key.values().any(|record| {
            &record.ownership_key == key
                && record.host_durable
                && !record.physical_reaped
                && matches!(record.outcome, LaunchOutcome::Owned(_))
        })
    }

    pub(super) const fn new(maximum_entries: usize) -> Self {
        Self {
            maximum_entries,
            next_ordinal: 1,
            by_idempotency_key: BTreeMap::new(),
        }
    }

    pub(super) fn classify(&self, plan: &LaunchPlan) -> LaunchRegistryMatch {
        if let Some(record) = self.by_idempotency_key.get(plan.idempotency_key()) {
            if !record_matches_plan(record, plan) {
                return LaunchRegistryMatch::Conflict;
            }
            let intent_key = record.intent_key(plan.idempotency_key());
            return match &record.outcome {
                LaunchOutcome::Pending => LaunchRegistryMatch::Pending(intent_key),
                LaunchOutcome::Owned(accepted) => LaunchRegistryMatch::Owned {
                    intent_key,
                    accepted: accepted.clone(),
                    physical_reaped: record.physical_reaped,
                },
                LaunchOutcome::Rejected {
                    rejection,
                    rejected_at_unix_ms,
                } => LaunchRegistryMatch::Rejected {
                    intent_key,
                    rejection: *rejection,
                    rejected_at_unix_ms: *rejected_at_unix_ms,
                },
            };
        }
        if self
            .by_idempotency_key
            .values()
            .any(|record| record.identity.attempt_id == plan.identity().attempt_id)
        {
            LaunchRegistryMatch::Conflict
        } else {
            LaunchRegistryMatch::Fresh
        }
    }

    /// Reserves a tombstone before effects, evicting only the oldest record
    /// already durable at the host and safe for its physical outcome.
    pub(super) fn reserve(
        &mut self,
        plan: &LaunchPlan,
        ownership_key: OwnershipKey,
    ) -> Option<LaunchIntentKey> {
        if self.classify(plan) != LaunchRegistryMatch::Fresh {
            return None;
        }
        let ordinal = self.next_ordinal;
        let next_ordinal = ordinal.checked_add(1)?;
        if self.by_idempotency_key.len() >= self.maximum_entries && !self.evict_oldest_eligible() {
            return None;
        }
        self.next_ordinal = next_ordinal;
        self.by_idempotency_key.insert(
            plan.idempotency_key().to_owned(),
            LaunchRecord {
                identity: plan.identity().clone(),
                ownership_key,
                payload_digest: *plan.payload_digest(),
                outcome: LaunchOutcome::Pending,
                unacked_facts: 0,
                host_durable: false,
                physical_cleanup_required: false,
                physical_reaped: false,
                cancel_termination: None,
                fence_termination: None,
                reap_termination: None,
                ordinal,
            },
        );
        Some(LaunchIntentKey {
            idempotency_key: plan.idempotency_key().to_owned(),
            ordinal,
        })
    }

    fn evict_oldest_eligible(&mut self) -> bool {
        let oldest = self
            .by_idempotency_key
            .iter()
            .filter(|(_, record)| record.eligible_for_eviction())
            .min_by_key(|(_, record)| record.ordinal)
            .map(|(key, _)| key.clone());
        oldest
            .and_then(|key| self.by_idempotency_key.remove(&key))
            .is_some()
    }
}
