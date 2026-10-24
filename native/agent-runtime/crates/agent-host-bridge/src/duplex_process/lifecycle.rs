use super::{
    DuplexChunk, DuplexProcessResult, DuplexWrite, io_workers, transport::DuplexTransport,
};
use agent_platform::containment::ContainmentPort;
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
use std::io;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};
use tokio::sync::mpsc as async_mpsc;

struct StopWorkers {
    cancel: Arc<AtomicBool>,
    close_console: Option<mpsc::Sender<()>>,
}
impl StopWorkers {
    fn close_console(&self) {
        if let Some(sender) = &self.close_console {
            let _ = sender.send(());
        }
    }
}
impl Drop for StopWorkers {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        self.close_console();
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "worker owns IO endpoints and cancellation through physical cleanup"
)]
pub(super) fn execute(
    group: WindowsJobGroup,
    mut transport: DuplexTransport,
    input: mpsc::Receiver<DuplexWrite>,
    output: async_mpsc::Sender<DuplexChunk>,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    stream_stderr: bool,
) -> io::Result<DuplexProcessResult> {
    let output_done = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let streams = transport.streams.take().expect("owned duplex streams");
        let (close_console, closer) = transport.console.take().map_or_else(
            || (None, None),
            |console| {
                let (send, receive) = mpsc::channel();
                (
                    Some(send),
                    Some(scope.spawn(move || {
                        let _ = receive.recv();
                        drop(console);
                    })),
                )
            },
        );
        // Also cancels backpressure loops on any early error before scope joins.
        let stop = StopWorkers {
            cancel: Arc::clone(&cancel),
            close_console,
        };
        let stderr_output = output.clone();
        let out = scope.spawn(|| {
            let result = io_workers::output(streams.stdout, output, &cancel, false);
            if result.is_err() {
                cancel.store(true, Ordering::Release);
            }
            output_done.fetch_add(1, Ordering::Release);
            result
        });
        let err = scope.spawn(|| {
            let result = if stream_stderr {
                io_workers::output(streams.stderr, stderr_output, &cancel, true).map(|()| {
                    crate::command::CommandCapture {
                        head: Vec::new(),
                        tail: Vec::new(),
                        total_bytes: 0,
                    }
                })
            } else {
                drop(stderr_output);
                crate::command::capture::read(streams.stderr, 64 * 1024)
            };
            if result.is_err() {
                cancel.store(true, Ordering::Release);
            }
            output_done.fetch_add(1, Ordering::Release);
            result
        });
        let writer = scope.spawn(|| io_workers::input(streams.stdin, input, &cancel));
        let containment = WindowsContainment::new();
        let (cancelled, timed_out) = monitor(&group, &cancel, timeout)?;
        if cancelled || timed_out {
            cancel.store(true, Ordering::Release);
        }
        containment
            .terminate_group(&group, 1)
            .map_err(io::Error::other)?;
        let evidence = containment
            .reap_group(group, Duration::from_secs(5))
            .map_err(|failure| io::Error::other(failure.error))?;
        // Close may emit a final terminal frame. Keep the output worker active
        // concurrently; the bounded drain grace below also releases backpressure.
        stop.close_console();
        // Preserve the final reply after a normal exit, with bounded consumer grace.
        let drain_until = Instant::now() + Duration::from_millis(500);
        while !cancel.load(Ordering::Acquire)
            && output_done.load(Ordering::Acquire) < 2
            && Instant::now() < drain_until
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        cancel.store(true, Ordering::Release);
        writer
            .join()
            .map_err(|_| io::Error::other("duplex stdin worker panicked"))?;
        out.join()
            .map_err(|_| io::Error::other("duplex stdout worker panicked"))??;
        let stderr = err
            .join()
            .map_err(|_| io::Error::other("duplex stderr worker panicked"))??;
        if let Some(closer) = closer {
            closer
                .join()
                .map_err(|_| io::Error::other("pseudo-console close worker panicked"))?;
        }
        Ok(DuplexProcessResult {
            process_id: evidence.process_id().0,
            exit_code: evidence.exit_code(),
            cancelled,
            timed_out,
            reaped: true,
            stderr,
        })
    })
}

fn monitor(
    group: &WindowsJobGroup,
    cancel: &AtomicBool,
    timeout: Duration,
) -> io::Result<(bool, bool)> {
    let began = Instant::now();
    loop {
        if group.root_exit_code().map_err(io::Error::other)?.is_some() {
            // Closing a backpressured reader can make the child exit on EPIPE
            // before this monitor wakes. Preserve cancellation in the receipt.
            return Ok((cancel.load(Ordering::Acquire), false));
        }
        let cancelled = cancel.load(Ordering::Acquire);
        let timed_out = began.elapsed() >= timeout;
        if cancelled || timed_out {
            return Ok((cancelled, timed_out));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
