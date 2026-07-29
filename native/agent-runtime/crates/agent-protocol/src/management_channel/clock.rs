use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::ManagementChannelError;

#[derive(Debug)]
pub(super) struct ManagementClockAuthority {
    unix_at_start: Duration,
    monotonic_start: Instant,
}

impl ManagementClockAuthority {
    pub(super) fn system() -> Result<Self, ManagementChannelError> {
        let unix_at_start = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ManagementChannelError::InvalidObservedAt(0))?;
        unix_ms_from_anchor(unix_at_start, Duration::ZERO)
            .ok_or(ManagementChannelError::InvalidObservedAt(0))?;
        Ok(Self {
            unix_at_start,
            monotonic_start: Instant::now(),
        })
    }

    pub(super) fn now_unix_ms(&self) -> i64 {
        unix_ms_from_anchor(self.unix_at_start, self.monotonic_start.elapsed()).unwrap_or(i64::MAX)
    }
}

fn unix_ms_from_anchor(anchor: Duration, elapsed: Duration) -> Option<i64> {
    i64::try_from(anchor.checked_add(elapsed)?.as_millis()).ok()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::unix_ms_from_anchor;

    #[test]
    fn carries_anchor_fraction_into_elapsed_time_before_rounding() {
        assert_eq!(
            unix_ms_from_anchor(Duration::from_nanos(1_999_999), Duration::from_nanos(1))
                .expect("representable Unix time"),
            2
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
