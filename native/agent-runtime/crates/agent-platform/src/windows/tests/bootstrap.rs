use std::env;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::mem::size_of;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::containment::{
    ChildHandleAllowlist, ChildHandleAllowlistError, ContainedLaunch, ContainmentPort,
    ResourceGroupId,
};
use crate::ipc::endpoint_cancellation;

use super::super::bootstrap::{
    WindowsBootstrapIoError, WindowsBootstrapIoFailure, open_inherited_windows_bootstrap,
    prepare_production_windows_bootstrap, prepare_windows_bootstrap,
};
use super::super::{WindowsContainment, sys};
use super::budget;

const REQUEST: &[u8] = b"agent-platform-bootstrap-request-v1";
const RESPONSE: &[u8] = b"agent-platform-bootstrap-ready-v1";
const PRODUCTION_REQUEST: &[u8] = b"agent-platform-private-bootstrap-request-v1";
const PRODUCTION_RESPONSE: &[u8] = b"agent-platform-private-bootstrap-ready-v1";

#[test]
fn bootstrap_stdio_is_atomic_and_counts_toward_allowlist_capacity() {
    let first = prepare_windows_bootstrap().expect("first bootstrap");
    let (_first_parent, first_stdio) = first.into_parts();
    let second = prepare_windows_bootstrap().expect("second bootstrap");
    let (_second_parent, second_stdio) = second.into_parts();
    let mut allowlist = ChildHandleAllowlist::new();

    allowlist
        .install_windows_bootstrap(first_stdio)
        .expect("install first complete stdio set");
    assert_eq!(allowlist.len(), 3);
    assert!(matches!(
        allowlist.install_windows_bootstrap(second_stdio),
        Err(ChildHandleAllowlistError::Duplicate)
    ));
    assert_eq!(allowlist.len(), 3);

    let extras = (0..6)
        .map(|_| sys::create_noninheritable_event().expect("extra source"))
        .collect::<Vec<_>>();
    for source in &extras[..5] {
        allowlist
            .prepare_windows(source)
            .expect("bootstrap plus five handles fits exact cap");
    }
    assert_eq!(allowlist.len(), 8);
    assert!(matches!(
        allowlist.prepare_windows(&extras[5]),
        Err(ChildHandleAllowlistError::CapacityExceeded)
    ));
}

#[test]
fn bootstrap_uses_only_allowlisted_stdio_and_waits_for_parent_input() {
    let prepared = prepare_windows_bootstrap().expect("prepare bootstrap pipes");
    let (parent, child_stdio) = prepared.into_parts();
    let (mut response_reader, mut request_writer) = parent.into_parts();
    let unrelated = sys::create_inheritable_event().expect("unrelated inheritable event");
    let unrelated_value = sys::raw_handle_value(&unrelated);
    let mut forbidden_values = child_stdio.raw_values().to_vec();
    forbidden_values.push(unrelated_value);

    let launch = child_test_launch();
    assert_launch_does_not_serialize_handles(&launch, &forbidden_values);

    let mut allowlist = ChildHandleAllowlist::new();
    allowlist
        .install_windows_bootstrap(child_stdio)
        .expect("install complete bootstrap stdio set");
    assert_eq!(allowlist.len(), 3);
    let adapter = WindowsContainment::new();
    let spawned = adapter
        .spawn_runner_contained_with_handles(
            ResourceGroupId("bootstrap-stdio".into()),
            &budget(),
            &launch,
            allowlist,
        )
        .expect("spawn contained bootstrap child");

    let mut observed = Vec::new();
    let no_response_deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < no_response_deadline {
        drain_available(&mut response_reader, &mut observed);
        assert!(!contains(&observed, RESPONSE));
        assert_eq!(
            sys::wait_process(&spawned.group.root_process, 0).expect("child liveness"),
            sys::WaitState::TimedOut,
            "child exited before receiving bootstrap bytes"
        );
        thread::sleep(Duration::from_millis(5));
    }

    request_writer
        .write_all(&std::process::id().to_le_bytes())
        .expect("write expected creator PID through stdin");
    request_writer
        .write_all(&unrelated_value.to_le_bytes())
        .expect("write sentinel value through stdin");
    request_writer
        .write_all(REQUEST)
        .expect("write bootstrap request through stdin");
    request_writer.flush().expect("flush bootstrap request");

    let response_deadline = Instant::now() + Duration::from_secs(2);
    while !contains(&observed, RESPONSE) && Instant::now() < response_deadline {
        drain_available(&mut response_reader, &mut observed);
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        contains(&observed, RESPONSE),
        "child did not answer through stdout; observed {:?}",
        String::from_utf8_lossy(&observed)
    );
    assert_eq!(
        sys::wait_process(&unrelated, 0).expect("unrelated sentinel wait"),
        sys::WaitState::TimedOut,
        "an unrelated inheritable handle escaped HANDLE_LIST"
    );
    let (eof_sender, eof_receiver) = mpsc::sync_channel(1);
    let eof_thread = thread::spawn(move || {
        let mut byte = [0_u8; 1];
        let result = response_reader.read(&mut byte);
        let _ = eof_sender.send(result);
    });
    let eof = eof_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("child stdout did not close after Ready")
        .expect("read child stdout EOF");
    assert_eq!(eof, 0, "expected EOF after child dropped stdout");
    assert_eq!(
        sys::wait_process(&spawned.group.root_process, 0).expect("child liveness after stdout EOF"),
        sys::WaitState::TimedOut,
        "child must remain alive after independently closing stdout"
    );
    drop(request_writer);
    eof_thread.join().expect("join bounded EOF reader");
    assert_eq!(
        sys::wait_process(&spawned.group.root_process, 2_000).expect("bounded child wait"),
        sys::WaitState::Signaled
    );
    assert_eq!(
        sys::exit_code(&spawned.group.root_process).expect("child exit"),
        0
    );
    adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap bootstrap child");
}

