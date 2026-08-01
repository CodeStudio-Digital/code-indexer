use std::process::ExitCode;
use std::time::Duration;

#[cfg(windows)]
fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        None | Some("materialize") => agent_runner::process::run_inherited_windows()
            .map_or_else(|_| ExitCode::from(70), |never| match never {}),
        Some("hold") => {
            std::thread::sleep(Duration::from_secs(2));
            ExitCode::SUCCESS
        }
        Some(_) => ExitCode::from(64),
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    let _ = Duration::ZERO;
    ExitCode::from(78)
}
