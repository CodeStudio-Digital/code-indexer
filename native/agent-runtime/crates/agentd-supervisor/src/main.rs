use agent_platform::package_probe::{
    PackageBinaryRole, PackageProbeDispatch, dispatch_current_process,
};
use std::process::ExitCode;

fn main() -> ExitCode {
    match dispatch_current_process(PackageBinaryRole::Supervisor) {
        PackageProbeDispatch::NotRequested => ExitCode::from(agentd_supervisor::SCAFFOLD_EXIT_CODE),
        PackageProbeDispatch::Completed => ExitCode::SUCCESS,
        PackageProbeDispatch::Rejected => ExitCode::from(64),
    }
}
