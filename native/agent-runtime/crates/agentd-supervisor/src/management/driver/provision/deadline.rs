use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::time::{Duration, Instant};

/// One monotonic cutoff derived from every bootstrap authority limit.
#[derive(Debug, Clone, Copy)]
pub(super) struct EffectiveBootstrapDeadline {
    instant: Instant,
    authority_limit_at_unix_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EffectiveBootstrapDeadlineError {
    InvalidObservedTime,
    AuthorityExpired,
    EmptyStartupWindow,
    MonotonicOverflow,
}

impl EffectiveBootstrapDeadline {
    /// Converts the remaining wall-clock authority exactly once, then uses the
    /// monotonic clock for the complete bootstrap operation.
    pub(super) fn derive(
        observed_at_unix_ms: i64,
        observed_at: Instant,
        hard_deadline_at_unix_ms: i64,
        authority_lease_expires_at_unix_ms: i64,
        startup_timeout: Duration,
    ) -> Result<Self, EffectiveBootstrapDeadlineError> {
        if observed_at_unix_ms <= 0 {
            return Err(EffectiveBootstrapDeadlineError::InvalidObservedTime);
        }
        if startup_timeout.is_zero() {
            return Err(EffectiveBootstrapDeadlineError::EmptyStartupWindow);
        }
        let authority_limit_at_unix_ms =
            hard_deadline_at_unix_ms.min(authority_lease_expires_at_unix_ms);
        let remaining_ms = authority_limit_at_unix_ms
            .checked_sub(observed_at_unix_ms)
            .filter(|remaining| *remaining > 0)
            .ok_or(EffectiveBootstrapDeadlineError::AuthorityExpired)?;
        let remaining_ms = u64::try_from(remaining_ms)
            .map_err(|_| EffectiveBootstrapDeadlineError::MonotonicOverflow)?;
        let effective_window = Duration::from_millis(remaining_ms).min(startup_timeout);
        let instant = observed_at
            .checked_add(effective_window)
            .ok_or(EffectiveBootstrapDeadlineError::MonotonicOverflow)?;
        Ok(Self {
            instant,
            authority_limit_at_unix_ms,
        })
    }

    #[must_use]
    pub(super) const fn instant(self) -> Instant {
        self.instant
    }

    /// Final gate: both the monotonic startup window and current authority
    /// must still be live before a protected receipt can be minted.
    #[must_use]
    pub(super) fn permits_completion(self, observed_at_unix_ms: i64, observed_at: Instant) -> bool {
        observed_at_unix_ms > 0
            && observed_at_unix_ms < self.authority_limit_at_unix_ms
            && observed_at < self.instant
    }
}

impl Display for EffectiveBootstrapDeadlineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "effective runner bootstrap deadline is invalid: {self:?}"
        )
    }
}

impl Error for EffectiveBootstrapDeadlineError {}

#[cfg(test)]
mod tests;
