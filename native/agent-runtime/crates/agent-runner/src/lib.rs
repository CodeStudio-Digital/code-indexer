//! Single-tenant process boundary for one `AgentRunAttempt`.

#[cfg(windows)]
pub mod bootstrap;
mod capability_gateway;
pub mod control;
mod engine_authority;
#[cfg(windows)]
mod external_engine;
pub mod lifecycle;
mod native_tools;
#[cfg(feature = "performance-harness")]
pub mod performance;
#[cfg(windows)]
pub mod process;
mod provider_context;
pub mod provider_data;
pub mod provider_event_sink;
pub mod provider_gateway;

/// Direct or malformed launches fail closed; package diagnostics never acquire
/// authority.
pub const SCAFFOLD_EXIT_CODE: u8 = 78;
