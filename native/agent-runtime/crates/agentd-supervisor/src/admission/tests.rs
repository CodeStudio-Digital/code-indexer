use super::{AdmissionError, AdmissionLedger, ReservationToken, SupervisorCapacity};
use agent_platform::budget::ResourceBudget;
use agent_protocol::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, CorrelationId, ExecutorOwnerId, SessionId,
};

fn identity(attempt: &str, fence: u64) -> AttemptIdentity {
    let attempt = match attempt {
        "attempt-1" => "44444444-4444-4444-8444-444444444444",
        "attempt-2" => "99999999-9999-4999-8999-999999999999",
        other => panic!("unknown attempt fixture label: {other}"),
    };
    AttemptIdentity {
        session_id: SessionId::new("11111111-1111-4111-8111-111111111111").expect("valid ID"),
        command_id: CommandId::new("22222222-2222-4222-8222-222222222222").expect("valid ID"),
        agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333").expect("valid ID"),
        attempt_id: AttemptId::new(attempt).expect("valid ID"),
        executor_owner_id: ExecutorOwnerId::new("owner").expect("valid ID"),
        fencing_epoch: fence,
        correlation_id: CorrelationId::new("55555555-5555-4555-8555-555555555555")
            .expect("valid ID"),
        root_agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333")
            .expect("valid ID"),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

fn budget(memory: u64, processes: u32) -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: memory / 2,
        hard_memory_bytes: memory,
        cpu_time_ms: 60_000,
        max_wall_ms: 60_000,
        max_processes: processes,
        max_threads: 16,
        max_open_handles: 128,
        max_hot_transcript_bytes: 1_024,
        max_ipc_frames: 64,
        max_ipc_bytes: 65_536,
        max_spool_bytes: 1_024,
        max_artifact_bytes: 1_024,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1_000,
    }
}

fn ledger() -> AdmissionLedger {
    AdmissionLedger::new(SupervisorCapacity {
        max_active_attempts: 2,
        max_reserved_memory_bytes: 200,
        max_reserved_processes: 4,
    })
    .expect("valid capacity")
}

#[test]
fn reserves_before_spawn_and_returns_totals_only_on_release() {
    let mut ledger = ledger();
    let token = ledger
        .reserve(&identity("attempt-1", 3), &budget(100, 2))
        .expect("reservation");

    assert_eq!(ledger.active_attempts(), 1);
    assert_eq!(ledger.reserved_memory_bytes(), 100);
    assert_eq!(ledger.reserved_processes(), 2);

    ledger.release(token).expect("release current token");
    assert_eq!(ledger.active_attempts(), 0);
    assert_eq!(ledger.reserved_memory_bytes(), 0);
    assert_eq!(ledger.reserved_processes(), 0);
}

#[test]
fn aggregate_limits_and_duplicates_fail_closed() {
    let mut ledger = ledger();
    ledger
        .reserve(&identity("attempt-1", 3), &budget(100, 2))
        .expect("first reservation");

    assert_eq!(
        ledger.reserve(&identity("attempt-1", 3), &budget(50, 1)),
        Err(AdmissionError::DuplicateAttempt)
    );
    assert_eq!(
        ledger.reserve(&identity("attempt-2", 3), &budget(101, 1)),
        Err(AdmissionError::MemoryExhausted)
    );
    assert_eq!(
        ledger.reserve(&identity("attempt-2", 3), &budget(100, 3)),
        Err(AdmissionError::ProcessesExhausted)
    );
}

#[test]
fn stale_release_cannot_free_the_current_attempt() {
    let mut ledger = ledger();
    let current = ledger
        .reserve(&identity("attempt-1", 3), &budget(100, 2))
        .expect("reservation");
    let stale = ReservationToken {
        attempt_id: AttemptId::new("44444444-4444-4444-8444-444444444444").expect("valid ID"),
        fencing_epoch: 2,
        sequence: current.sequence,
    };

    assert_eq!(ledger.release(stale), Err(AdmissionError::StaleReservation));
    assert_eq!(ledger.active_attempts(), 1);
    ledger.release(current).expect("current token");
}
