use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::super::error::HostSupervisorBridgeError;
use super::super::request::HostSupervisorLaunchPlan;

const MAX_RUNTIME_BINARY_BYTES: u64 = 256 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 64 * 1024;

pub(super) fn verify(plan: &HostSupervisorLaunchPlan) -> Result<(), HostSupervisorBridgeError> {
    if plan.trusted_supervisor.operating_system != "windows"
        || plan.trusted_runner.operating_system != "windows"
        || plan.trusted_supervisor.architecture != std::env::consts::ARCH
        || plan.trusted_runner.architecture != std::env::consts::ARCH
    {
        return Err(HostSupervisorBridgeError::Package("platform mismatch"));
    }
    verify_binary(
        &plan.supervisor_executable,
        "agentd-supervisor.exe",
        &plan.trusted_supervisor.binary_sha256,
    )?;
    verify_binary(
        &plan.runner_executable,
        "agent-runner.exe",
        &plan.trusted_runner.binary_sha256,
    )
}

fn verify_binary(
    path: &Path,
    expected_name: &str,
    expected_digest: &[u8],
) -> Result<(), HostSupervisorBridgeError> {
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_name) {
        return Err(HostSupervisorBridgeError::Package(
            "runtime filename mismatch",
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| HostSupervisorBridgeError::Package("runtime binary unavailable"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_RUNTIME_BINARY_BYTES
    {
        return Err(HostSupervisorBridgeError::Package(
            "runtime binary metadata is unsafe",
        ));
    }
    let file = File::open(path)
        .map_err(|_| HostSupervisorBridgeError::Package("runtime binary cannot be opened"))?;
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES].into_boxed_slice();
    loop {
        let length = reader
            .read(&mut buffer)
            .map_err(|_| HostSupervisorBridgeError::Package("runtime binary cannot be hashed"))?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    if digest.finalize().as_slice() != expected_digest {
        return Err(HostSupervisorBridgeError::Package(
            "runtime binary digest mismatch",
        ));
    }
    Ok(())
}
