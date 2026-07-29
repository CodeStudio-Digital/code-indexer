//! Small, domain-free supervisor for admission and process ownership.
//!
//! The physical registry is deliberately not a public bypass around the typed
//! coordinator:
//!
//! ```compile_fail
//! use agentd_supervisor::process_table::OwnershipRegistry;
//! ```

#[allow(
    dead_code,
    reason = "staged lifecycle telemetry remains private until the physical event driver lands"
)]
mod admission;
pub mod management;
#[allow(
    dead_code,
    reason = "staged exit/reap transitions remain private and test-covered without an external bypass"
)]
mod process_table;

/// Normal execution fails closed; package diagnostics never acquire authority.
pub const SCAFFOLD_EXIT_CODE: u8 = 78;
