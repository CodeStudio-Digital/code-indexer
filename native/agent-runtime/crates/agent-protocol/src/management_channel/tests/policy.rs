use std::io::Cursor;

use super::support::{
    MANAGEMENT_TOKEN, NOW, RecordingWriter, SUPERVISOR_NONCE, connection, delimited, frame,
    hard_cap_u32, host_channel, host_hello, limits, supervisor_hello,
};
use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use crate::generated::v1 as wire;
use crate::management_channel::{
    BootstrapManagementChannel, ManagementChannelError, ManagementDirection,
};

fn host_bootstrap(
    supervisor: wire::SupervisorHello,
) -> BootstrapManagementChannel<Cursor<Vec<u8>>, RecordingWriter> {
    let inbound = frame(
        wire::management_payload::Body::SupervisorHello(supervisor),
        "supervisor-bootstrap",
        1,
    );
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    BootstrapManagementChannel::new(
        DelimitedFrameChannel::new(
            codec,
            Cursor::new(delimited(&[inbound])),
            RecordingWriter::default(),
        ),
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
        ManagementDirection::SupervisorToHost,
    )
    .expect("bootstrap")
}

#[test]
fn host_policy_rejects_decorative_or_unbounded_fields_before_write() {
    let mutations: [fn(&mut wire::HostSupervisorHello); 6] = [
        |hello| hello.contract_version.clear(),
        |hello| hello.management_session_token.clear(),
        |hello| hello.management_session_token = vec![7; 32],
        |hello| hello.limits.as_mut().expect("limits").max_active_attempts = 0,
        |hello| {
            hello
                .frame_limits
                .as_mut()
                .expect("frame limits")
                .max_in_flight_bytes = u64::MAX;
        },
        |hello| {
            hello
                .frame_limits
                .as_mut()
                .expect("frame limits")
                .transport_crc32c = true;
        },
    ];

    for mutate in mutations {
        let mut hello = host_hello();
        mutate(&mut hello);
        let mut channel = host_bootstrap(supervisor_hello());
        assert!(channel.send_host_hello_with_clock(&hello, || NOW).is_err());
        assert!(channel.is_poisoned());
    }
}

#[test]
fn supervisor_contract_provenance_nonce_and_containment_are_bound_to_host_policy() {
    let mut contract = supervisor_hello();
    contract.contract_schema_version += 1;
    let mut provenance = supervisor_hello();
    provenance.provenance.as_mut().expect("provenance").build_id = "foreign-build".into();
    let mut nonce = supervisor_hello();
    nonce.launch_nonce = vec![7; 32];
    let mut feature_host = host_hello();
    feature_host.allowed_feature_bits = 0b10;

    let cases = [
        (
            contract,
            host_hello(),
            ManagementChannelError::SupervisorContractMismatch,
        ),
        (
            provenance,
            host_hello(),
            ManagementChannelError::SupervisorProvenanceMismatch,
        ),
        (
            nonce,
            host_hello(),
            ManagementChannelError::SupervisorNonceMismatch,
        ),
        (
            supervisor_hello(),
            feature_host,
            ManagementChannelError::InvalidFeatureNegotiation,
        ),
    ];
    for (supervisor, host, expected) in cases {
        let mut channel = host_bootstrap(supervisor);
        channel
            .send_host_hello_with_clock(&host, || NOW)
            .expect("host selection");
        let actual = channel
            .receive_with_clock(|| NOW + 1)
            .expect_err("mismatch");
        assert_eq!(
            std::mem::discriminant(&actual),
            std::mem::discriminant(&expected)
        );
        assert!(channel.is_poisoned());
    }

    let mut hard_host = host_hello();
    hard_host.required_containment_level = wire::ContainmentLevel::HardAggregate as i32;
    let mut channel = host_bootstrap(supervisor_hello());
    channel
        .send_host_hello_with_clock(&hard_host, || NOW)
        .expect("hard selection");
    assert!(matches!(
        channel.receive_with_clock(|| NOW + 1),
        Err(ManagementChannelError::InsufficientContainment)
    ));

    hard_host.required_containment_level = wire::ContainmentLevel::HardProcess as i32;
    let mut channel = host_bootstrap(supervisor_hello());
    channel
        .send_host_hello_with_clock(&hard_host, || NOW)
        .expect("hard process selection");
    assert!(matches!(
        channel.receive_with_clock(|| NOW + 1),
        Err(ManagementChannelError::InsufficientContainment)
    ));
}

#[test]
fn replay_limits_have_a_hard_memory_ceiling() {
    assert!(matches!(
        super::super::ManagementReplayLimits::new(
            1,
            1,
            super::super::MAX_MANAGEMENT_REPLAY_BYTES + 1
        ),
        Err(ManagementChannelError::InvalidReplayLimits)
    ));
}

#[test]
fn immutable_host_policy_survives_same_stream_handoff_without_raw_token() {
    let channel = host_channel(Vec::new(), RecordingWriter::default(), limits());
    let policy = channel.policy();
    let candidate = wire::RuntimeProvenance {
        build_id: "supervisor-build".into(),
        source_commit: "source-commit".into(),
        binary_sha256: vec![1; 32],
        runtime_instance_id: "runner:one".into(),
        pid: 7,
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    };

    assert_eq!(policy.contract_version(), "contract:test-v1");
    assert_eq!(policy.contract_schema_version(), 1);
    assert_eq!(policy.limits().max_active_attempts, 8);
    assert_eq!(policy.frame_limits().write_timeout_ms, 10_000);
    assert_eq!(
        policy.required_containment_level(),
        wire::ContainmentLevel::Monitored
    );
    assert_eq!(policy.effective_feature_bits(), 0);
    assert!(policy.authenticates_management_session_token(&MANAGEMENT_TOKEN));
    assert!(!policy.authenticates_management_session_token(&[7; 32]));
    assert!(policy.permits_runner_provenance(&candidate));
}

#[test]
fn bootstrap_transport_and_policy_debug_never_render_token_or_nonce_bytes() {
    let token = b"management-token-never-debug".to_vec();
    let nonce = b"supervisor-nonce-never-debug".to_vec();
    let mut host = host_hello();
    host.management_session_token = token.clone();
    let mut supervisor = supervisor_hello();
    supervisor.launch_nonce = nonce.clone();
    let inbound = frame(
        wire::management_payload::Body::SupervisorHello(supervisor),
        "supervisor-bootstrap",
        1,
    );
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let mut channel = BootstrapManagementChannel::new(
        DelimitedFrameChannel::new(
            codec,
            Cursor::new(delimited(&[inbound])),
            RecordingWriter::default(),
        ),
        connection(),
        nonce,
        token,
        ManagementDirection::SupervisorToHost,
    )
    .expect("bootstrap");

    let before = format!("{channel:?}");
    assert!(!before.contains("management-token-never-debug"));
    assert!(!before.contains("supervisor-nonce-never-debug"));
    channel
        .send_host_hello_with_clock(&host, || NOW)
        .expect("host hello");
    channel
        .receive_with_clock(|| NOW + 1)
        .expect("supervisor hello");

    let after = format!("{channel:?}");
    let policy = format!("{:?}", channel.policy().expect("policy"));
    assert!(!after.contains("management-token-never-debug"));
    assert!(!after.contains("supervisor-nonce-never-debug"));
    assert!(!policy.contains("management-token-never-debug"));
    assert!(policy.contains("[REDACTED]"));
}
