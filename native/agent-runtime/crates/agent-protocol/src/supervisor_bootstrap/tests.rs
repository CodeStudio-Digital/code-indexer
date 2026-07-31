use std::io::Cursor;

use crate::framing::DelimitedFrameCodec;
use crate::generated::v1 as wire;

use super::{
    SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION, SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES,
    SUPERVISOR_PROCESS_READY_MAX_BYTES, SupervisorBootstrapError,
    SupervisorPhysicalBootstrapReceiver, SupervisorPhysicalBootstrapSender,
};

const HOST_PID: u32 = 41;
const SUPERVISOR_PID: u32 = 42;

#[test]
fn exact_handoff_retains_secrets_until_taken_and_commits_ready() {
    let encoded = encoded_handoff(&handoff());
    let received = SupervisorPhysicalBootstrapReceiver::new(Cursor::new(encoded), Vec::<u8>::new())
        .receive(HOST_PID, SUPERVISOR_PID)
        .expect("validated process handoff");
    let (mut handoff, ready) = received.into_parts();
    let debug = format!("{handoff:?}");
    assert!(!debug.contains("81, 81"));
    assert!(!debug.contains("114, 114"));
    assert_eq!(handoff.connection_id().as_str(), "management:test");
    assert_eq!(handoff.take_management_session_token(), vec![0x51; 32]);
    assert_eq!(handoff.take_supervisor_launch_nonce(), vec![0x72; 32]);
    let expected_ready = handoff.ready();
    ready.send(&expected_ready).expect("send Ready");
}

#[test]
fn physical_creator_and_trailing_bytes_are_fail_closed() {
    let encoded = encoded_handoff(&handoff());
    assert!(matches!(
        SupervisorPhysicalBootstrapReceiver::new(Cursor::new(encoded.clone()), Vec::<u8>::new(),)
            .receive(HOST_PID + 1, SUPERVISOR_PID),
        Err(SupervisorBootstrapError::InvalidField("host_process_id"))
    ));

    let mut trailing = encoded;
    trailing.push(0xa5);
    assert!(matches!(
        SupervisorPhysicalBootstrapReceiver::new(Cursor::new(trailing), Vec::<u8>::new())
            .receive(HOST_PID, SUPERVISOR_PID),
        Err(SupervisorBootstrapError::TrailingBytes)
    ));
}

#[test]
fn invalid_secret_and_supervisor_pid_never_produce_authority() {
    let mut short_token = handoff();
    short_token.management_session_token.truncate(15);
    assert_invalid(&short_token, "management_session_token");

    let mut wrong_pid = handoff();
    wrong_pid
        .supervisor_provenance
        .as_mut()
        .expect("provenance")
        .pid = SUPERVISOR_PID + 1;
    assert_invalid(&wrong_pid, "supervisor_provenance");
}

#[test]
fn ready_frame_is_bounded_and_exact() {
    let encoded = encoded_handoff(&handoff());
    let received = SupervisorPhysicalBootstrapReceiver::new(Cursor::new(encoded), Vec::<u8>::new())
        .receive(HOST_PID, SUPERVISOR_PID)
        .expect("handoff");
    let (handoff, _ready) = received.into_parts();
    let expected = handoff.ready();
    let mut output = Vec::new();
    codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
        .write(&mut output, &expected)
        .expect("Ready");
    let actual: wire::SupervisorProcessReady = codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
        .read(&mut Cursor::new(output))
        .expect("Ready frame")
        .expect("Ready message");
    assert_eq!(actual, expected);
}

#[test]
fn host_sender_closes_handoff_and_accepts_only_exact_ready() {
    let expected = ready();
    let mut encoded_ready = Vec::new();
    codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
        .write(&mut encoded_ready, &expected)
        .expect("encode Ready");
    let actual =
        SupervisorPhysicalBootstrapSender::new(Cursor::new(encoded_ready), Vec::<u8>::new())
            .send(&handoff())
            .expect("send handoff")
            .receive_ready(
                SUPERVISOR_PID,
                "management:test",
                r"\\.\pipe\codestudio-agent-v1-test",
            )
            .expect("receive exact Ready");
    assert_eq!(actual, expected);
}

