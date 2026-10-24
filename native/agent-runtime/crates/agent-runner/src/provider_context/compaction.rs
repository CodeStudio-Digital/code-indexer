//! Bounded extractive context with lossless, authenticated cold chapters.
//! The Host commits chapters before acknowledging the compacted frontier.
use super::ProviderContextError;
use agent_engine::context::{
    CompactionBudget, CompactionPlan, CompactionPlanError, ContextMessage, ContextUsage,
    plan_compaction,
};
use agent_protocol::generated::v1 as wire;
use prost::Message;

mod chapter;
const SUMMARY_BYTES: usize = 16 * 1024;
#[cfg(test)]
mod tests;

pub fn compact_encoded_context(
    bytes: &[u8],
    session_id: &str,
    maximum: usize,
) -> Result<Vec<u8>, ProviderContextError> {
    let mut context = wire::ProviderTurnContext::decode(bytes)
        .map_err(|_| ProviderContextError::MalformedTurnContext)?;
    compact(&mut context, session_id, maximum)?;
    let encoded = context.encode_to_vec();
    if encoded.len() > maximum {
        return Err(ProviderContextError::ContextTooLarge {
            length: encoded.len(),
            maximum,
        });
    }
    Ok(encoded)
}

pub(super) fn compact(
    context: &mut wire::ProviderTurnContext,
    session_id: &str,
    maximum: usize,
) -> Result<(), ProviderContextError> {
    if !context.pending_chapters.is_empty() {
        return Ok(());
    }
    let Some(plan) = select(context, maximum)? else {
        return Ok(());
    };
    if session_id.is_empty() {
        return Err(ProviderContextError::MissingValidatedField("identity"));
    }
    let (message, pending) = chapter::create(&context.messages[plan.range.clone()], session_id);
    let removed = u32::try_from(plan.range.len() - 1)
        .map_err(|_| ProviderContextError::MalformedTurnContext)?;
    if let Some(pinned) = &mut context.prepared_user_context
        && pinned.message_index as usize >= plan.range.end
    {
        pinned.message_index -= removed;
    }
    if let Some(pinned) = &mut context.prepared_boundary_context
        && pinned.message_index as usize >= plan.range.end
    {
        pinned.message_index -= removed;
    }
    context.messages.splice(plan.range, [message]);
    context.pending_chapters.push(pending);
    context.previous_response_id = None;
    context.previous_response_message_count = None;
    Ok(())
}

fn select(
    context: &wire::ProviderTurnContext,
    maximum: usize,
) -> Result<Option<CompactionPlan>, ProviderContextError> {
    let last_user = context
        .messages
        .iter()
        .rposition(|m| m.role == wire::ProviderMessageRole::User as i32 && !m.is_meta);
    let calls: Vec<Vec<&str>> = context
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .filter_map(|b| match &b.body {
                    Some(wire::provider_content_block::Body::ToolUse(v)) => {
                        Some(v.tool_use_id.as_str())
                    }
                    _ => None,
                })
                .collect()
        })
        .collect();
    let results: Vec<Vec<&str>> = context
        .messages
        .iter()
        .map(|m| {
            m.content
                .iter()
                .filter_map(|b| match &b.body {
                    Some(wire::provider_content_block::Body::ToolResult(v)) => {
                        Some(v.tool_use_id.as_str())
                    }
                    _ => None,
                })
                .collect()
        })
        .collect();
    let metadata: Vec<_> = context
        .messages
        .iter()
        .enumerate()
        .map(|(i, m)| ContextMessage {
            // One token per encoded byte is a conservative tokenizer-independent ceiling.
            bytes: m.encoded_len(),
            tokens: m.encoded_len() as u64,
            protected: last_user == Some(i)
                || context
                    .prepared_user_context
                    .as_ref()
                    .is_some_and(|c| c.message_index as usize == i)
                || context
                    .prepared_boundary_context
                    .as_ref()
                    .is_some_and(|c| c.message_index as usize == i),
            tool_calls: &calls[i],
            tool_results: &results[i],
        })
        .collect();
    let trigger_bytes = (maximum / 4).min(512 * 1024);
    let target_bytes = trigger_bytes / 2;
    if target_bytes < SUMMARY_BYTES * 2 {
        return Ok(None);
    }
    let mut budget = CompactionBudget {
        trigger: ContextUsage {
            messages: 768,
            bytes: trigger_bytes,
            tokens: trigger_bytes as u64,
        },
        target: ContextUsage {
            messages: 256,
            bytes: target_bytes,
            tokens: target_bytes as u64,
        },
        replacement: ContextUsage {
            messages: 1,
            bytes: SUMMARY_BYTES,
            tokens: SUMMARY_BYTES as u64,
        },
        keep_recent_messages: 64,
    };
    // A byte trigger can fire long before there are 64 recent messages. Keep
    // the largest recent window that fits, always preserving complete pairs
    // and the independently protected request/instruction messages.
    for recent in [64, 32, 16, 8, 4, 2] {
        budget.keep_recent_messages = recent;
        match plan_compaction(&metadata, budget) {
            Err(CompactionPlanError::ProtectedWindow) => {}
            Err(_) => {
                return Err(ProviderContextError::InvalidCapabilityResult(
                    "context compaction requires valid closed tool pairs and bounds",
                ));
            }
            Ok(plan) => return Ok(plan),
        }
    }
    // Soft thresholds are scheduling hints. A single large protected/recent
    // message must not fail an otherwise valid provider turn prematurely.
    if context.messages.len() <= 2_048 && context.encoded_len() <= maximum {
        return Ok(None);
    }
    Err(ProviderContextError::InvalidCapabilityResult(
        "context compaction cannot preserve its protected window within hard limits",
    ))
}
