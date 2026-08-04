use std::ffi::OsString;
use std::path::PathBuf;

use crate::budget::ResourceBudget;
use crate::containment::{ContainedLaunch, ContainmentPort, ResourceGroupId, SpawnedGroup};

use super::{WindowsContainment, WindowsJobGroup};

const TERMINATED_EXIT_CODE: u32 = 0x00A6_1701;

fn budget() -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 64 * 1024 * 1024,
        hard_memory_bytes: 128 * 1024 * 1024,
        cpu_time_ms: 60_000,
        max_wall_ms: 60_000,
        max_processes: 2,
        max_threads: 32,
        max_open_handles: 256,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 16,
        max_ipc_bytes: 4096,
        max_spool_bytes: 4096,
        max_artifact_bytes: 2048,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1000,
    }
}

fn inert_launch() -> ContainedLaunch {
    let system_root = std::env::var_os("SystemRoot").expect("Windows has SystemRoot");
    let executable = PathBuf::from(&system_root)
        .join("System32")
        .join("ping.exe");
    ContainedLaunch {
        executable,
        arguments: vec![
            OsString::from("-n"),
            OsString::from("60"),
            OsString::from("127.0.0.1"),
        ],
        working_directory: std::env::temp_dir(),
        environment: vec![
            (OsString::from("SystemRoot"), system_root.clone()),
            (OsString::from("WINDIR"), system_root),
        ],
    }
}

fn spawn(group: &str) -> SpawnedGroup<WindowsJobGroup> {
    WindowsContainment::new()
        .spawn_runner_contained(
            ResourceGroupId(group.to_owned()),
            &budget(),
            &inert_launch(),
        )
        .expect("contained ping process")
}

mod bootstrap;
mod expected_address;
mod inheritance;
mod launch;
mod lifecycle;
mod local_ipc;
mod pipe_identity;
mod resource;
