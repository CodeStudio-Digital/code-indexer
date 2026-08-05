use super::super::plan::LaunchPlan;
use super::super::state::{CleanupTrigger, SupervisorDriverState};
use super::support::launch_attempt;

#[test]
fn reap_interrupts_a_pending_provision_cleanup_retry_immediately() {
    let plan = LaunchPlan::from_validated(&launch_attempt(), [1; 32]).expect("launch plan");
    let key = plan.ownership_key();
    let mut state = SupervisorDriverState::default();
    state
        .schedule_attempt_cleanup(100, 10, false, [key.clone()])
        .expect("schedule grace");
    assert_eq!(
        state.take_due_terminations(110, 1).expect("termination"),
        vec![key.clone()]
    );
    state
        .schedule_provision_cleanup(&key, 210)
        .expect("schedule provision retry");

    state
        .schedule_physical_termination(CleanupTrigger::Reap, 111, 111, Some(300), [key.clone()])
        .expect("reap escalation");

    assert_eq!(
        state
            .take_due_provision_cleanups(111, 1)
            .expect("immediate provision retry"),
        vec![key]
    );
}

#[test]
fn reap_escalation_preserves_the_original_terminal_cause() {
    let plan = LaunchPlan::from_validated(&launch_attempt(), [7; 32]).expect("launch plan");
    let key = plan.ownership_key();
    let mut state = SupervisorDriverState::default();
    state
        .schedule_physical_termination(
            super::super::state::CleanupTrigger::Cancel,
            100,
            120,
            None,
            [key.clone()],
        )
        .expect("cancel schedule");
    state
        .schedule_physical_termination(
            super::super::state::CleanupTrigger::Reap,
            101,
            101,
            None,
            [key.clone()],
        )
        .expect("reap escalation");

    assert_eq!(
        state.cleanup_trigger(&key),
        Ok(super::super::state::CleanupTrigger::Cancel)
    );
}

#[test]
fn immediate_close_interrupts_a_pending_termination_retry() {
    let plan = LaunchPlan::from_validated(&launch_attempt(), [2; 32]).expect("launch plan");
    let key = plan.ownership_key();
    let mut state = SupervisorDriverState::default();
    state
        .schedule_attempt_cleanup(100, 0, true, [key.clone()])
        .expect("schedule immediate termination");
    assert_eq!(
        state.take_due_terminations(100, 1).expect("termination"),
        vec![key.clone()]
    );
    state
        .schedule_termination_retry(&key, 200)
        .expect("schedule retry");

    state
        .schedule_attempt_cleanup(101, 0, true, [key.clone()])
        .expect("immediate close");

    assert_eq!(
        state
            .take_due_terminations(101, 1)
            .expect("immediate retry"),
        vec![key]
    );
}

#[test]
fn reap_retry_only_restores_a_selected_reap() {
    let plan = LaunchPlan::from_validated(&launch_attempt(), [3; 32]).expect("launch plan");
    let key = plan.ownership_key();
    let mut state = SupervisorDriverState::default();
    state
        .schedule_attempt_cleanup(100, 0, true, [key.clone()])
        .expect("schedule termination");
    assert_eq!(
        state.take_due_terminations(100, 1).expect("termination"),
        vec![key.clone()]
    );
    assert_eq!(
        state.schedule_reap_retry(&key, 200),
        Err(super::super::state::CleanupStateError::InvalidTransition)
    );
    state.schedule_reap(&key, 100).expect("schedule reap");
    assert_eq!(
        state.take_due_reaps(100, 1).expect("select reap"),
        vec![key.clone()]
    );

    state
        .schedule_reap_retry(&key, 200)
        .expect("restore reap retry");

    assert!(
        state
            .take_due_reaps(199, 1)
            .expect("before retry")
            .is_empty()
    );
    assert_eq!(state.take_due_reaps(200, 1).expect("retry due"), vec![key]);
}
