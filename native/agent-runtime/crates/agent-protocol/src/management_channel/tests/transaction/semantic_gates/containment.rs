use super::*;

fn complete_containment_fact() -> wire::AttemptContainmentReport {
    wire::AttemptContainmentReport {
        identity: Some(super::super::super::support::attempt_identity()),
        runtime_instance_id: "runtime:test".into(),
        requested_budget: Some(super::super::super::support::resource_budget()),
        effective_containment: Some(wire::ContainmentReport {
            level: wire::ContainmentLevel::HardAggregate as i32,
            enforced_limits: vec![
                wire::ResourceLimitKind::Memory as i32,
                wire::ResourceLimitKind::CpuTime as i32,
                wire::ResourceLimitKind::WallTime as i32,
                wire::ResourceLimitKind::Processes as i32,
            ],
            unsupported_limits: vec![
                wire::ResourceLimitKind::Threads as i32,
                wire::ResourceLimitKind::OpenHandles as i32,
                wire::ResourceLimitKind::ScratchBytes as i32,
            ],
            capabilities: Some(wire::ContainmentCapabilities {
                process_tree: true,
                memory_limit: true,
                cpu_limit: true,
                process_count_limit: true,
                ..wire::ContainmentCapabilities::default()
            }),
        }),
        reported_at_unix_ms: NOW + 1,
    }
}

fn assert_rejected(fact: wire::AttemptContainmentReport, id: &str) {
    let mut channel = host_channel(
        vec![frame(
            wire::management_payload::Body::AttemptContainmentReport(fact),
            id,
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::InvalidManagementPayload { .. })
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn complete_containment_partition_and_capabilities_are_accepted() {
    let mut channel = host_channel(
        vec![frame(
            wire::management_payload::Body::AttemptContainmentReport(complete_containment_fact()),
            "complete-containment",
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Ok(Some(ManagementReceiveOutcome::Pending(_)))
    ));
}

#[test]
fn hard_aggregate_scope_allows_a_truthful_partial_limit_set() {
    let mut partial = complete_containment_fact();
    let report = partial.effective_containment.as_mut().expect("containment");
    report.enforced_limits = vec![wire::ResourceLimitKind::Memory as i32];
    report.unsupported_limits = all_limits()
        .into_iter()
        .filter(|limit| *limit != wire::ResourceLimitKind::Memory as i32)
        .collect();
    report.capabilities = Some(wire::ContainmentCapabilities {
        process_tree: true,
        memory_limit: true,
        ..wire::ContainmentCapabilities::default()
    });

    let mut channel = host_channel(
        vec![frame(
            wire::management_payload::Body::AttemptContainmentReport(partial),
            "partial-hard-aggregate",
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Ok(Some(ManagementReceiveOutcome::Pending(_)))
    ));
}

#[test]
fn enforced_and_unsupported_limits_must_match_mapped_capabilities() {
    let mut enforced_without_capability = complete_containment_fact();
    enforced_without_capability
        .effective_containment
        .as_mut()
        .expect("containment")
        .capabilities
        .as_mut()
        .expect("capabilities")
        .memory_limit = false;
    assert_rejected(enforced_without_capability, "enforced-without-capability");

    let mut unsupported_with_capability = complete_containment_fact();
    let report = unsupported_with_capability
        .effective_containment
        .as_mut()
        .expect("containment");
    report
        .enforced_limits
        .retain(|limit| *limit != wire::ResourceLimitKind::Memory as i32);
    report
        .unsupported_limits
        .push(wire::ResourceLimitKind::Memory as i32);
    assert_rejected(unsupported_with_capability, "unsupported-with-capability");
}

#[test]
fn containment_level_cannot_contradict_capabilities() {
    let mut aggregate_without_tree = complete_containment_fact();
    aggregate_without_tree
        .effective_containment
        .as_mut()
        .expect("containment")
        .capabilities
        .as_mut()
        .expect("capabilities")
        .process_tree = false;
    assert_rejected(aggregate_without_tree, "aggregate-without-tree");

    let mut process_without_tree = complete_containment_fact();
    let report = process_without_tree
        .effective_containment
        .as_mut()
        .expect("containment");
    report.level = wire::ContainmentLevel::HardProcess as i32;
    report
        .capabilities
        .as_mut()
        .expect("capabilities")
        .process_tree = false;
    assert_rejected(process_without_tree, "hard-process-without-tree");

    let mut unavailable_with_capability = complete_containment_fact();
    let report = unavailable_with_capability
        .effective_containment
        .as_mut()
        .expect("containment");
    report.level = wire::ContainmentLevel::Unavailable as i32;
    report.enforced_limits.clear();
    report.unsupported_limits = all_limits();
    assert_rejected(unavailable_with_capability, "unavailable-with-capability");
}

#[test]
fn every_v1_budget_limit_must_be_classified_exactly_once() {
    let mut incomplete = complete_containment_fact();
    incomplete
        .effective_containment
        .as_mut()
        .expect("containment")
        .unsupported_limits
        .pop();
    assert_rejected(incomplete, "incomplete-limit-partition");
}

fn all_limits() -> Vec<i32> {
    [
        wire::ResourceLimitKind::Memory,
        wire::ResourceLimitKind::CpuTime,
        wire::ResourceLimitKind::WallTime,
        wire::ResourceLimitKind::Processes,
        wire::ResourceLimitKind::Threads,
        wire::ResourceLimitKind::OpenHandles,
        wire::ResourceLimitKind::ScratchBytes,
    ]
    .into_iter()
    .map(|limit| limit as i32)
    .collect()
}
