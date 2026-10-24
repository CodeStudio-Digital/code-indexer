use super::{HostCommandResult, capture};
use agent_platform::containment::ContainmentPort;
use agent_platform::windows::bootstrap::WindowsCommandStreams;
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(super) fn execute(
    group: WindowsJobGroup,
    streams: WindowsCommandStreams,
    stdin: Vec<u8>,
    maximum: usize,
    timeout: Duration,
    cancel: &AtomicBool,
) -> io::Result<HostCommandResult> {
    std::thread::scope(|scope| {
        let out = scope.spawn(|| capture::read(streams.stdout, maximum));
        let err = scope.spawn(|| capture::read(streams.stderr, maximum));
        let input = scope.spawn(move || {
            let mut writer = streams.stdin;
            match writer.write_all(&stdin) {
                Err(error) if error.kind() != io::ErrorKind::BrokenPipe => Err(error),
                _ => Ok(()),
            }
        });
        let containment = WindowsContainment::new();
        let started = Instant::now();
        let mut timed_out = false;
        let mut cancelled = false;
        loop {
            if group.root_exit_code().map_err(io::Error::other)?.is_some() {
                break;
            }
            cancelled = cancel.load(Ordering::Acquire);
            timed_out = started.elapsed() >= timeout;
            if cancelled || timed_out {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Also terminate detached descendants after a successful root exit.
        // No owned background work may outlive this tool invocation.
        containment
            .terminate_group(&group, 1)
            .map_err(io::Error::other)?;
        let evidence = containment
            .reap_group(group, Duration::from_secs(5))
            .map_err(|failure| io::Error::other(failure.error))?;
        input
            .join()
            .map_err(|_| io::Error::other("stdin worker panicked"))??;
        let stdout = out
            .join()
            .map_err(|_| io::Error::other("stdout worker panicked"))??;
        let stderr = err
            .join()
            .map_err(|_| io::Error::other("stderr worker panicked"))??;
        Ok(HostCommandResult {
            stdout,
            stderr,
            process_id: evidence.process_id().0,
            exit_code: evidence.exit_code(),
            cancelled,
            timed_out,
            reaped: true,
        })
    })
}
