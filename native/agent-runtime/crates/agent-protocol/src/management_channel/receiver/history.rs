use std::collections::{HashMap, HashSet, VecDeque};

use super::super::ManagementReplayLimits;
use super::model::{ReplayDisposition, ReplayedManagementFrame};

#[derive(Debug)]
pub(super) enum HistoryMatch {
    Unknown,
    Tombstone,
    Conflict,
    Replay {
        metadata: ReplayedManagementFrame,
        response: Option<std::sync::Arc<[u8]>>,
    },
}

#[derive(Debug)]
pub(super) struct CommittedMessage {
    pub envelope_digest: [u8; 32],
    pub stream_seq: u64,
    pub disposition: ReplayDisposition,
}

#[derive(Debug)]
struct BufferAccount {
    bytes: usize,
    references: usize,
}

#[derive(Debug)]
pub(super) struct ManagementHistory {
    limits: ManagementReplayLimits,
    active: HashMap<String, CommittedMessage>,
    order: VecDeque<String>,
    tombstones: HashSet<String>,
    replay_bytes: usize,
    buffers: HashMap<usize, BufferAccount>,
}

impl ManagementHistory {
    pub(super) fn new(limits: ManagementReplayLimits) -> Self {
        Self {
            limits,
            active: HashMap::with_capacity(limits.entries),
            order: VecDeque::with_capacity(limits.entries),
            tombstones: HashSet::with_capacity(
                limits.tracked_message_ids.saturating_sub(limits.entries),
            ),
            replay_bytes: 0,
            buffers: HashMap::with_capacity(limits.entries),
        }
    }

    pub(super) fn reserve_tombstone(&mut self, message_id: String) -> bool {
        if self.tracked_count() >= self.limits.tracked_message_ids {
            return false;
        }
        self.tombstones.insert(message_id)
    }

    pub(super) fn can_track_new(&self) -> bool {
        self.tracked_count() < self.limits.tracked_message_ids
    }

    pub(super) fn classify(&self, id: &str, digest: &[u8; 32]) -> HistoryMatch {
        if self.tombstones.contains(id) {
            return HistoryMatch::Tombstone;
        }
        let Some(message) = self.active.get(id) else {
            return HistoryMatch::Unknown;
        };
        if &message.envelope_digest != digest {
            return HistoryMatch::Conflict;
        }
        HistoryMatch::Replay {
            metadata: ReplayedManagementFrame::new(
                id.to_owned(),
                message.stream_seq,
                message.envelope_digest,
            ),
            response: message.disposition.shared_response(),
        }
    }

    pub(super) fn commit(
        &mut self,
        id: String,
        message: CommittedMessage,
    ) -> Result<(), super::super::ManagementChannelError> {
        if !self.can_track_new() {
            return Err(super::super::ManagementChannelError::IdentityCapacityExhausted);
        }
        self.evict_for_insert();
        let additional = message
            .disposition
            .response_allocation()
            .filter(|(key, _)| !self.buffers.contains_key(key))
            .map_or(0, |(_, bytes)| bytes);
        let required = self.replay_bytes.saturating_add(additional);
        if required > self.limits.bytes {
            return Err(
                super::super::ManagementChannelError::ReplayByteBudgetExhausted {
                    required,
                    maximum: self.limits.bytes,
                },
            );
        }
        self.retain(&message.disposition);
        self.order.push_back(id.clone());
        self.active.insert(id, message);
        Ok(())
    }

    pub(super) fn clear(&mut self) {
        self.active = HashMap::new();
        self.order = VecDeque::new();
        self.tombstones = HashSet::new();
        self.buffers = HashMap::new();
        self.replay_bytes = 0;
    }

    #[cfg(test)]
    pub(super) fn retained_state(&self) -> (usize, usize, usize) {
        (self.active.len(), self.tombstones.len(), self.replay_bytes)
    }

    fn tracked_count(&self) -> usize {
        self.active.len() + self.tombstones.len()
    }

    fn evict_for_insert(&mut self) {
        while self.active.len() >= self.limits.entries {
            let Some(id) = self.order.pop_front() else {
                break;
            };
            if let Some(message) = self.active.remove(&id) {
                self.release(&message.disposition);
                self.tombstones.insert(id);
            }
        }
    }

    fn retain(&mut self, disposition: &ReplayDisposition) {
        let Some((key, bytes)) = disposition.response_allocation() else {
            return;
        };
        let account = self.buffers.entry(key).or_insert(BufferAccount {
            bytes,
            references: 0,
        });
        if account.references == 0 {
            self.replay_bytes += bytes;
        }
        account.references += 1;
    }

    fn release(&mut self, disposition: &ReplayDisposition) {
        let Some((key, _)) = disposition.response_allocation() else {
            return;
        };
        let remove = self.buffers.get_mut(&key).is_some_and(|account| {
            account.references -= 1;
            account.references == 0
        });
        if remove && let Some(account) = self.buffers.remove(&key) {
            self.replay_bytes -= account.bytes;
        }
    }
}
