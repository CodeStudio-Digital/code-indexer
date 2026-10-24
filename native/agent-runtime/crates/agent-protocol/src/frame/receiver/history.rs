use std::collections::{HashMap, HashSet, VecDeque};

use super::model::{BoundedReplayOutcome, ReplayedFrame};

#[derive(Debug)]
pub(super) enum HistoryCommitError {
    IdentityCapacityExhausted,
    ReplayByteBudgetExhausted { required: usize, maximum: usize },
}

#[derive(Debug, Clone)]
pub(super) struct CommittedMessage {
    pub envelope_digest: [u8; 32],
    pub stream_seq: u64,
    pub outcome: BoundedReplayOutcome,
}

#[derive(Debug)]
struct ReplayBufferAccount {
    bytes: usize,
    references: usize,
}

#[derive(Debug)]
pub(super) enum HistoryMatch {
    Unknown,
    Tombstone,
    Conflict,
    Replay {
        frame: ReplayedFrame,
        response: Option<std::sync::Arc<[u8]>>,
    },
}

#[derive(Debug)]
pub(super) struct MessageHistory {
    replay_capacity: usize,
    total_capacity: usize,
    active: HashMap<String, CommittedMessage>,
    order: VecDeque<String>,
    tombstones: HashSet<String>,
    max_replay_bytes: usize,
    replay_bytes: usize,
    replay_buffers: HashMap<usize, ReplayBufferAccount>,
}

impl MessageHistory {
    pub(super) fn new(
        replay_capacity: usize,
        total_capacity: usize,
        max_replay_bytes: usize,
    ) -> Self {
        Self {
            replay_capacity,
            total_capacity,
            active: HashMap::with_capacity(replay_capacity),
            order: VecDeque::with_capacity(replay_capacity),
            tombstones: HashSet::with_capacity(total_capacity.saturating_sub(replay_capacity)),
            max_replay_bytes,
            replay_bytes: 0,
            replay_buffers: HashMap::with_capacity(replay_capacity),
        }
    }

    pub(super) fn reserve_tombstone(&mut self, message_id: String) -> bool {
        if self.tracked_count() >= self.total_capacity {
            return false;
        }
        self.tombstones.insert(message_id)
    }

    pub(super) fn classify(&self, message_id: &str, envelope_digest: &[u8; 32]) -> HistoryMatch {
        if self.tombstones.contains(message_id) {
            return HistoryMatch::Tombstone;
        }
        let Some(committed) = self.active.get(message_id) else {
            return HistoryMatch::Unknown;
        };
        if &committed.envelope_digest != envelope_digest {
            return HistoryMatch::Conflict;
        }
        HistoryMatch::Replay {
            frame: ReplayedFrame::new(
                message_id.to_owned(),
                committed.stream_seq,
                committed.envelope_digest,
            ),
            response: committed.outcome.shared_response(),
        }
    }

    pub(super) fn commit(
        &mut self,
        message_id: String,
        committed: CommittedMessage,
    ) -> Result<(), HistoryCommitError> {
        if self.tracked_count() >= self.total_capacity {
            return Err(HistoryCommitError::IdentityCapacityExhausted);
        }
        self.evict_for_insert();
        let additional = committed
            .outcome
            .response_allocation()
            .filter(|(key, _)| !self.replay_buffers.contains_key(key))
            .map_or(0, |(_, bytes)| bytes);
        let required = self.replay_bytes.saturating_add(additional);
        if required > self.max_replay_bytes {
            return Err(HistoryCommitError::ReplayByteBudgetExhausted {
                required,
                maximum: self.max_replay_bytes,
            });
        }
        self.retain_outcome(&committed.outcome);
        self.order.push_back(message_id.clone());
        self.active.insert(message_id, committed);
        Ok(())
    }

    pub(super) fn can_track_new(&self) -> bool {
        self.tracked_count() < self.total_capacity
    }

    pub(super) fn remaining_identity_capacity(&self) -> usize {
        self.total_capacity.saturating_sub(self.tracked_count())
    }

    pub(super) fn active_count(&self) -> usize {
        self.active.len()
    }

    pub(super) fn tombstone_count(&self) -> usize {
        self.tombstones.len()
    }

    pub(super) const fn replay_bytes(&self) -> usize {
        self.replay_bytes
    }

    pub(super) fn clear(&mut self) {
        self.active.clear();
        self.order.clear();
        self.tombstones.clear();
        self.replay_buffers.clear();
        self.replay_bytes = 0;
    }

    fn tracked_count(&self) -> usize {
        self.active.len() + self.tombstones.len()
    }

    fn evict_for_insert(&mut self) {
        while self.active.len() >= self.replay_capacity {
            let Some(message_id) = self.order.pop_front() else {
                break;
            };
            if let Some(committed) = self.active.remove(&message_id) {
                self.release_outcome(&committed.outcome);
                self.tombstones.insert(message_id);
            }
        }
    }

    fn retain_outcome(&mut self, outcome: &BoundedReplayOutcome) {
        let Some((key, bytes)) = outcome.response_allocation() else {
            return;
        };
        let account = self
            .replay_buffers
            .entry(key)
            .or_insert(ReplayBufferAccount {
                bytes,
                references: 0,
            });
        if account.references == 0 {
            self.replay_bytes += bytes;
        }
        account.references += 1;
    }

    fn release_outcome(&mut self, outcome: &BoundedReplayOutcome) {
        let Some((key, _)) = outcome.response_allocation() else {
            return;
        };
        let remove = self.replay_buffers.get_mut(&key).is_some_and(|account| {
            account.references -= 1;
            account.references == 0
        });
        if remove && let Some(account) = self.replay_buffers.remove(&key) {
            self.replay_bytes -= account.bytes;
        }
    }
}
