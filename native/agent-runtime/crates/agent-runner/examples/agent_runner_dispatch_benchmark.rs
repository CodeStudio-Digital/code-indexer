use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

const WARMUP: usize = 100;
const SAMPLES: usize = 1_000;
const THRESHOLD_US: u128 = 5_000;

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("GATE_PERF_03_ERROR {error}");
            ExitCode::from(70)
        }
    }
}

fn run() -> Result<bool, String> {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return Err("native dispatch benchmark requires Windows and --release".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "codestudio-dispatch-probe-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir(&root).map_err(|error| error.to_string())?;
    let result = (|| {
        let content = "x".repeat(4_096);
        std::fs::write(root.join("dispatch-fixture.txt"), &content)
            .map_err(|error| error.to_string())?;
        let canonical = std::fs::canonicalize(&root).map_err(|error| error.to_string())?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(4)
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        let mut durations =
            runtime.block_on(agent_runner::performance::probe_native_read_dispatch(
                &canonical, &content, WARMUP, SAMPLES,
            ))?;
        durations.sort_unstable();
        let p95 = durations[(SAMPLES * 95).div_ceil(100) - 1].as_micros();
        let report = serde_json::json!({
            "schema": "GATE_PERF_03_RESULT_V1", "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH, "profile": "release", "disk": "warmed",
            "warmup": WARMUP, "samples": SAMPLES, "fixtureBytes": content.len(),
            "p50_us": durations[SAMPLES.div_ceil(2) - 1].as_micros(), "p95_us": p95,
            "p99_us": durations[(SAMPLES * 99).div_ceil(100) - 1].as_micros(),
            "max_us": durations[SAMPLES - 1].as_micros(), "threshold_us": THRESHOLD_US,
            "passed": p95 <= THRESHOLD_US,
            "scope": "Native executor total including validation, blocking dispatch, filesystem read and encoding; excludes Host IPC, policy admission and durable journal",
            "interpretation": "Total duration is an upper bound for executor dispatch overhead; no baseline subtraction",
        });
        println!("{report}");
        Ok(p95 <= THRESHOLD_US)
    })();
    // Only remove the one fixture we created; never recursively traverse a
    // caller-supplied or replaced directory.
    let cleanup = std::fs::remove_file(root.join("dispatch-fixture.txt"))
        .and_then(|()| std::fs::remove_dir(&root))
        .map_err(|error| error.to_string());
    cleanup?;
    result
}
