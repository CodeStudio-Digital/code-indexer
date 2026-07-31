use std::ffi::OsString;
use std::path::PathBuf;

use agent_protocol::supervisor_bootstrap::ValidatedSupervisorProcessHandoff;

use crate::management::{TrustedRunnerConfig, TrustedRunnerConfigError, TrustedRunnerProvenance};

pub(super) fn trusted_runner(
    handoff: &ValidatedSupervisorProcessHandoff,
) -> Result<TrustedRunnerConfig, TrustedRunnerConfigError> {
    let expected = handoff.trusted_runner_provenance();
    let binary_sha256: [u8; 32] = expected
        .binary_sha256
        .as_slice()
        .try_into()
        .map_err(|_| TrustedRunnerConfigError::InvalidProvenance)?;
    let provenance = TrustedRunnerProvenance::new(
        expected.build_id.clone(),
        expected.source_commit.clone(),
        binary_sha256,
        expected.operating_system.clone(),
        expected.architecture.clone(),
    )?;
    let environment = handoff
        .runner_environment()
        .iter()
        .map(|entry| {
            (
                OsString::from(entry.key.as_str()),
                OsString::from(entry.value.as_str()),
            )
        })
        .collect();
    TrustedRunnerConfig::new(
        PathBuf::from(handoff.runner_executable()),
        PathBuf::from(handoff.runner_working_directory()),
        environment,
        provenance,
    )
}
