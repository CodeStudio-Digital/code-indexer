use agent_protocol::generated::v1 as wire;

use super::super::facts::LaunchRejection;
use super::super::launch_registry::{LaunchIntentKey, LaunchRegistry, LaunchRegistryMatch};
use super::super::plan::LaunchPlan;
use super::support::launch_attempt;

#[test]
fn capacity_evicts_eligible_records_in_original_reservation_order() {
    let plans = [plan(1), plan(2), plan(3), plan(4), plan(5)];
    let mut registry = LaunchRegistry::new(3);
    let first = reserve(&mut registry, &plans[0]);
    let second = reserve(&mut registry, &plans[1]);
    reserve(&mut registry, &plans[2]);
    make_durable_rejection(&mut registry, &plans[0], &first, false);
    make_durable_rejection(&mut registry, &plans[1], &second, false);

    reserve(&mut registry, &plans[3]);
    assert_eq!(registry.classify(&plans[0]), LaunchRegistryMatch::Fresh);
    assert!(matches!(
        registry.classify(&plans[1]),
        LaunchRegistryMatch::Rejected { .. }
    ));
    assert!(matches!(
        registry.classify(&plans[2]),
        LaunchRegistryMatch::Pending(_)
    ));

    reserve(&mut registry, &plans[4]);
    assert_eq!(registry.classify(&plans[1]), LaunchRegistryMatch::Fresh);
    assert!(matches!(
        registry.classify(&plans[2]),
        LaunchRegistryMatch::Pending(_)
    ));
    assert!(matches!(
        registry.classify(&plans[3]),
        LaunchRegistryMatch::Pending(_)
    ));
}

#[test]
fn pending_nondurable_and_unacknowledged_records_never_evict() {
    let first_plan = plan(1);
    let replacement = plan(2);

    let mut pending = LaunchRegistry::new(1);
    reserve(&mut pending, &first_plan);
    assert!(
        pending
            .reserve(&replacement, replacement.ownership_key())
            .is_none()
    );

    let mut rejected = LaunchRegistry::new(1);
    let intent = reserve(&mut rejected, &first_plan);
    assert!(rejected.mark_rejected(
        &intent,
        &first_plan,
        LaunchRejection::InvalidEndpoints,
        101,
        false,
    ));
    assert!(rejected.record_fact_sent(&intent));
    assert_eq!(
        rejected.state_for_test(first_plan.idempotency_key()),
        Some((1, false, false, false, false))
    );
    assert!(
        rejected
            .reserve(&replacement, replacement.ownership_key())
            .is_none()
    );

    assert!(rejected.record_fact_sent(&intent));
    assert!(rejected.acknowledge_fact(&intent, true));
    assert_eq!(
        rejected.state_for_test(first_plan.idempotency_key()),
        Some((1, true, false, false, false))
    );
    assert!(
        rejected
            .reserve(&replacement, replacement.ownership_key())
            .is_none()
    );
}

#[test]
fn owned_record_requires_containment_ack_and_reap_in_either_order() {
    let first_plan = plan(1);
    let replacement = plan(2);
    let mut ack_then_reap = LaunchRegistry::new(1);
    let intent = reserve(&mut ack_then_reap, &first_plan);
    assert!(ack_then_reap.mark_owned_for_test(&intent, &first_plan));
    make_host_durable(&mut ack_then_reap, &intent);
    assert!(
        ack_then_reap
            .reserve(&replacement, replacement.ownership_key())
            .is_none()
    );
    ack_then_reap.mark_physical_reaped(&first_plan.ownership_key());
    reserve(&mut ack_then_reap, &replacement);

    let third_plan = plan(3);
    let fourth_plan = plan(4);
    let mut reap_then_ack = LaunchRegistry::new(1);
    let intent = reserve(&mut reap_then_ack, &third_plan);
    assert!(reap_then_ack.mark_owned_for_test(&intent, &third_plan));
    reap_then_ack.mark_physical_reaped(&third_plan.ownership_key());
    assert!(
        reap_then_ack
            .reserve(&fourth_plan, fourth_plan.ownership_key())
            .is_none()
    );
    make_host_durable(&mut reap_then_ack, &intent);
    reserve(&mut reap_then_ack, &fourth_plan);
}

#[test]
fn rejection_ack_is_durable_but_physical_rejection_still_requires_reap() {
    let first_plan = plan(1);
    let replacement = plan(2);
    let mut pre_spawn = LaunchRegistry::new(1);
    let intent = reserve(&mut pre_spawn, &first_plan);
    make_durable_rejection(&mut pre_spawn, &first_plan, &intent, false);
    reserve(&mut pre_spawn, &replacement);

    let third_plan = plan(3);
    let fourth_plan = plan(4);
    let mut physically_owned = LaunchRegistry::new(1);
    let intent = reserve(&mut physically_owned, &third_plan);
    make_durable_rejection(&mut physically_owned, &third_plan, &intent, true);
    assert!(
        physically_owned
            .reserve(&fourth_plan, fourth_plan.ownership_key())
            .is_none()
    );
    physically_owned.mark_physical_reaped(&third_plan.ownership_key());
    reserve(&mut physically_owned, &fourth_plan);
}

fn make_durable_rejection(
    registry: &mut LaunchRegistry,
    plan: &LaunchPlan,
    intent: &LaunchIntentKey,
    physical_cleanup_required: bool,
) {
    assert!(registry.mark_rejected(
        intent,
        plan,
        LaunchRejection::InvalidEndpoints,
        101,
        physical_cleanup_required,
    ));
    make_host_durable(registry, intent);
}

fn make_host_durable(registry: &mut LaunchRegistry, intent: &LaunchIntentKey) {
    assert!(registry.record_fact_sent(intent));
    assert!(registry.acknowledge_fact(intent, true));
}

fn reserve(registry: &mut LaunchRegistry, plan: &LaunchPlan) -> LaunchIntentKey {
    registry
        .reserve(plan, plan.ownership_key())
        .expect("registry reservation")
}

fn plan(index: u8) -> LaunchPlan {
    let launch = distinct_launch(index);
    LaunchPlan::from_validated(&launch, [index; 32]).expect("valid launch plan")
}

fn distinct_launch(index: u8) -> wire::LaunchAttemptProcess {
    let mut launch = launch_attempt();
    let identity = launch.identity.as_mut().expect("launch identity");
    identity.command_id = format!("22222222-2222-4222-8222-{index:012x}");
    identity.attempt_id = format!("44444444-4444-4444-8444-{index:012x}");
    identity.correlation_id = format!("55555555-5555-4555-8555-{index:012x}");
    launch.idempotency_key = format!("intent:{index}");
    launch.launch_nonce[0] = index;
    launch
}
