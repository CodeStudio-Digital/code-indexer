use std::process::ExitCode;
use std::time::Duration;

#[cfg(windows)]
fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        None | Some("materialize") => {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
            else {
                return ExitCode::from(69);
            };
            let _entered = runtime.enter();
            agent_runner::bootstrap::materialize_inherited_windows_bootstrap().map_or_else(
                |_| ExitCode::from(70),
                |materialized| {
                    let _materialized = materialized;
                    loop {
                        std::thread::park();
                    }
                },
            )
        }
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