#[test]
fn production_bootstrap_is_private_overlapped_and_exactly_inherited() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    assert!(
        !format!("{prepared:?}").contains(r"\\.\pipe"),
        "ephemeral names must not be exposed through Debug"
    );
    let (parent, child_stdio) = prepared.into_parts();
    let (response_reader, request_writer) = parent.into_parts();
    let unrelated = sys::create_inheritable_event().expect("unrelated inheritable event");
    let unrelated_value = sys::raw_handle_value(&unrelated);
    let mut forbidden_values = child_stdio.raw_values().to_vec();
    forbidden_values.push(unrelated_value);

    let launch = production_child_test_launch();
    assert_launch_does_not_serialize_handles(&launch, &forbidden_values);
    let mut allowlist = ChildHandleAllowlist::new();
    allowlist
        .install_windows_bootstrap(child_stdio)
        .expect("install private synchronous child handles");
    assert_eq!(allowlist.len(), 3);

    let adapter = WindowsContainment::new();
    let spawned = adapter
        .spawn_runner_contained_with_handles(
            ResourceGroupId("bootstrap-private".into()),
            &budget(),
            &launch,
            allowlist,
        )
        .expect("spawn private-bootstrap child");
    let (_cancel_handle, cancellation) = endpoint_cancellation();
    let mut request = Vec::new();
    request.extend_from_slice(&std::process::id().to_le_bytes());
    request.extend_from_slice(&unrelated_value.to_le_bytes());
    request.extend_from_slice(PRODUCTION_REQUEST);
    let write = request_writer
        .start_write(request.into_boxed_slice())
        .expect("submit overlapped handoff");
    let written = write
        .wait_until(Instant::now() + Duration::from_secs(2), &cancellation)
        .expect("complete overlapped handoff");
    let (request_writer, request_buffer, transferred) = written.into_parts();
    assert_eq!(transferred, request_buffer.bytes().len());
    drop(request_buffer);
    drop(request_writer);

    let ready_deadline = Instant::now() + Duration::from_secs(2);
    let mut response_reader = response_reader;
    let mut observed = Vec::new();
    while !contains(&observed, PRODUCTION_RESPONSE) {
        let ready = response_reader
            .start_read(256)
            .expect("submit overlapped Ready read")
            .wait_until(ready_deadline, &cancellation)
            .expect("complete overlapped Ready read");
        observed.extend_from_slice(ready.bytes());
        let (next_reader, ready_buffer, _) = ready.into_parts();
        response_reader = next_reader;
        drop(ready_buffer);
    }
    let eof = response_reader
        .start_read(1)
        .expect("submit overlapped EOF read")
        .wait_until(Instant::now() + Duration::from_secs(2), &cancellation)
        .expect("observe child response EOF");
    assert!(eof.bytes().is_empty());
    assert_eq!(
        sys::wait_process(&unrelated, 0).expect("unrelated sentinel wait"),
        sys::WaitState::TimedOut,
        "an unrelated inheritable handle escaped HANDLE_LIST"
    );
    assert_eq!(
        sys::wait_process(&spawned.group.root_process, 2_000).expect("bounded child wait"),
        sys::WaitState::Signaled
    );
    assert_eq!(
        sys::exit_code(&spawned.group.root_process).expect("child exit"),
        0
    );
    adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap private-bootstrap child");
}

