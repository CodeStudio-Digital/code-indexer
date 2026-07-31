use agent_platform::package_probe::{
    PackageBinaryRole, PackageProbeDispatch, dispatch_current_process,
};
use std::process::ExitCode;

fn main() -> ExitCode {
    match dispatch_current_process(PackageBinaryRole::Supervisor) {
        PackageProbeDispatch::NotRequested => run_process(),
        PackageProbeDispatch::Completed => ExitCode::SUCCESS,
        PackageProbeDispatch::Rejected => ExitCode::from(64),
    }
}

#[cfg(windows)]
fn run_process() -> ExitCode {
    agentd_supervisor::process::run_inherited_windows().map_or_else(
        |_| ExitCode::from(agentd_supervisor::SCAFFOLD_EXIT_CODE),
        |()| ExitCode::SUCCESS,
    )
}

#[cfg(not(windows))]
fn run_process() -> ExitCode {
    ExitCode::from(agentd_supervisor::SCAFFOLD_EXIT_CODE)
}
