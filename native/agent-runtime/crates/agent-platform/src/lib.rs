//! Platform containment contracts.
//!
//! Windows Job Objects, Linux cgroup v2 and macOS process-group adapters must
//! remain behind these modules.

pub mod budget;
pub mod containment;
pub mod ipc;
pub mod package_probe;

#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
pub mod unix;
