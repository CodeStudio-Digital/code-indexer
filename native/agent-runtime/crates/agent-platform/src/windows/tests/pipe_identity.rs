use std::env;
use std::ffi::OsString;
use std::process;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::containment::{ChildHandleAllowlist, ContainedLaunch, ContainmentPort, ResourceGroupId};

use super::super::{WindowsContainment, sys};
use super::budget;

#[test]
fn inherited_named_pipe_keeps_the_creator_server_pid() {
    let adapter = WindowsContainment::new();
    let creator_pid = process::id();
    let address = format!(
        r"\\.\pipe\codestudio-agent-pid-probe-{creator_pid}-{}",
        monotonic_suffix()
    );
    let server = sys::create_test_pipe(&address).expect("raw test pipe");
    let mut allowlist = ChildHandleAllowlist::new();
    allowlist
        .prepare_windows(&server)
        .expect("dedicated pipe duplicate");
    let inherited = allowlist.windows_raw_values()[0];

    let spawned = adapter
        .spawn_runner_contained_with_handles(
            ResourceGroupId("pipe-creator-pid".into()),
            &budget(),
            &child_launch(inherited),
            allowlist,
        )
        .expect("contained pipe child");
    drop(server);
    let client = open_client_until(&address, Instant::now() + Duration::from_secs(2));
    let reported = sys::server_process_id(&client).expect("server PID");

    assert_eq!(reported, creator_pid);
    assert_ne!(reported, spawned.process_id.0);
    sys::write_release_byte(&client).expect("release child");
    assert_eq!(
        sys::wait_process(&spawned.group.root_process, 2_000).expect("child wait"),
        sys::WaitState::Signaled
    );
    assert_eq!(
        sys::exit_code(&spawned.group.root_process).expect("child exit"),
        0
    );
    adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("reap pipe child");
}

#[test]
#[ignore = "executed only as the inherited pipe child"]
fn child_accepts_on_inherited_pipe_handle() {
    let handle = env::var("AGENT_PLATFORM_PIPE_HANDLE")
        .expect("pipe handle")
        .parse()
        .expect("numeric pipe handle");
    sys::connect_and_wait_for_byte(handle).expect("connect inherited pipe");
}

fn child_launch(handle: usize) -> ContainedLaunch {
    let system_root = env::var_os("SystemRoot").expect("Windows has SystemRoot");
    ContainedLaunch {
        executable: env::current_exe().expect("current test executable"),
        arguments: vec![
            OsString::from("--ignored"),
            OsString::from("--exact"),
            OsString::from("windows::tests::pipe_identity::child_accepts_on_inherited_pipe_handle"),
        ],
        working_directory: env::temp_dir(),
        environment: vec![
            (
                OsString::from("AGENT_PLATFORM_PIPE_HANDLE"),
                OsString::from(handle.to_string()),
            ),
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
    }
}

fn open_client_until(address: &str, deadline: Instant) -> std::os::windows::io::OwnedHandle {
    loop {
        match sys::open_test_pipe_client(address) {
            Ok(client) => return client,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            Err(error) => panic!("pipe client deadline: {error}"),
        }
    }
}

fn monotonic_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos()
}
