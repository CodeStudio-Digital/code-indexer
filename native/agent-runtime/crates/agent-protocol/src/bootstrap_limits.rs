//! Shared hard bounds for process-bootstrap credentials.
//!
//! These values are wire-independent policy. Keeping them in one crate avoids
//! accepting a launch credential that a later handshake must reject.

/// Minimum entropy-bearing byte length for bootstrap credentials.
pub const BOOTSTRAP_SECRET_MIN_BYTES: usize = 16;

/// Maximum byte length for a launch nonce carried into `AgentHello`.
pub const LAUNCH_NONCE_MAX_BYTES: usize = 256;

/// Maximum byte length for any ephemeral bootstrap/session token.
pub const SESSION_TOKEN_MAX_BYTES: usize = 512;
