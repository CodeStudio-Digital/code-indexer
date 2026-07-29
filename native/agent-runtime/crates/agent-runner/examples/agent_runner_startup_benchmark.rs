use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[path = "startup_benchmark/process.rs"]
mod process;

use process::probe_once;

const DEFAULT_WARMUP: usize = 10;
const DEFAULT_SAMPLES: usize = 100;
const GATE_THRESHOLD_MS: u64 = 250;

#[derive(Debug, Clone, Copy)]
struct BenchmarkConfig {
    warmup: usize,
    samples: usize,
    threshold_ms: u64,
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("GATE_PERF_01_ERROR {error}");
            ExitCode::from(70)
        }
    }
}

fn run() -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Err("benchmark must be compiled with --release".into());
    }
    let config = parse_config()?;
    let runner = runner_executable()?;
    let mut samples = Vec::with_capacity(config.samples);
    for _ in 0..config.warmup {
        probe_once(&runner)?;
    }
    for _ in 0..config.samples {
        samples.push(probe_once(&runner)?.as_micros());
    }
    samples.sort_unstable();
    let p50_us = percentile(&samples, 50);
    let p95_us = percentile(&samples, 95);
    let p99_us = percentile(&samples, 99);
    let max_us = *samples.last().ok_or_else(|| "no samples".to_owned())?;
    let threshold_us = u128::from(config.threshold_ms) * 1_000;
    let passed = p95_us <= threshold_us;
    println!(
        concat!(
            "{{\"schema\":\"GATE_PERF_01_RESULT_V1\",",
            "\"platform\":\"{}\",\"arch\":\"{}\",\"profile\":\"release\",",
            "\"disk\":\"warmed\",\"warmup\":{},\"samples\":{},",
            "\"p50_us\":{},\"p95_us\":{},\"p99_us\":{},\"max_us\":{},",
            "\"threshold_us\":{},\"passed\":{}}}"
        ),
        env::consts::OS,
        env::consts::ARCH,
        config.warmup,
        config.samples,
        p50_us,
        p95_us,
        p99_us,
        max_us,
        threshold_us,
        passed,
    );
    Ok(passed)
}

fn parse_config() -> Result<BenchmarkConfig, String> {
    let mut config = BenchmarkConfig {
        warmup: DEFAULT_WARMUP,
        samples: DEFAULT_SAMPLES,
        threshold_ms: GATE_THRESHOLD_MS,
    };
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {argument}"))?;
        match argument.as_str() {
            "--warmup" => config.warmup = parse_positive(&value, "warmup")?,
            "--samples" => config.samples = parse_positive(&value, "samples")?,
            "--threshold-ms" => {
                config.threshold_ms = value
                    .parse()
                    .map_err(|_| "threshold must be an integer".to_owned())?;
            }
            _ => return Err(format!("unknown benchmark argument: {argument}")),
        }
    }
    if config.warmup < 5 {
        return Err("warmup must contain at least 5 launches".into());
    }
    if config.samples < 20 {
        return Err("benchmark must contain at least 20 measured launches".into());
    }
    if config.threshold_ms == 0 || config.threshold_ms > GATE_THRESHOLD_MS {
        return Err("threshold must stay within the 250 ms architecture gate".into());
    }
    Ok(config)
}

fn parse_positive(value: &str, label: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|parsed| *parsed > 0)
        .ok_or_else(|| format!("{label} must be a positive integer"))
}

fn runner_executable() -> Result<PathBuf, String> {
    let benchmark = env::current_exe()
        .map_err(|error| format!("cannot resolve benchmark executable: {error}"))?;
    let profile = benchmark
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "benchmark is not under target/<profile>/examples".to_owned())?;
    let runner = profile.join(format!("agent-runner{}", env::consts::EXE_SUFFIX));
    runner
        .is_file()
        .then_some(runner)
        .ok_or_else(|| "feature-enabled release agent-runner was not built".to_owned())
}

fn percentile(sorted: &[u128], percentile: usize) -> u128 {
    let rank = sorted.len().saturating_mul(percentile).div_ceil(100);
    sorted[rank.saturating_sub(1)]
}
