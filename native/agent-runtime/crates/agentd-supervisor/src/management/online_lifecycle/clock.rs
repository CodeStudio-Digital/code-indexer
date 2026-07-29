use std::error::Error;
use std::fmt::Debug;
use std::fmt::{self, Display, Formatter};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Trusted monotonic Unix-millisecond source for physical lifecycle decisions.
pub trait SupervisorLifecycleClock: Debug + Send + Sync {
    fn now_unix_ms(&self) -> i64;
}

/// Production clock anchored once to wall time and advanced monotonically.
#[derive(Debug, Clone)]
pub struct SystemSupervisorLifecycleClock {
    unix_at_start: Duration,
    anchor: Instant,
}

impl SystemSupervisorLifecycleClock {
    /// # Errors
    ///
    /// Fails closed if a valid Unix-millisecond anchor cannot be represented.
    pub fn new() -> Result<Self, SupervisorLifecycleClockError> {
        let unix_at_start = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SupervisorLifecycleClockError::BeforeUnixEpoch)?;
        unix_ms_from_anchor(unix_at_start, Duration::ZERO)
            .ok_or(SupervisorLifecycleClockError::UnixMillisOverflow)?;
        Ok(Self {
            unix_at_start,
            anchor: Instant::now(),
        })
    }
}

impl SupervisorLifecycleClock for SystemSupervisorLifecycleClock {
    fn now_unix_ms(&self) -> i64 {
        unix_ms_from_anchor(self.unix_at_start, self.anchor.elapsed()).unwrap_or(i64::MAX)
    }
}

fn unix_ms_from_anchor(anchor: Duration, elapsed: Duration) -> Option<i64> {
    i64::try_from(anchor.checked_add(elapsed)?.as_millis()).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorLifecycleClockError {
    BeforeUnixEpoch,
    UnixMillisOverflow,
}

impl Display for SupervisorLifecycleClockError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid supervisor lifecycle clock: {self:?}")
    }
}

impl Error for SupervisorLifecycleClockError {}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::unix_ms_from_anchor;

    #[test]
    fn carries_anchor_fraction_into_elapsed_time_before_rounding() {
        assert_eq!(
            unix_ms_from_anchor(Duration::from_nanos(1_999_999), Duration::from_nanos(1)),
            Some(2)
        );
    }

    #[test]
    fn independent_anchor_phases_project_the_same_instant_consistently() {
        let earlier_anchor =
            unix_ms_from_anchor(Duration::from_micros(1_000_900), Duration::from_micros(300));
        let later_anchor =
            unix_ms_from_anchor(Duration::from_micros(1_001_100), Duration::from_micros(100));

        assert_eq!(earlier_anchor, Some(1_001));
        assert_eq!(later_anchor, earlier_anchor);
    }

    #[test]
    fn fails_closed_when_duration_or_millisecond_projection_overflows() {
        assert_eq!(
            unix_ms_from_anchor(Duration::MAX, Duration::from_nanos(1)),
            None
        );
        assert_eq!(
            unix_ms_from_anchor(Duration::from_millis(i64::MAX as u64 + 1), Duration::ZERO),
            None
        );
    }
}
