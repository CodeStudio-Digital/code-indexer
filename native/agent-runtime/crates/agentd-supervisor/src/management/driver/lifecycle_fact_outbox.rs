use std::collections::VecDeque;

use super::PreparedFactEmission;

/// Bounded handoff between physical cleanup and the management writer.
///
/// An entry is created before the ownership record is discarded. The async
/// service gives this queue priority over accepting another management
/// command, so lifecycle evidence cannot be silently overtaken by new work.
#[derive(Debug)]
pub(super) struct LifecycleFactOutbox {
    maximum_entries: usize,
    pending: VecDeque<PreparedFactEmission>,
}

impl LifecycleFactOutbox {
    pub(super) const fn new(maximum_entries: usize) -> Self {
        Self {
            maximum_entries,
            pending: VecDeque::new(),
        }
    }

    pub(super) fn has_capacity(&self) -> bool {
        self.pending.len() < self.maximum_entries
    }

    pub(super) fn push(&mut self, emission: PreparedFactEmission) -> bool {
        if !self.has_capacity() {
            return false;
        }
        self.pending.push_back(emission);
        true
    }

    pub(super) fn pop(&mut self) -> Option<PreparedFactEmission> {
        self.pending.pop_front()
    }

    pub(super) fn len(&self) -> usize {
        self.pending.len()
    }
}
