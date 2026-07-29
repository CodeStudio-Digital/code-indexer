use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use super::{RemoteCleanupResult, RemoteLaunchCleanup, RemoteLaunchCleanupError};
use crate::management::driver::provision::ProtectedLaunchCleanupPort;

#[test]
fn timed_out_attempt_is_consumed_before_another_is_sent() {
    let (commands, worker_commands) = mpsc::sync_channel(1);
    let (worker_results, results) = mpsc::sync_channel(1);
    let (first_started, first_observed) = mpsc::sync_channel(1);
    let (release_first, first_release) = mpsc::sync_channel(1);
    let attempts = Arc::new(AtomicUsize::new(0));
    let worker_attempts = Arc::clone(&attempts);
    let thread = thread::spawn(move || {
        if worker_commands.recv().is_err() {
            return;
        }
        worker_attempts.fetch_add(1, Ordering::SeqCst);
        if first_started.send(()).is_err() || first_release.recv().is_err() {
            return;
        }
        if worker_results.send(RemoteCleanupResult::Retry).is_err() {
            return;
        }
        if worker_commands.recv().is_err() {
            return;
        }
        worker_attempts.fetch_add(1, Ordering::SeqCst);
        let _ = worker_results.send(RemoteCleanupResult::Completed);
    });
    let mut cleanup = RemoteLaunchCleanup::new(commands, results, thread);

    let started_at = Instant::now();
    let first = cleanup.try_cleanup();
    let first_elapsed = started_at.elapsed();
    let first_was_observed = first_observed.recv_timeout(Duration::from_secs(1)).is_ok();
    let first_was_released = release_first.send(()).is_ok();

    let second = cleanup.try_cleanup();
    let attempts_after_second = attempts.load(Ordering::SeqCst);
    let mut completed = cleanup.try_cleanup();
    let finish_deadline = Instant::now() + Duration::from_secs(1);
    while matches!(completed, Err(RemoteLaunchCleanupError::RetryPending))
        && Instant::now() < finish_deadline
    {
        thread::yield_now();
        completed = cleanup.try_cleanup();
    }

    assert_eq!(first, Err(RemoteLaunchCleanupError::RetryPending));
    assert!(first_elapsed < Duration::from_secs(1));
    assert!(first_was_observed);
    assert!(first_was_released);
    assert_eq!(second, Err(RemoteLaunchCleanupError::RetryPending));
    assert_eq!(attempts_after_second, 1);
    assert!(completed.is_ok());
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}
