use std::collections::BTreeMap;
use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;

use super::facts::{AttemptContainmentFact, AttemptSpawnedFact};
use super::launch_registry::LaunchIntentKey;
use crate::management::ManagementEnvelopeReceipt;
use crate::process_table::OwnershipKey;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct AuthorityWindow {
    hard_deadline_at_unix_ms: i64,
    authority_lease_expires_at_unix_ms: i64,
}

impl AuthorityWindow {
    pub(super) const fn new(
        hard_deadline_at_unix_ms: i64,
        authority_lease_expires_at_unix_ms: i64,
    ) -> Self {
        Self {
            hard_deadline_at_unix_ms,
            authority_lease_expires_at_unix_ms,
        }
    }

    pub(super) const fn is_expired_at(self, now_unix_ms: i64) -> bool {
        now_unix_ms >= self.hard_deadline_at_unix_ms
            || now_unix_ms >= self.authority_lease_expires_at_unix_ms
    }
}

impl Debug for AuthorityWindow {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) enum FactIntent {
    Registered(LaunchIntentKey),
    Unregistered,
}

impl FactIntent {
    pub(super) const fn registered(&self) -> Option<&LaunchIntentKey> {
        match self {
            Self::Registered(intent) => Some(intent),
            Self::Unregistered => None,
        }
    }
}

impl Debug for FactIntent {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FactIntent")
            .field("intent_key", &"[REDACTED OR UNREGISTERED]")
            .field("registered", &self.registered().is_some())
            .finish()
    }
}

pub(super) enum PendingFactStage {
    Accepted {
        key: OwnershipKey,
        authority: AuthorityWindow,
        spawned: Box<AttemptSpawnedFact>,
        containment: Box<AttemptContainmentFact>,
    },
    Spawned {
        key: OwnershipKey,
        authority: AuthorityWindow,
        containment: Box<AttemptContainmentFact>,
    },
    Containment,
    AcceptedReplay,
    Rejected,
}

pub(super) struct PendingFactAction {
    intent: FactIntent,
    stage: PendingFactStage,
}

impl PendingFactAction {
    pub(super) const fn new(intent: FactIntent, stage: PendingFactStage) -> Self {
        Self { intent, stage }
    }

    pub(super) const fn registered_intent(&self) -> Option<&LaunchIntentKey> {
        self.intent.registered()
    }

    pub(super) const fn makes_host_durable(&self) -> bool {
        matches!(
            self.stage,
            PendingFactStage::Containment | PendingFactStage::Rejected
        )
    }

    pub(super) fn into_parts(self) -> (FactIntent, PendingFactStage) {
        (self.intent, self.stage)
    }
}

impl Debug for PendingFactAction {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        let (name, authority) = match &self.stage {
            PendingFactStage::Accepted { authority, .. } => ("Accepted", Some(authority)),
            PendingFactStage::Spawned { authority, .. } => ("Spawned", Some(authority)),
            PendingFactStage::Containment => ("Containment", None),
            PendingFactStage::AcceptedReplay => ("AcceptedReplay", None),
            PendingFactStage::Rejected => ("Rejected", None),
        };
        formatter
            .debug_struct(name)
            .field("intent", &self.intent)
            .field("intent_key", &"[REDACTED]")
            .field("authority", &authority)
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct PendingFact {
    payload_digest: [u8; 32],
    action: PendingFactAction,
}

/// Bounded mirror of channel-owned outstanding lifecycle facts.
#[derive(Debug)]
pub(super) struct FactFlow {
    maximum_entries: usize,
    pending: BTreeMap<String, PendingFact>,
}

impl FactFlow {
    pub(super) const fn new(maximum_entries: usize) -> Self {
        Self {
            maximum_entries,
            pending: BTreeMap::new(),
        }
    }

    pub(super) fn track(
        &mut self,
        receipt: &ManagementEnvelopeReceipt,
        action: PendingFactAction,
    ) -> bool {
        if self.pending.len() >= self.maximum_entries
            || self.pending.contains_key(receipt.message_id())
        {
            return false;
        }
        self.pending.insert(
            receipt.message_id().to_owned(),
            PendingFact {
                payload_digest: *receipt.payload_digest(),
                action,
            },
        );
        true
    }

    pub(super) fn contains_ack(&self, ack: &wire::ManagementAck) -> bool {
        self.pending
            .get(&ack.acknowledged_message_id)
            .is_some_and(|pending| {
                ack.acknowledged_payload_sha256.as_slice() == pending.payload_digest
            })
    }

    pub(super) fn take_ack(&mut self, ack: &wire::ManagementAck) -> Option<PendingFactAction> {
        if !self.contains_ack(ack) {
            return None;
        }
        self.pending
            .remove(&ack.acknowledged_message_id)
            .map(|pending| pending.action)
    }

    pub(super) fn len(&self) -> usize {
        self.pending.len()
    }
}
