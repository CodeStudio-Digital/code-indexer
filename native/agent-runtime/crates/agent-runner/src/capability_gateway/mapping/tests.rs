use agent_protocol::generated::v1 as wire;

use super::{MAX_EXECUTION_DURATION_MS, bounded_identifier, failure};

#[test]
fn execution_result_identifiers_are_bounded() {
    assert!(bounded_identifier("result.v1"));
    assert!(!bounded_identifier(""));
    assert!(!bounded_identifier("bad\0identifier"));
    assert!(!bounded_identifier(&"x".repeat(1_025)));
}

#[test]
fn execution_failure_rejects_unbounded_duration() {
    let result = failure(wire::CapabilityExecutionFailure {
        reason_code: "timed_out".into(),
        duration_ms: MAX_EXECUTION_DURATION_MS + 1,
    });

    assert!(result.is_err());
}
