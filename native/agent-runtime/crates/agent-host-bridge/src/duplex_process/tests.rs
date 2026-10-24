use super::{DuplexProcessSpec, HostDuplexProcess, enqueue_write};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn powershell(script: &str) -> DuplexProcessSpec {
    DuplexProcessSpec {
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
        timeout_ms: 10_000,
        stream_stderr: false,
        pseudoconsole: None,
    }
}

#[tokio::test]
async fn exchanges_multiple_frames_then_drains_the_final_reply() {
    let process = HostDuplexProcess::start(powershell("while(($s=[Console]::In.ReadLine()) -ne $null){[Console]::Out.WriteLine('echo:'+ $s);if($s -eq 'exit'){break}}" )).unwrap();
    let output = process.output();
    let mut output = output.lock().await;
    for text in ["one", "two", "exit"] {
        enqueue_write(
            &process.input(),
            &process.cancellation(),
            format!("{text}\n").into_bytes(),
        )
        .unwrap()
        .await
        .unwrap()
        .unwrap();
        let mut reply = Vec::new();
        while !reply.ends_with(b"\n") {
            let chunk = tokio::time::timeout(Duration::from_secs(5), output.recv())
                .await
                .unwrap()
                .unwrap();
            assert!(!chunk.stderr);
            reply.extend(chunk.bytes);
        }
        assert_eq!(
            String::from_utf8(reply).unwrap().trim(),
            format!("echo:{text}")
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .is_none()
    );
    drop(output);
    let result = tokio::task::spawn_blocking(move || process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(result.reaped && !result.cancelled && !result.timed_out);
    assert_eq!(result.exit_code, 0);
}

#[test]
fn cancel_unblocks_a_slow_output_consumer_and_reaps_the_tree() {
    let process = HostDuplexProcess::start(powershell(
        "[Console]::Out.Write('x'*2000000);Start-Sleep -Seconds 60",
    ))
    .unwrap();
    std::thread::sleep(Duration::from_secs(1));
    let began = Instant::now();
    process.cancellation().store(true, Ordering::Release);
    let result = process.wait().unwrap();
    assert!(result.cancelled && result.reaped);
    assert!(began.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn bounds_queued_input_and_settles_every_receipt_on_cancel() {
    let process = HostDuplexProcess::start(powershell("Start-Sleep -Seconds 60")).unwrap();
    let mut receipts = Vec::new();
    for _ in 0..10 {
        match enqueue_write(
            &process.input(),
            &process.cancellation(),
            vec![b'x'; 1_048_576],
        ) {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                break;
            }
        }
    }
    assert!(!receipts.is_empty() && receipts.len() <= 5);
    process.cancellation().store(true, Ordering::Release);
    assert!(
        tokio::task::spawn_blocking(move || process.wait())
            .await
            .unwrap()
            .unwrap()
            .reaped
    );
    for receipt in receipts {
        let result = tokio::time::timeout(Duration::from_secs(1), receipt)
            .await
            .unwrap();
        assert!(!matches!(result, Ok(Ok(()))));
    }
}

#[test]
fn deadline_reaps_the_persistent_process() {
    let mut spec = powershell("Start-Sleep -Seconds 60");
    spec.timeout_ms = 250;
    let result = HostDuplexProcess::start(spec).unwrap().wait().unwrap();
    assert!(result.reaped && result.timed_out);
}

#[tokio::test]
async fn pseudoconsole_provides_a_real_terminal_and_interactive_input() {
    let mut spec = powershell(
        "[Console]::Out.WriteLine('TTY:'+ [Console]::IsOutputRedirected);$s=[Console]::ReadLine();[Console]::Out.WriteLine('ANSWER:'+ $s)",
    );
    spec.pseudoconsole = Some((120, 30));
    spec.stream_stderr = true;
    let process = HostDuplexProcess::start(spec).unwrap();
    let output = process.output();
    let mut output = output.lock().await;
    let mut text = String::new();
    while !text.contains("TTY:False") {
        let chunk = tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap();
        text.push_str(&String::from_utf8_lossy(&chunk.bytes));
        assert!(text.len() < 100_000, "terminal output remained bounded");
    }
    enqueue_write(
        &process.input(),
        &process.cancellation(),
        b"hello\r".to_vec(),
    )
    .unwrap()
    .await
    .unwrap()
    .unwrap();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(5), output.recv())
        .await
        .unwrap()
    {
        text.push_str(&String::from_utf8_lossy(&chunk.bytes));
        assert!(text.len() < 100_000);
    }
    assert!(text.contains("ANSWER:hello"), "terminal transcript: {text}");
    let result = tokio::task::spawn_blocking(move || process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(result.reaped && !result.cancelled && !result.timed_out);
    assert_eq!(result.exit_code, 0);
}

#[test]
fn pseudoconsole_cancellation_unblocks_a_stalled_consumer() {
    let mut spec = powershell("[Console]::Out.Write('x'*4000000);Start-Sleep -Seconds 60");
    spec.pseudoconsole = Some((120, 30));
    let process = HostDuplexProcess::start(spec).unwrap();
    std::thread::sleep(Duration::from_secs(1));
    let started = Instant::now();
    process.cancellation().store(true, Ordering::Release);
    let result = process.wait().unwrap();
    assert!(result.reaped && result.cancelled);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn rejects_invalid_terminal_geometry_before_spawn() {
    let mut spec = powershell("throw 'must not execute'");
    spec.pseudoconsole = Some((0, 30));
    assert!(HostDuplexProcess::start(spec).is_err());
}