#[test]
fn production_bootstrap_timeout_returns_reaper_owned_io() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    let (parent, child_stdio) = prepared.into_parts();
    let (response_reader, _request_writer) = parent.into_parts();
    let (_cancel_handle, cancellation) = endpoint_cancellation();
    let pending = response_reader
        .start_read(128)
        .expect("submit blocked Ready read");
    let failure = pending
        .wait_until(Instant::now() + Duration::from_millis(20), &cancellation)
        .expect_err("missing Ready must time out");
    assert!(matches!(
        failure.error(),
        WindowsBootstrapIoError::DeadlineElapsed
    ));
    let cleanup = match failure {
        WindowsBootstrapIoFailure::Owned { owner, .. } => owner,
        WindowsBootstrapIoFailure::Clean { .. } => {
            panic!("timeout cannot discard pending OVERLAPPED ownership")
        }
    };
    reap_bootstrap_cleanup(cleanup);
    drop(child_stdio);
}

#[test]
fn production_bootstrap_cancellation_returns_reaper_owned_io() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    let (parent, child_stdio) = prepared.into_parts();
    let (response_reader, _request_writer) = parent.into_parts();
    let (cancel_handle, cancellation) = endpoint_cancellation();
    let pending = response_reader
        .start_read(128)
        .expect("submit blocked Ready read");
    cancel_handle.cancel();
    let failure = pending
        .wait_until(Instant::now() + Duration::from_secs(1), &cancellation)
        .expect_err("cancelled Ready must fail closed");
    assert!(matches!(
        failure.error(),
        WindowsBootstrapIoError::Cancelled
    ));
    let cleanup = match failure {
        WindowsBootstrapIoFailure::Owned { owner, .. } => owner,
        WindowsBootstrapIoFailure::Clean { .. } => {
            panic!("cancellation cannot discard pending OVERLAPPED ownership")
        }
    };
    reap_bootstrap_cleanup(cleanup);
    drop(child_stdio);
}

#[test]
fn production_bootstrap_write_timeout_returns_reaper_owned_io() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    let (parent, child_stdio) = prepared.into_parts();
    let (_response_reader, request_writer) = parent.into_parts();
    let (_cancel_handle, cancellation) = endpoint_cancellation();
    let pending = request_writer
        .start_write(vec![0xA5; 1024 * 1024].into_boxed_slice())
        .expect("submit blocked handoff write");
    let failure = pending
        .wait_until(Instant::now() + Duration::from_millis(20), &cancellation)
        .expect_err("unconsumed oversized handoff must time out");
    assert!(matches!(
        failure.error(),
        WindowsBootstrapIoError::DeadlineElapsed
    ));
    let cleanup = match failure {
        WindowsBootstrapIoFailure::Owned { owner, .. } => owner,
        WindowsBootstrapIoFailure::Clean { .. } => {
            panic!("write timeout cannot discard pending OVERLAPPED ownership")
        }
    };
    reap_bootstrap_cleanup(cleanup);
    drop(child_stdio);
}

