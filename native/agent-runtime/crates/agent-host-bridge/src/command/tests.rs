use super::{HostCommand, HostCommandSpec};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

fn powershell(script: &str) -> HostCommandSpec {
    HostCommandSpec {
        executable: PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]
        .map(OsString::from)
        .into(),
        cwd: std::env::current_dir().unwrap(),
        environment: std::env::vars_os().collect(),
        stdin: Vec::new(),
        timeout_ms: 10_000,
        maximum_output_bytes: 1024,
    }
}

#[test]
fn captures_both_streams_and_stdin_before_proving_reap() {
    let mut spec = powershell(
        "$s=[Console]::In.ReadToEnd();[Console]::Out.Write('out:'+ $s);[Console]::Error.Write('err');exit 7",
    );
    spec.stdin = b"input".to_vec();
    let command = HostCommand::start(spec).unwrap();
    let pid = command.process_id();
    let result = command.wait().unwrap();
    assert_eq!(result.process_id, pid);
    assert!(result.reaped);
    assert_eq!(result.exit_code, 7);
    assert_eq!(result.stdout.head, b"out:input");
    assert_eq!(result.stderr.head, b"err");
    assert!(!result.cancelled && !result.timed_out);
}

#[test]
fn bounds_memory_but_preserves_the_actual_output_tail() {
    let mut spec = powershell("[Console]::Out.Write('HEAD'+('x'*200000)+'TAIL')");
    spec.maximum_output_bytes = 128;
    let result = HostCommand::start(spec).unwrap().wait().unwrap();
    assert_eq!(result.stdout.total_bytes, 200_008);
    assert_eq!(result.stdout.head.len(), 64);
    assert_eq!(result.stdout.tail.len(), 64);
    assert!(result.stdout.head.starts_with(b"HEAD"));
    assert!(result.stdout.tail.ends_with(b"TAIL"));
}

#[test]
fn command_interpreter_preserves_embedded_quotes_and_composition() {
    let mut spec = powershell("");
    spec.executable =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe");
    spec.arguments = ["/d", "/s", "/c", "echo \"quoted text\"&&echo second"]
        .map(OsString::from)
        .into();
    let result = HostCommand::start(spec).unwrap().wait().unwrap();
    assert_eq!(
        result.exit_code,
        0,
        "stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout.head),
        String::from_utf8_lossy(&result.stderr.head)
    );
    let text = String::from_utf8(result.stdout.head).unwrap();
    assert!(text.contains("\"quoted text\""));
    assert!(text.contains("second"));
    assert!(!text.contains("\\\""));
}

#[test]
fn cancellation_and_timeout_reap_running_trees() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let ready =
        std::env::temp_dir().join(format!("host-command-ready-{}-{stamp}", std::process::id()));
    let script = format!(
        "$p=Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden;[Console]::Out.WriteLine($p.Id);[IO.File]::WriteAllText('{}',[string]$p.Id);Start-Sleep -Seconds 60",
        ready.display().to_string().replace('\'', "''")
    );
    let command = HostCommand::start(powershell(&script)).unwrap();
    let cancel = command.cancellation();
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let child_ready = ready.exists();
    cancel.store(true, Ordering::Release);
    let result = command.wait().unwrap();
    let _ = std::fs::remove_file(&ready);
    assert!(child_ready, "child must exist before cancelling");
    assert!(result.cancelled && result.reaped && !result.timed_out);
    assert!(
        !result.stdout.head.is_empty(),
        "child must exist before cancelling"
    );

    let mut spec = powershell("Start-Sleep -Seconds 60");
    spec.timeout_ms = 300;
    let result = HostCommand::start(spec).unwrap().wait().unwrap();
    assert!(result.timed_out && result.reaped);
}

#[test]
fn root_exit_also_reaps_detached_descendants() {
    let result = HostCommand::start(powershell("$p=Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden;[Console]::Out.WriteLine($p.Id)"))
        .unwrap().wait().unwrap();
    assert!(!result.stdout.head.is_empty());
    assert_eq!(result.exit_code, 0);
    assert!(result.reaped && !result.timed_out && !result.cancelled);
}

#[test]
fn rejects_bad_limits_before_creating_a_process() {
    let mut spec = powershell("throw 'must not execute'");
    spec.maximum_output_bytes = 0;
    assert!(HostCommand::start(spec).is_err());
}
