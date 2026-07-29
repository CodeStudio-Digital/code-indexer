use std::process::ExitCode;

#[cfg(windows)]
fn main() -> ExitCode {
    loop {
        std::thread::park();
    }
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    ExitCode::from(78)
}