#[test]
fn production_bootstrap_write_cancellation_returns_reaper_owned_io() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    let (parent, child_stdio) = prepared.into_parts();
    let (_response_reader, request_writer) = parent.into_parts();
    let (cancel_handle, cancellation) = endpoint_cancellation();
    let pending = request_writer
        .start_write(vec![0x5A; 1024 * 1024].into_boxed_slice())
        .expect("submit blocked handoff write");
    cancel_handle.cancel();
    let failure = pending
        .wait_until(Instant::now() + Duration::from_secs(1), &cancellation)
        .expect_err("cancelled handoff write must fail closed");
    assert!(matches!(
        failure.error(),
        WindowsBootstrapIoError::Cancelled
    ));
    let cleanup = match failure {
        WindowsBootstrapIoFailure::Owned { owner, .. } => owner,
        WindowsBootstrapIoFailure::Clean { .. } => {
            panic!("write cancellation cannot discard pending OVERLAPPED ownership")
        }
    };
    reap_bootstrap_cleanup(cleanup);
    drop(child_stdio);
}

#[test]
fn dropping_pending_bootstrap_io_is_process_bounded() {
    let mut child = Command::new(env::current_exe().expect("current test executable"))
        .args([
            "--ignored",
            "--exact",
            "windows::tests::bootstrap::child_drops_pending_bootstrap_io",
            "--test-threads=1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn pending-I/O drop child");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if child
            .try_wait()
            .expect("poll pending-I/O drop child")
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            child
                .kill()
                .expect("terminate wedged pending-I/O drop child");
            child.wait().expect("reap wedged pending-I/O drop child");
            panic!("dropping pending bootstrap I/O blocked the process");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "executed only to prove pending-I/O Drop is process-bounded"]
fn child_drops_pending_bootstrap_io() {
    let prepared =
        prepare_production_windows_bootstrap().expect("prepare private production bootstrap");
    let (parent, _child_stdio) = prepared.into_parts();
    let (_response_reader, request_writer) = parent.into_parts();
    let pending = request_writer
        .start_write(vec![0xC3; 1024 * 1024].into_boxed_slice())
        .expect("submit blocked handoff write");
    drop(pending);
}

#[test]
#[ignore = "executed only as the contained bootstrap child"]
fn child_reads_stdin_before_writing_stdout() {
    assert!(
        env::args_os().all(|argument| !contains_handle_label(&argument)),
        "argv must not contain a handle field"
    );
    assert!(
        env::vars_os().all(|(name, _)| !contains_handle_label(&name)),
        "env must not contain a handle field"
    );

    let child = open_inherited_windows_bootstrap().expect("take inherited stdio bootstrap");
    let creator_process_id = child.creator_process_id();
    let (mut request_reader, mut response_writer) = child.into_parts();
    let mut encoded_creator = [0_u8; size_of::<u32>()];
    request_reader
        .read_exact(&mut encoded_creator)
        .expect("read expected creator PID");
    assert_eq!(creator_process_id, u32::from_le_bytes(encoded_creator));
    let mut encoded_handle = [0_u8; size_of::<usize>()];
    request_reader
        .read_exact(&mut encoded_handle)
        .expect("read test sentinel value");
    let unrelated_value = usize::from_le_bytes(encoded_handle);
    let mut request = vec![0_u8; REQUEST.len()];
    request_reader
        .read_exact(&mut request)
        .expect("read bootstrap request");
    assert_eq!(request, REQUEST);
    assert!(
        sys::signal_raw_handle(unrelated_value).is_err(),
        "unrelated inheritable handle was visible in the child"
    );
    response_writer
        .write_all(RESPONSE)
        .expect("write ready response through stdout");
    response_writer.flush().expect("flush ready response");
    drop(response_writer);

    let mut unexpected = [0_u8; 1];
    assert_eq!(
        request_reader
            .read(&mut unexpected)
            .expect("wait for parent request-half close"),
        0,
        "parent must close its write half before child exits"
    );
}

#[test]
#[ignore = "executed only as the contained production-bootstrap child"]
fn child_uses_private_synchronous_bootstrap() {
    assert!(
        env::args_os().all(|argument| !contains_handle_label(&argument)),
        "argv must not contain a handle field"
    );
    assert!(
        env::vars_os().all(|(name, _)| !contains_handle_label(&name)),
        "env must not contain a handle field"
    );
    let child = open_inherited_windows_bootstrap().expect("take private inherited bootstrap");
    let creator_process_id = child.creator_process_id();
    let (mut request_reader, mut response_writer) = child.into_parts();
    let mut request = vec![0_u8; size_of::<u32>() + size_of::<usize>() + PRODUCTION_REQUEST.len()];
    request_reader
        .read_exact(&mut request)
        .expect("read private handoff");
    let (creator, remaining) = request.split_at(size_of::<u32>());
    let (sentinel, payload) = remaining.split_at(size_of::<usize>());
    assert_eq!(
        creator_process_id,
        u32::from_le_bytes(creator.try_into().expect("creator PID bytes"))
    );
    let unrelated_value = usize::from_le_bytes(sentinel.try_into().expect("sentinel handle bytes"));
    assert_eq!(payload, PRODUCTION_REQUEST);
    assert!(
        sys::signal_raw_handle(unrelated_value).is_err(),
        "unrelated inheritable handle was visible in child"
    );
    response_writer
        .write_all(PRODUCTION_RESPONSE)
        .expect("write private Ready");
    response_writer.flush().expect("flush private Ready");
    drop(response_writer);
    let mut unexpected = [0_u8; 1];
    assert_eq!(
        request_reader
            .read(&mut unexpected)
            .expect("observe handoff EOF"),
        0
    );
}

fn child_test_launch() -> ContainedLaunch {
    let system_root = env::var_os("SystemRoot").expect("Windows has SystemRoot");
    ContainedLaunch {
        executable: env::current_exe().expect("current test executable"),
        arguments: vec![
            OsString::from("--ignored"),
            OsString::from("--exact"),
            OsString::from("windows::tests::bootstrap::child_reads_stdin_before_writing_stdout"),
            OsString::from("--test-threads=1"),
        ],
        working_directory: env::temp_dir(),
        environment: vec![
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
    }
}

fn production_child_test_launch() -> ContainedLaunch {
    let system_root = env::var_os("SystemRoot").expect("Windows has SystemRoot");
    ContainedLaunch {
        executable: env::current_exe().expect("current test executable"),
        arguments: vec![
            OsString::from("--ignored"),
            OsString::from("--exact"),
            OsString::from("windows::tests::bootstrap::child_uses_private_synchronous_bootstrap"),
            OsString::from("--test-threads=1"),
        ],
        working_directory: env::temp_dir(),
        environment: vec![
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
    }
}

fn assert_launch_does_not_serialize_handles(launch: &ContainedLaunch, handles: &[usize]) {
    assert!(
        launch
            .arguments
            .iter()
            .all(|argument| !contains_handle_label(argument))
    );
    assert!(
        launch
            .environment
            .iter()
            .all(|(name, _)| !contains_handle_label(name))
    );
    for handle in handles {
        let encoded = handle.to_string();
        assert!(
            launch
                .arguments
                .iter()
                .all(|argument| argument.to_string_lossy() != encoded),
            "argv serialized handle {encoded}"
        );
        assert!(
            launch.environment.iter().all(|(name, value)| {
                name.to_string_lossy() != encoded && value.to_string_lossy() != encoded
            }),
            "env serialized handle {encoded}"
        );
    }
}

fn contains_handle_label(value: &std::ffi::OsStr) -> bool {
    value
        .to_string_lossy()
        .to_ascii_uppercase()
        .contains("HANDLE")
}

fn drain_available(
    reader: &mut super::super::bootstrap::WindowsBootstrapReader,
    observed: &mut Vec<u8>,
) {
    let available = reader.bytes_available().expect("peek bootstrap stdout");
    if available == 0 {
        return;
    }
    let start = observed.len();
    observed.resize(start + available as usize, 0);
    reader
        .read_exact(&mut observed[start..])
        .expect("read available bootstrap stdout");
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|candidate| candidate == needle)
}

fn reap_bootstrap_cleanup(mut cleanup: super::super::bootstrap::WindowsBootstrapCleanup) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match cleanup.try_reap() {
            Ok(()) => return,
            Err(failure) if Instant::now() < deadline => {
                cleanup = failure.owner;
                thread::sleep(Duration::from_millis(1));
            }
            Err(failure) => panic!("bootstrap cleanup was not proven: {}", failure.error),
        }
    }
}
