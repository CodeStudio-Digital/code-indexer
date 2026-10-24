use super::*;
use sha2::{Digest, Sha256};

fn text(role: wire::ProviderMessageRole, value: &str) -> wire::ProviderMessage {
    wire::ProviderMessage {
        role: role as i32,
        content: vec![wire::ProviderContentBlock {
            body: Some(wire::provider_content_block::Body::Text(
                wire::ProviderTextContent {
                    body: Some(wire::provider_text_content::Body::InlineUtf8(
                        value.to_owned(),
                    )),
                },
            )),
        }],
        ..Default::default()
    }
}

fn conversation() -> wire::ProviderTurnContext {
    let mut messages = vec![text(
        wire::ProviderMessageRole::User,
        "Keep this unresolved request exactly.",
    )];
    messages.extend((0..800).map(|i| {
        text(
            wire::ProviderMessageRole::Assistant,
            &format!("Observation {i}: verified text á中文"),
        )
    }));
    wire::ProviderTurnContext {
        messages,
        previous_response_id: Some("remote-old".to_owned()),
        previous_response_message_count: Some(800),
        prepared_user_context: Some(wire::ProviderPreparedUserContextV1 {
            message_index: 0,
            selected_skill_ids: vec!["coding".to_owned()],
            content_utf8: "protected instructions".to_owned(),
        }),
        ..Default::default()
    }
}

#[test]
fn byte_trigger_adapts_recent_window_and_keeps_tool_pairs() {
    let mut context = wire::ProviderTurnContext {
        messages: vec![text(wire::ProviderMessageRole::User, "Keep request")],
        ..Default::default()
    };
    for i in 0..20 {
        let id = format!("call-{i}");
        context.messages.push(wire::ProviderMessage {
            role: wire::ProviderMessageRole::Assistant as i32,
            content: vec![wire::ProviderContentBlock {
                body: Some(wire::provider_content_block::Body::ToolUse(
                    wire::ProviderToolUseContent {
                        tool_use_id: id.clone(),
                        capability_name: "read_file".into(),
                        ..Default::default()
                    },
                )),
            }],
            ..Default::default()
        });
        context.messages.push(wire::ProviderMessage {
            role: wire::ProviderMessageRole::Tool as i32,
            content: vec![wire::ProviderContentBlock {
                body: Some(wire::provider_content_block::Body::ToolResult(
                    wire::ProviderToolResultContent {
                        tool_use_id: id,
                        content: Some(wire::provider_tool_result_content::Content::InlineUtf8(
                            "x".repeat(32 * 1024),
                        )),
                        ..Default::default()
                    },
                )),
            }],
            ..Default::default()
        });
    }
    let original = context.messages.clone();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    assert_eq!(context.pending_chapters.len(), 1);
    assert!(
        context
            .messages
            .iter()
            .map(Message::encoded_len)
            .sum::<usize>()
            < 256 * 1024
    );
    assert_eq!(
        &context.messages[context.messages.len() - 2..],
        &original[original.len() - 2..]
    );
    let chapter = wire::ProviderContextChapterV1::decode(
        context.pending_chapters[0].encoded_chapter.as_slice(),
    )
    .unwrap();
    assert_eq!(chapter.messages.len() % 2, 0);
    assert_eq!(chapter.messages, original[1..=chapter.messages.len()]);
}

#[test]
fn soft_threshold_defers_a_large_protected_message_but_hard_limit_still_fails() {
    let mut context = wire::ProviderTurnContext {
        messages: vec![text(
            wire::ProviderMessageRole::User,
            &"x".repeat(600 * 1024),
        )],
        ..Default::default()
    };
    let before = context.encode_to_vec();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    assert_eq!(context.encode_to_vec(), before);
    assert!(compact_encoded_context(&before, "session-a", 512 * 1024).is_err());
}

#[test]
fn replaces_only_a_closed_prefix_and_retains_lossless_chapter() {
    let mut context = conversation();
    let original = context.messages.clone();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    assert!(context.messages.len() <= 256);
    assert_eq!(context.messages[0], original[0]);
    assert_eq!(context.messages.last(), original.last());
    assert!(context.previous_response_id.is_none());
    let write = &context.pending_chapters[0];
    let chapter = wire::ProviderContextChapterV1::decode(write.encoded_chapter.as_slice()).unwrap();
    assert_eq!(
        write.reference.as_ref().unwrap().content_sha256,
        Sha256::digest(&write.encoded_chapter).to_vec()
    );
    assert_eq!(chapter.messages, original[1..=chapter.messages.len()]);
    assert_eq!(context.messages[1].compacted_chapter, write.reference);
    assert_eq!(
        context
            .prepared_user_context
            .as_ref()
            .unwrap()
            .message_index,
        0
    );
    assert!(context.messages[1].encoded_len() < SUMMARY_BYTES);
}

#[test]
fn preserves_unresolved_user_and_remaps_pinned_context_after_archived_prefix() {
    let mut context = conversation();
    context.prepared_user_context = None;
    context
        .messages
        .push(text(wire::ProviderMessageRole::User, "Newest task"));
    context.prepared_user_context = Some(wire::ProviderPreparedUserContextV1 {
        message_index: 801,
        selected_skill_ids: vec![],
        content_utf8: "Instructions".to_owned(),
    });
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    let index = context
        .prepared_user_context
        .as_ref()
        .unwrap()
        .message_index as usize;
    assert_eq!(index, context.messages.len() - 1);
    assert_eq!(
        context.messages[index],
        text(wire::ProviderMessageRole::User, "Newest task")
    );
}

#[test]
fn pending_chapter_is_never_replaced_before_commit_and_encoding_keeps_budget() {
    let mut context = conversation();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    let first = context.encode_to_vec();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    assert_eq!(first, context.encode_to_vec());
    assert!(compact_encoded_context(&first, "session-a", 32).is_err());
}

#[test]
fn nested_chapters_keep_exact_prior_references_for_recovery() {
    let mut context = conversation();
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    let first = context.pending_chapters.remove(0).reference.unwrap();
    context
        .messages
        .extend((0..800).map(|_| text(wire::ProviderMessageRole::Assistant, "Later evidence")));
    compact(&mut context, "session-a", 8 * 1024 * 1024).unwrap();
    let chapter = wire::ProviderContextChapterV1::decode(
        context.pending_chapters[0].encoded_chapter.as_slice(),
    )
    .unwrap();
    assert!(
        chapter
            .messages
            .iter()
            .any(|m| m.compacted_chapter.as_ref() == Some(&first))
    );
    assert!(context.messages.len() <= 256);
}
