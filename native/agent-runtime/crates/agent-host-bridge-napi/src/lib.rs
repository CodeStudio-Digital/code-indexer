//! Node-API transport for the native Host attempt bridge.
//!
//! The ABI is intentionally narrow: one generated request enters Rust, and
//! the resulting class retains both authenticated streams until explicit
//! close. Raw endpoint credentials and operating-system handles never cross
//! the boundary.

#![allow(
    linker_messages,
    reason = "MSVC localizes its normal import-library creation notice to linker stdout"
)]

mod binding;
mod error;
mod model;
mod platform;
mod session_binding;
mod supervisor_binding;

pub use binding::{NativeHostAttemptChannels, open_host_attempt_bridge};
pub use model::{NativeHostBridgeAbi, native_host_bridge_abi};
pub use session_binding::{NativeSessionStoreBridge, open_native_session_store_bridge};
pub use supervisor_binding::{
    NativeHostSupervisorChannel, NativeHostSupervisorCloseReceipt, open_host_supervisor_bridge,
};
