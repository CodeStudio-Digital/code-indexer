//! Single-tenant process boundary for one `AgentRunAttempt`.

#[cfg(windows)]
pub mod bootstrap;
pub mod control;
pub mod lifecycle;
#[cfg(feature = "performance-harness")]
pub mod performance;
#[cfg(windows)]
pub mod process;

/// Direct or malformed launches fail closed; package diagnostics never acquire
/// authority.
pub const SCAFFOLD_EXIT_CODE: u8 = 78;
