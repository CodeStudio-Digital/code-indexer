//! Feature-gated release benchmark seams.
//!
//! This module is never enabled in packaged builds. It exercises the real
//! control driver through `AttemptPrepared` and isolated native tool fixtures.

use std::env;
use std::io::{self, BufReader};

mod child;
mod dispatch;
mod fixture;
mod output;

pub use dispatch::probe_native_read_dispatch;
pub use fixture::prepared_probe_host_input;
pub use output::{PreparedProbeOutput, read_prepared_probe_output};

pub const PERFORMANCE_PROBE_ARG: &str = "--performance-prepared-probe";
pub const PERFORMANCE_PROBE_TOKEN_ENV: &str = "CODESTUDIO_AGENT_PERF_PROBE_TOKEN";
pub const PERFORMANCE_PROBE_DEADLINE_ENV: &str = "CODESTUDIO_AGENT_PERF_PROBE_DEADLINE_UNIX_MS";

/// Result of dispatching the feature-gated child mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerformanceProbeDispatch {
    NotRequested,
    Completed,
    Rejected,
}

/// Runs the child-side probe only for an exact, token-gated invocation.
#[must_use]
pub fn dispatch_current_process() -> PerformanceProbeDispatch {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) != Some(PERFORMANCE_PROBE_ARG) {
        return PerformanceProbeDispatch::NotRequested;
    }
    if arguments.len() != 2
        || !valid_token(&arguments[1])
        || env::var(PERFORMANCE_PROBE_TOKEN_ENV).as_deref() != Ok(arguments[1].as_str())
    {
        return PerformanceProbeDispatch::Rejected;
    }
    let Ok(deadline) = env::var(PERFORMANCE_PROBE_DEADLINE_ENV)
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .ok_or(())
    else {
        return PerformanceProbeDispatch::Rejected;
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    match child::run(BufReader::new(stdin.lock()), stdout.lock(), deadline) {
        Ok(()) => PerformanceProbeDispatch::Completed,
        Err(error) => {
            eprintln!("PERFORMANCE_PROBE_REJECTED {error}");
            PerformanceProbeDispatch::Rejected
        }
    }
}

const fn valid_token(value: &str) -> bool {
    if value.len() != 64 {
        return false;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !matches!(bytes[index], b'0'..=b'9' | b'a'..=b'f') {
            return false;
        }
        index += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::valid_token;

    #[test]
    fn performance_token_is_exact_lowercase_hex() {
        assert!(valid_token(&"a".repeat(64)));
        assert!(!valid_token(&"a".repeat(63)));
        assert!(!valid_token(&"A".repeat(64)));
        assert!(!valid_token(&"g".repeat(64)));
    }
}
