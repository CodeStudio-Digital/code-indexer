use super::*;

#[test]
fn launch_requires_a_complete_activation_authority_seal() {
    assert_invalid(|launch| launch.activation_authority_seal = None);
    assert_invalid(|launch| {
        launch
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .agent_run_version = 0;
    });
    assert_invalid(|launch| {
        launch
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .attempt_version = 0;
    });
    assert_invalid(|launch| {
        launch
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .activation_nonce_sha256
            .truncate(31);
    });
}

fn assert_invalid(update: impl FnOnce(&mut wire::LaunchAttemptProcess)) {
    let mut launch = super::super::super::support::launch_attempt();
    update(&mut launch);
    let mut channel = super::super::super::support::supervisor_channel(
        vec![frame(
            wire::management_payload::Body::LaunchAttemptProcess(launch),
            "activation-authority-gate",
            2,
        )],
        RecordingWriter::default(),
        limits(),
    );

    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field: "activation_authority_seal",
        })
    ));
    assert!(channel.is_poisoned());
}
