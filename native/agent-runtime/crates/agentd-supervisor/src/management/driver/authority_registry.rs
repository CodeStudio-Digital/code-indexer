use std::collections::BTreeMap;

use agent_protocol::identity::AttemptId;

use crate::process_table::OwnershipKey;

/// Retained through physical reap. Exhaustion fails closed instead of forgetting
/// keys and allowing an earlier renewal identifier to authorize a new window.
#[derive(Debug, Default)]
pub(super) struct AuthorityRegistry {
    receipts: BTreeMap<(AttemptId, String), (OwnershipKey, [u8; 32])>,
}

impl AuthorityRegistry {
    pub(super) fn classify(
        &self,
        attempt_id: &AttemptId,
        idempotency_key: &str,
        key: &OwnershipKey,
        digest: [u8; 32],
    ) -> Result<bool, ()> {
        let receipt_key = (attempt_id.clone(), idempotency_key.to_owned());
        if let Some((previous_key, previous_digest)) = self.receipts.get(&receipt_key) {
            return if previous_key == key && previous_digest == &digest {
                Ok(true)
            } else {
                Err(())
            };
        }
        if self.receipts.len() >= 65_536 {
            return Err(());
        }
        Ok(false)
    }

    pub(super) fn insert(
        &mut self,
        attempt_id: AttemptId,
        idempotency_key: String,
        key: OwnershipKey,
        digest: [u8; 32],
    ) {
        self.receipts
            .insert((attempt_id, idempotency_key), (key, digest));
    }

    pub(super) fn remove(&mut self, key: &OwnershipKey) {
        self.receipts.retain(|_, (current, _)| current != key);
    }
}
