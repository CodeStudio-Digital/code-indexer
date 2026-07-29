use std::fmt::Write as _;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_protocol::semantic_hash::semantic_sha256;
use agent_runner::performance::{
    PERFORMANCE_PROBE_ARG, PERFORMANCE_PROBE_DEADLINE_ENV, PERFORMANCE_PROBE_TOKEN_ENV,
    prepared_probe_host_input, read_prepared_probe_output,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
static PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub fn probe_once(runner: &Path) -> Result<Duration, String> {
    let deadline = unix_ms()?
        .checked_add(5_000)
        .ok_or_else(|| "probe deadline overflow".to_owned())?;
    let input = prepared_probe_host_input(deadline)?;
    let token = probe_token()?;
    let started = Instant::now();
    let mut child = Command::new(runner)
        .arg(PERFORMANCE_PROBE_ARG)
        .arg(&token)
        .env(PERFORMANCE_PROBE_TOKEN_ENV, &token)
        .env(PERFORMANCE_PROBE_DEADLINE_ENV, deadline.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("cannot spawn agent-runner: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| cleanup_error(&mut child, "runner stdin is unavailable"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| cleanup_error(&mut child, "runner stdout is unavailable"))?;
    stdin
        .write_all(&input)
        .and_then(|()| stdin.flush())
        .map_err(|error| cleanup_error(&mut child, &format!("cannot send host frames: {error}")))?;
    drop(stdin);
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let result = read_prepared_probe_output(&mut stdout);
        let _ = sender.send(result);
    });
    let observed = receiver.recv_timeout(PROBE_TIMEOUT);
    let elapsed = started.elapsed();
    match observed {
        Ok(Ok(output)) if output.saw_agent_hello && output.frames == 2 => {}
        Ok(Ok(_)) => {
            stop(&mut child);
            let _ = reader.join();
            return Err("runner output did not prove the two-frame transition".into());
        }
        Ok(Err(error)) => {
            stop(&mut child);
            let _ = reader.join();
            return Err(error);
        }
        Err(_) => {
            stop(&mut child);
            let _ = reader.join();
            return Err("runner exceeded the 5 second probe timeout".into());
        }
    }
    let status = wait_bounded(&mut child)?;
    reader
        .join()
        .map_err(|_| "runner output reader panicked".to_owned())?;
    if !status.success() {
        return Err(format!(
            "runner exited before a clean prepared boundary: {status}"
        ));
    }
    Ok(elapsed)
}

fn wait_bounded(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("cannot observe runner exit: {error}"))?
        {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            stop(child);
            return Err("runner stayed alive after AttemptPrepared".into());
        }
        thread::sleep(Duration::from_millis(1));
    }
}

fn cleanup_error(child: &mut Child, message: &str) -> String {
    stop(child);
    message.to_owned()
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn probe_token() -> Result<String, String> {
    let sequence = PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{}:{sequence}:{}", std::process::id(), unix_ms()?);
    let digest = semantic_sha256("codestudio.agent.performance-probe.v1", 1, seed.as_bytes())
        .map_err(|error| format!("cannot derive probe token: {error}"))?;
    let mut output = String::with_capacity(64);
    for byte in digest {
        write!(output, "{byte:02x}").map_err(|_| "cannot encode probe token")?;
    }
    Ok(output)
}

fn unix_ms() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before Unix epoch")?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "system clock exceeds i64".into())
}
