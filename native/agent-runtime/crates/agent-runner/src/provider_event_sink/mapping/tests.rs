use agent_engine::ports::EngineEvent;
use agent_tools::capability::{CapabilityExecutionOutcome, CapabilityFailure};

use super::{event_body, wire};

#[test]
fn ambiguous_executor_result_maps_to_authoritative_unknown_terminal() {
    let outcome = CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure {
        reason_code: "executor_result_ambiguous".into(),
        duration_ms: 7,
    });

    let body = event_body(EngineEvent::CapabilityTerminal {
        operation_id: "capability/tool/1",
        tool_use_id: "tool/1",
        grant_id: "grant/1",
        outcome: &outcome,
        completed_at_unix_ms: 107,
    })
    .expect("unknown terminal mapping");

    let wire::engine_event_record_v1::Body::CapabilityTerminal(terminal) = body else {
        panic!("capability terminal expected");
    };
    assert_eq!(
        terminal.classification,
        wire::EngineCapabilityTerminalClassificationV1::OutcomeUnknown as i32
    );
    assert_eq!(terminal.reason_code, "executor_result_ambiguous");
    assert_eq!(terminal.result_bytes, 0);
    assert_eq!(terminal.completed_at_unix_ms, 107);
}
