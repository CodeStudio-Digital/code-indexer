use std::env;
use std::ffi::OsString;
use std::time::Duration;

use crate::containment::{
    ChildHandleAllowlist, ChildHandleAllowlistError, ContainedLaunch, ContainmentPort,
    ResourceGroupId,
};

use super::super::{WindowsContainment, sys};
use super::budget;

#[test]
fn unrelated_inheritable_handle_is_not_inherited_by_runner() {
    let adapter = WindowsContainment::new();
    let sentinel = sys::create_inheritable_event().expect("inheritable sentinel");
    let launch = child_test_launch(
        "child_probe_cannot_signal_nonallowlisted_handle",
        &[(
            "AGENT_PLATFORM_SENTINEL_HANDLE",
            sys::raw_handle_value(&sentinel),
        )],
    );
    let spawned = adapter
        .spawn_runner_contained(ResourceGroupId("sentinel".into()), &budget(), &launch)
        .expect("contained child test");

    assert_child_success(&spawned.group.root_process);
    assert_eq!(
        sys::wait_process(&sentinel, 0).expect("sentinel wait"),
        sys::WaitState::TimedOut
    );
    adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap child test");
}

#[test]
fn handle_list_inherits_only_dedicated_duplicate() {
    let adapter = WindowsContainment::new();
    let allowed = sys::create_noninheritable_event().expect("allowed source");
    let unrelated = sys::create_inheritable_event().expect("unrelated source");
    let mut allowlist = ChildHandleAllowlist::new();
    allowlist
        .prepare_windows(&allowed)
        .expect("prepare dedicated duplicate");
    let inherited = allowlist.windows_raw_values()[0];
    let launch = child_test_launch(
        "child_probe_signals_only_allowlisted_handle",
        &[
            ("AGENT_PLATFORM_ALLOWED_HANDLE", inherited),
            (
                "AGENT_PLATFORM_UNRELATED_HANDLE",
                sys::raw_handle_value(&unrelated),
            ),
        ],
    );

    let spawned = adapter
        .spawn_runner_contained_with_handles(
            ResourceGroupId("handle-list".into()),
            &budget(),
            &launch,
            allowlist,
        )
        .expect("contained child with exact handle list");

    assert_child_success(&spawned.group.root_process);
    assert_eq!(
        sys::wait_process(&allowed, 0).expect("allowed event wait"),
        sys::WaitState::Signaled
    );
    assert_eq!(
        sys::wait_process(&unrelated, 0).expect("unrelated event wait"),
        sys::WaitState::TimedOut
    );
    assert!(!sys::is_handle_inheritable(&allowed).expect("allowed source flags"));
    assert!(sys::is_handle_inheritable(&unrelated).expect("unrelated source flags"));
    adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap child test");
}

#[test]
fn allowlist_rejects_duplicates_and_capacity_overflow() {
    let sources = (0..9)
        .map(|_| sys::create_noninheritable_event().expect("event"))
        .collect::<Vec<_>>();
    let mut allowlist = ChildHandleAllowlist::new();
    allowlist
        .prepare_windows(&sources[0])
        .expect("first handle");
    assert!(matches!(
        allowlist.prepare_windows(&sources[0]),
        Err(ChildHandleAllowlistError::Duplicate)
    ));
    for source in &sources[1..8] {
        allowlist.prepare_windows(source).expect("within capacity");
    }
    assert!(matches!(
        allowlist.prepare_windows(&sources[8]),
        Err(ChildHandleAllowlistError::CapacityExceeded)
    ));
}

#[test]
#[ignore = "executed only as the contained non-allowlisted child"]
fn child_probe_cannot_signal_nonallowlisted_handle() {
    assert!(sys::signal_raw_handle(env_handle("AGENT_PLATFORM_SENTINEL_HANDLE")).is_err());
}

#[test]
#[ignore = "executed only as the contained allowlist child"]
fn child_probe_signals_only_allowlisted_handle() {
    sys::signal_raw_handle(env_handle("AGENT_PLATFORM_ALLOWED_HANDLE"))
        .expect("allowlisted handle is inherited");
    assert!(sys::signal_raw_handle(env_handle("AGENT_PLATFORM_UNRELATED_HANDLE")).is_err());
}

fn child_test_launch(test: &str, handles: &[(&str, usize)]) -> ContainedLaunch {
    let system_root = env::var_os("SystemRoot").expect("Windows has SystemRoot");
    let mut environment = handles
        .iter()
        .map(|(name, value)| (OsString::from(name), OsString::from(value.to_string())))
        .collect::<Vec<_>>();
    environment.extend([
        (OsString::from("SystemRoot"), system_root.clone()),
        (OsString::from("WINDIR"), system_root),
    ]);
    ContainedLaunch {
        executable: env::current_exe().expect("current test executable"),
        arguments: vec![
            OsString::from("--ignored"),
            OsString::from("--exact"),
            OsString::from(format!("windows::tests::inheritance::{test}")),
        ],
        working_directory: env::temp_dir(),
        environment,
    }
}

fn env_handle(name: &str) -> usize {
    env::var(name)
        .expect("handle value")
        .parse()
        .expect("numeric handle value")
}

fn assert_child_success(process: &std::os::windows::io::OwnedHandle) {
    assert_eq!(
        sys::wait_process(process, 2_000).expect("bounded process wait"),
        sys::WaitState::Signaled
    );
    assert_eq!(sys::exit_code(process).expect("child exit"), 0);
}
