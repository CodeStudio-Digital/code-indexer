use agent_platform::package_probe::{
    PackageBinaryRole, PackageProbeDispatch, dispatch_current_process,
};
use std::process::ExitCode;

fn main() -> ExitCode {
    #[cfg(feature = "performance-harness")]
    match agent_runner::performance::dispatch_current_process() {
        agent_runner::performance::PerformanceProbeDispatch::NotRequested => {}
        agent_runner::performance::PerformanceProbeDispatch::Completed => {
            return ExitCode::SUCCESS;
        }
        agent_runner::performance::PerformanceProbeDispatch::Rejected => {
            return ExitCode::from(64);
        }
    }

    match dispatch_current_process(PackageBinaryRole::Runner) {
        PackageProbeDispatch::NotRequested => run_process(),
        PackageProbeDispatch::Completed => ExitCode::SUCCESS,
        PackageProbeDispatch::Rejected => ExitCode::from(64),
    }
}

#[cfg(windows)]
fn run_process() -> ExitCode {
    agent_runner::process::run_inherited_windows().map_or_else(
        |_| ExitCode::from(agent_runner::SCAFFOLD_EXIT_CODE),
        |never| match never {},
    )
}

#[cfg(not(windows))]
const fn run_process() -> ExitCode {
    ExitCode::from(agent_runner::SCAFFOLD_EXIT_CODE)
}
