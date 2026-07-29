use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};

use super::*;

fn receive_launch(
    launch: wire::LaunchAttemptProcess,
) -> Result<Option<ManagementReceiveOutcome>, ManagementChannelError> {
    let mut channel = super::super::super::support::supervisor_channel(
        vec![frame(
            wire::management_payload::Body::LaunchAttemptProcess(launch),
            "endpoint-caps",
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );
    channel.begin_receive_with_clock(|| NOW + 2)
}

#[test]
fn launch_requires_each_normative_endpoint_cap_exactly() {
    let launch = super::super::super::support::launch_attempt();
    let actual = launch
        .protected_endpoints
        .iter()
        .map(|endpoint| (endpoint.kind, endpoint.max_frame_bytes))
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        vec![
            (
                wire::AttemptEndpointKind::Control as i32,
                CONTROL_FRAME_MAX_BYTES as u64,
            ),
            (
                wire::AttemptEndpointKind::Data as i32,
                DATA_FRAME_MAX_BYTES as u64,
            ),
            (
                wire::AttemptEndpointKind::RunnerPulse as i32,
                PULSE_FRAME_MAX_BYTES as u64,
            ),
        ]
    );
    assert!(matches!(
        receive_launch(launch),
        Ok(Some(ManagementReceiveOutcome::Pending(_)))
    ));
}

#[test]
fn smaller_or_larger_endpoint_caps_fail_closed_for_every_kind() {
    for endpoint_index in 0..3 {
        for delta in [-1_i64, 1] {
            let mut launch = super::super::super::support::launch_attempt();
            let endpoint = &mut launch.protected_endpoints[endpoint_index];
            endpoint.max_frame_bytes = endpoint
                .max_frame_bytes
                .checked_add_signed(delta)
                .expect("positive cap");
            assert!(matches!(
                receive_launch(launch),
                Err(ManagementChannelError::InvalidManagementPayload {
                    payload: "LaunchAttemptProcess",
                    field: "protected_endpoints",
                })
            ));
        }
    }
}

#[test]
fn endpoint_connection_ids_are_required_and_unique() {
    let mut missing = super::super::super::support::launch_attempt();
    missing.protected_endpoints[0].connection_id.clear();
    assert_invalid_endpoints(missing, "endpoint_connection_id");

    let mut duplicate = super::super::super::support::launch_attempt();
    duplicate.protected_endpoints[1].connection_id =
        duplicate.protected_endpoints[0].connection_id.clone();
    assert_invalid_endpoints(duplicate, "protected_endpoints");
}

#[test]
fn endpoint_connection_tokens_share_the_handshake_hard_bound() {
    let mut maximum = super::super::super::support::launch_attempt();
    maximum.protected_endpoints[0].connection_token = vec![7; 512];
    assert!(matches!(
        receive_launch(maximum),
        Ok(Some(ManagementReceiveOutcome::Pending(_)))
    ));

    let mut oversized = super::super::super::support::launch_attempt();
    oversized.protected_endpoints[0].connection_token = vec![7; 513];
    assert_invalid_endpoints(oversized, "protected_endpoints");
}

fn assert_invalid_endpoints(launch: wire::LaunchAttemptProcess, expected_field: &'static str) {
    assert!(matches!(
        receive_launch(launch),
        Err(ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field,
        }) if field == expected_field
    ));
}
