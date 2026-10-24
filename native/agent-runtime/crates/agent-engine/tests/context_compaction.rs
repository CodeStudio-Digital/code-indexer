use agent_engine::context::{
    CompactionBudget, CompactionPlanError, ContextMessage, ContextUsage, plan_compaction,
};

const fn usage(messages: usize, bytes: usize, tokens: u64) -> ContextUsage {
    ContextUsage {
        messages,
        bytes,
        tokens,
    }
}
const fn budget() -> CompactionBudget {
    CompactionBudget {
        trigger: usage(10, 1000, 1000),
        target: usage(6, 600, 600),
        replacement: usage(1, 100, 100),
        keep_recent_messages: 2,
    }
}
const fn text() -> ContextMessage<'static> {
    ContextMessage {
        bytes: 100,
        tokens: 100,
        protected: false,
        tool_calls: &[],
        tool_results: &[],
    }
}

#[test]
fn keeps_unresolved_input_and_recent_messages_and_reserves_summary() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    messages[0].protected = true;
    let plan = plan_compaction(&messages, budget()).unwrap().unwrap();
    assert_eq!(plan.range, 1..8);
    assert_eq!(plan.removed, usage(7, 700, 700));
    assert_eq!(plan.retained_with_replacement, usage(6, 600, 600));
    assert_eq!(messages.len(), 12);
}

#[test]
fn keeps_complete_parallel_pairs_with_out_of_order_results() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    messages[0].protected = true;
    messages[1].tool_calls = &["a", "b"];
    messages[7].tool_results = &["b"];
    messages[8].tool_results = &["a"];
    assert_eq!(
        plan_compaction(&messages, budget()).unwrap().unwrap().range,
        1..9
    );
}

#[test]
fn never_archives_a_pair_whose_result_is_in_the_recent_window() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    messages[0].protected = true;
    messages[1].tool_calls = &["pending"];
    messages[11].tool_results = &["pending"];
    assert_eq!(
        plan_compaction(&messages, budget()),
        Err(CompactionPlanError::ProtectedWindow)
    );
}

#[test]
fn keeps_a_live_unsettled_call_and_can_compact_earlier_closed_turns() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    messages[0].protected = true;
    messages[11].tool_calls = &["pending"];
    assert_eq!(
        plan_compaction(&messages, budget()).unwrap().unwrap().range,
        1..8
    );
}

#[test]
fn never_crosses_a_protected_interaction_or_its_open_pair() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    messages[1].tool_calls = &["ask"];
    messages[3].protected = true;
    messages[8].tool_results = &["ask"];
    assert_eq!(
        plan_compaction(&messages, budget()),
        Err(CompactionPlanError::ProtectedWindow)
    );
}

#[test]
fn considers_bytes_and_tokens_even_below_message_count_limit() {
    for dimension in ["bytes", "tokens"] {
        let mut messages: Vec<_> = (0..8).map(|_| text()).collect();
        if dimension == "bytes" {
            messages[0].bytes = 900;
        } else {
            messages[0].tokens = 900;
        }
        let plan = plan_compaction(&messages, budget()).unwrap().unwrap();
        assert_eq!(plan.range, 0..3);
        assert_eq!(plan.retained_with_replacement, usage(6, 600, 600));
    }
}

#[test]
fn rejects_malformed_pairs_and_overflow_instead_of_losing_history() {
    let mut messages = vec![text(), text()];
    messages[0].tool_calls = &["id", "id"];
    assert_eq!(
        plan_compaction(&messages, budget()),
        Err(CompactionPlanError::InvalidConversation)
    );
    messages[0].tool_calls = &[];
    messages[0].tool_results = &["foreign"];
    assert_eq!(
        plan_compaction(&messages, budget()),
        Err(CompactionPlanError::InvalidConversation)
    );
    messages[0].tool_results = &[];
    messages[0].bytes = usize::MAX;
    assert_eq!(
        plan_compaction(&messages, budget()),
        Err(CompactionPlanError::Overflow)
    );
}

#[test]
fn respects_safe_call_id_reuse_in_later_settled_turns() {
    let mut messages: Vec<_> = (0..12).map(|_| text()).collect();
    for index in (0..10).step_by(2) {
        messages[index].tool_calls = &["reused"];
        messages[index + 1].tool_results = &["reused"];
    }
    assert_eq!(
        plan_compaction(&messages, budget()).unwrap().unwrap().range,
        0..8
    );
}

#[test]
fn keeps_small_windows_and_refuses_impossible_summary_reservations() {
    assert_eq!(plan_compaction(&[text(), text()], budget()), Ok(None));
    let mut impossible = budget();
    impossible.replacement = usage(7, 100, 100);
    assert_eq!(
        plan_compaction(&[text(), text()], impossible),
        Err(CompactionPlanError::InvalidBudget)
    );
}

#[test]
fn preserves_all_pairings_across_different_window_sizes() {
    for pairs in 8..100 {
        let mut messages: Vec<_> = (0..=pairs * 2).map(|_| text()).collect();
        messages[0].protected = true;
        for index in (1..messages.len()).step_by(2) {
            messages[index].tool_calls = &["same-provider-id"];
            messages[index + 1].tool_results = &["same-provider-id"];
        }
        let plan = plan_compaction(&messages, budget()).unwrap().unwrap();
        assert_eq!(plan.range.start, 1);
        assert_eq!((plan.range.end - 1) % 2, 0);
        assert!(plan.range.end <= messages.len() - 2);
        assert!(plan.retained_with_replacement.messages <= budget().target.messages);
        assert_eq!(messages.len(), pairs * 2 + 1);
    }
}
