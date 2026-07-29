use std::time::{Duration, Instant};

use super::{EffectiveBootstrapDeadline, EffectiveBootstrapDeadlineError};

const NOW_UNIX_MS: i64 = 10_000;

#[test]
fn minimum_authority_limit_becomes_the_single_monotonic_cutoff() {
    let now = Instant::now();
    let deadline = EffectiveBootstrapDeadline::derive(
        NOW_UNIX_MS,
        now,
        NOW_UNIX_MS + 5_000,
        NOW_UNIX_MS + 800,
        Duration::from_secs(3),
    )
    .expect("effective deadline");

    assert_eq!(
        deadline.instant().duration_since(now),
        Duration::from_millis(800)
    );
    assert!(deadline.permits_completion(NOW_UNIX_MS + 799, now + Duration::from_millis(799)));
    assert!(!deadline.permits_completion(NOW_UNIX_MS + 800, now + Duration::from_millis(799)));
}

#[test]
fn local_startup_timeout_can_be_the_tighter_limit() {
    let now = Instant::now();
    let deadline = EffectiveBootstrapDeadline::derive(
        NOW_UNIX_MS,
        now,
        NOW_UNIX_MS + 5_000,
        NOW_UNIX_MS + 4_000,
        Duration::from_millis(250),
    )
    .expect("effective deadline");

    assert_eq!(
        deadline.instant().duration_since(now),
        Duration::from_millis(250)
    );
    assert!(!deadline.permits_completion(NOW_UNIX_MS + 100, deadline.instant()));
}

#[test]
fn expired_or_empty_authority_fails_closed() {
    let now = Instant::now();
    assert_eq!(
        EffectiveBootstrapDeadline::derive(
            NOW_UNIX_MS,
            now,
            NOW_UNIX_MS,
            NOW_UNIX_MS + 1,
            Duration::from_secs(1),
        )
        .expect_err("hard deadline is already expired"),
        EffectiveBootstrapDeadlineError::AuthorityExpired
    );
    assert_eq!(
        EffectiveBootstrapDeadline::derive(
            NOW_UNIX_MS,
            now,
            NOW_UNIX_MS + 1,
            NOW_UNIX_MS + 1,
            Duration::ZERO,
        )
        .expect_err("zero startup window is invalid"),
        EffectiveBootstrapDeadlineError::EmptyStartupWindow
    );
    assert_eq!(
        EffectiveBootstrapDeadline::derive(
            0,
            now,
            NOW_UNIX_MS + 1,
            NOW_UNIX_MS + 1,
            Duration::from_secs(1),
        )
        .expect_err("wall clock must be valid"),
        EffectiveBootstrapDeadlineError::InvalidObservedTime
    );
}