#[test]
fn host_sender_rejects_ready_identity_or_trailing_bytes() {
    let mut wrong_pid = ready();
    wrong_pid.supervisor_process_id += 1;
    assert_ready_error(&wrong_pid, false, "ready.supervisor_process_id");
    assert!(matches!(
        ready_result(&ready(), true),
        Err(SupervisorBootstrapError::TrailingBytes)
    ));
}

fn assert_invalid(value: &wire::SupervisorProcessHandoff, field: &'static str) {
    let result = SupervisorPhysicalBootstrapReceiver::new(
        Cursor::new(encoded_handoff(value)),
        Vec::<u8>::new(),
    )
    .receive(HOST_PID, SUPERVISOR_PID);
    assert!(matches!(
        result,
        Err(SupervisorBootstrapError::InvalidField(actual)) if actual == field
    ));
}

fn encoded_handoff(value: &wire::SupervisorProcessHandoff) -> Vec<u8> {
    let mut encoded = Vec::new();
    codec(SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES)
        .write(&mut encoded, value)
        .expect("encode handoff");
    encoded
}

fn handoff() -> wire::SupervisorProcessHandoff {
    wire::SupervisorProcessHandoff {
        schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        host_process_id: HOST_PID,
        management_connection_id: "management:test".into(),
        management_endpoint_address: r"\\.\pipe\codestudio-agent-v1-test".into(),
        management_session_token: vec![0x51; 32],
        supervisor_launch_nonce: vec![0x72; 32],
        supervisor_provenance: Some(wire::RuntimeProvenance {
            build_id: "supervisor-build".into(),
            source_commit: "supervisor-commit".into(),
            binary_sha256: vec![0x31; 32],
            runtime_instance_id: "supervisor:runtime".into(),
            pid: SUPERVISOR_PID,
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
            maximum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        }),
        containment: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            ..wire::ContainmentCapabilities::default()
        }),
        supported_feature_bits: 0,
        runner_executable: r"C:\runtime\agent-runner.exe".into(),
        runner_working_directory: r"C:\runtime".into(),
        runner_environment: Vec::new(),
        trusted_runner_provenance: Some(wire::ExpectedRuntimeProvenance {
            build_id: "runner-build".into(),
            source_commit: "runner-commit".into(),
            binary_sha256: vec![0x52; 32],
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
    }
}

fn ready() -> wire::SupervisorProcessReady {
    wire::SupervisorProcessReady {
        schema_version: SUPERVISOR_BOOTSTRAP_SCHEMA_VERSION,
        supervisor_process_id: SUPERVISOR_PID,
        management_connection_id: "management:test".into(),
        management_endpoint_address: r"\\.\pipe\codestudio-agent-v1-test".into(),
    }
}

fn assert_ready_error(ready: &wire::SupervisorProcessReady, trailing: bool, field: &'static str) {
    assert!(matches!(
        ready_result(ready, trailing),
        Err(SupervisorBootstrapError::InvalidField(actual)) if actual == field
    ));
}

fn ready_result(
    ready: &wire::SupervisorProcessReady,
    trailing: bool,
) -> Result<wire::SupervisorProcessReady, SupervisorBootstrapError> {
    let mut encoded = Vec::new();
    codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
        .write(&mut encoded, ready)
        .expect("encode Ready");
    if trailing {
        encoded.push(0xa5);
    }
    SupervisorPhysicalBootstrapSender::new(Cursor::new(encoded), Vec::<u8>::new())
        .send(&handoff())
        .expect("send handoff")
        .receive_ready(
            SUPERVISOR_PID,
            "management:test",
            r"\\.\pipe\codestudio-agent-v1-test",
        )
}

fn codec(maximum: usize) -> DelimitedFrameCodec {
    DelimitedFrameCodec::new(u32::try_from(maximum).expect("cap fits")).expect("non-zero cap")
}
