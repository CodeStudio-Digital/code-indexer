//! Plans a bounded cold chapter without changing or discarding the transcript.
//!
//! Applying a plan requires a separately authenticated, durably committed
//! chapter and summary. A planning failure must leave the input intact.

use std::collections::BTreeSet;
use std::ops::Range;

const MAX_MESSAGES: usize = 100_000;
const MAX_CALL_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContextUsage {
    pub messages: usize,
    pub bytes: usize,
    pub tokens: u64,
}

impl ContextUsage {
    const ZERO: Self = Self {
        messages: 0,
        bytes: 0,
        tokens: 0,
    };

    const fn fits(self, bound: Self) -> bool {
        self.messages <= bound.messages && self.bytes <= bound.bytes && self.tokens <= bound.tokens
    }

    fn add(self, other: Self) -> Result<Self, CompactionPlanError> {
        Ok(Self {
            messages: self
                .messages
                .checked_add(other.messages)
                .ok_or(CompactionPlanError::Overflow)?,
            bytes: self
                .bytes
                .checked_add(other.bytes)
                .ok_or(CompactionPlanError::Overflow)?,
            tokens: self
                .tokens
                .checked_add(other.tokens)
                .ok_or(CompactionPlanError::Overflow)?,
        })
    }

    fn subtract(self, other: Self) -> Result<Self, CompactionPlanError> {
        Ok(Self {
            messages: self
                .messages
                .checked_sub(other.messages)
                .ok_or(CompactionPlanError::Overflow)?,
            bytes: self
                .bytes
                .checked_sub(other.bytes)
                .ok_or(CompactionPlanError::Overflow)?,
            tokens: self
                .tokens
                .checked_sub(other.tokens)
                .ok_or(CompactionPlanError::Overflow)?,
        })
    }
}

/// Metadata derived by the engine from its validated, immutable conversation.
///
/// `protected` covers unresolved user input, selected instructions, pending
/// interactions and active authority; the model cannot choose this flag.
#[derive(Debug)]
pub struct ContextMessage<'a> {
    pub bytes: usize,
    pub tokens: u64,
    pub protected: bool,
    pub tool_calls: &'a [&'a str],
    pub tool_results: &'a [&'a str],
}

#[derive(Debug, Clone, Copy)]
pub struct CompactionBudget {
    pub trigger: ContextUsage,
    pub target: ContextUsage,
    /// Includes the summary, its chapter references and serialization framing.
    /// The actual replacement must fit this reservation before it can commit.
    pub replacement: ContextUsage,
    pub keep_recent_messages: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionPlan {
    pub range: Range<usize>,
    pub removed: ContextUsage,
    pub retained_with_replacement: ContextUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionPlanError {
    InvalidBudget,
    InvalidConversation,
    Overflow,
    ProtectedWindow,
}

/// Chooses a closed, unprotected span for a cold chapter.
///
/// Preserves complete tool pairs and the recent/protected window. Work is
/// linear in messages plus ordered-set operations for tool identities.
///
/// # Errors
/// Rejects invalid bounds/pairing/overflow, or a window that cannot fit without
/// removing protected context. This function never edits the input.
pub fn plan_compaction(
    messages: &[ContextMessage<'_>],
    budget: CompactionBudget,
) -> Result<Option<CompactionPlan>, CompactionPlanError> {
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err(CompactionPlanError::InvalidConversation);
    }
    if budget.target.messages == 0
        || budget.target.bytes == 0
        || budget.target.tokens == 0
        || !budget.target.fits(budget.trigger)
        || budget.replacement.messages == 0
        || !budget.replacement.fits(budget.target)
        || budget.keep_recent_messages == 0
    {
        return Err(CompactionPlanError::InvalidBudget);
    }
    let mut prefix = Vec::with_capacity(messages.len() + 1);
    let mut closed = Vec::with_capacity(messages.len() + 1);
    let mut open = BTreeSet::new();
    let mut total = ContextUsage::ZERO;
    let mut call_count = 0_usize;
    prefix.push(total);
    closed.push(true);
    for message in messages {
        if message.tool_calls.len() > 256 || message.tool_results.len() > 256 {
            return Err(CompactionPlanError::InvalidConversation);
        }
        call_count = call_count
            .checked_add(message.tool_calls.len())
            .ok_or(CompactionPlanError::Overflow)?;
        if call_count > MAX_MESSAGES {
            return Err(CompactionPlanError::InvalidConversation);
        }
        total = total.add(ContextUsage {
            messages: 1,
            bytes: message.bytes,
            tokens: message.tokens,
        })?;
        for id in message.tool_calls {
            if id.is_empty()
                || id.len() > MAX_CALL_ID_BYTES
                || id.contains('\0')
                || !open.insert(*id)
            {
                return Err(CompactionPlanError::InvalidConversation);
            }
        }
        for id in message.tool_results {
            if !open.remove(id) {
                return Err(CompactionPlanError::InvalidConversation);
            }
        }
        prefix.push(total);
        closed.push(open.is_empty());
    }
    if total.fits(budget.trigger) {
        return Ok(None);
    }
    // An open tool pair is legal in the live window, but never in a chapter.
    let end_limit = messages.len().saturating_sub(budget.keep_recent_messages);
    let mut start = None;
    for index in 0..end_limit {
        if messages[index].protected {
            start = None;
            continue;
        }
        if start.is_none() && closed[index] {
            start = Some(index);
        }
        let Some(first) = start else {
            continue;
        };
        let end = index + 1;
        if !closed[end] {
            continue;
        }
        let removed = prefix[end].subtract(prefix[first])?;
        let retained = total.subtract(removed)?.add(budget.replacement)?;
        if retained.fits(budget.target) {
            return Ok(Some(CompactionPlan {
                range: first..end,
                removed,
                retained_with_replacement: retained,
            }));
        }
    }
    Err(CompactionPlanError::ProtectedWindow)
}
