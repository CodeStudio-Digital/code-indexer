use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fmt::{self, Debug, Formatter};
use std::path::PathBuf;

use agent_platform::containment::ContainedLaunch;
use agent_protocol::generated::v1 as wire;

const MAX_ENVIRONMENT_ENTRIES: usize = 8;
const ALLOWED_ENVIRONMENT_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "WINDIR",
    "RUST_BACKTRACE",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustedRunnerConfigError {
    ExecutableNotAbsolute,
    WorkingDirectoryNotAbsolute,
    TooManyEnvironmentEntries,
    InvalidEnvironmentKey,
    DuplicateEnvironmentKey,
    EnvironmentContainsNul,
    InvalidProvenance,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TrustedRunnerProvenance {
    build_id: String,
    source_commit: String,
    binary_sha256: [u8; 32],
    operating_system: String,
    architecture: String,
}

impl Debug for TrustedRunnerProvenance {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TrustedRunnerProvenance")
            .field("build_id", &self.build_id)
            .field("source_commit", &self.source_commit)
            .field("binary_sha256", &"[REDACTED]")
            .field("operating_system", &self.operating_system)
            .field("architecture", &self.architecture)
            .finish()
    }
}

impl TrustedRunnerProvenance {
    /// Creates validated provenance for the only runner binary this supervisor
    /// is allowed to launch.
    ///
    /// # Errors
    ///
    /// Returns [`TrustedRunnerConfigError::InvalidProvenance`] when a textual
    /// identity field is empty, oversized, or contains a NUL byte.
    pub fn new(
        build_id: String,
        source_commit: String,
        binary_sha256: [u8; 32],
        operating_system: String,
        architecture: String,
    ) -> Result<Self, TrustedRunnerConfigError> {
        let text = [
            build_id.as_str(),
            source_commit.as_str(),
            operating_system.as_str(),
            architecture.as_str(),
        ];
        if text
            .into_iter()
            .any(|value| value.trim().is_empty() || value.len() > 512 || value.contains('\0'))
        {
            return Err(TrustedRunnerConfigError::InvalidProvenance);
        }
        Ok(Self {
            build_id,
            source_commit,
            binary_sha256,
            operating_system,
            architecture,
        })
    }

    pub(super) fn matches(&self, expected: &wire::ExpectedRuntimeProvenance) -> bool {
        self.build_id == expected.build_id
            && self.source_commit == expected.source_commit
            && self.binary_sha256.as_slice() == expected.binary_sha256
            && self.operating_system == expected.operating_system
            && self.architecture == expected.architecture
    }

    pub(super) fn to_runtime_wire(
        &self,
        runtime_instance_id: &str,
        pid: u32,
    ) -> wire::RuntimeProvenance {
        wire::RuntimeProvenance {
            build_id: self.build_id.clone(),
            source_commit: self.source_commit.clone(),
            binary_sha256: self.binary_sha256.to_vec(),
            runtime_instance_id: runtime_instance_id.to_owned(),
            pid,
            operating_system: self.operating_system.clone(),
            architecture: self.architecture.clone(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TrustedRunnerConfig {
    executable: PathBuf,
    working_directory: PathBuf,
    environment: Vec<(OsString, OsString)>,
    provenance: TrustedRunnerProvenance,
}

impl Debug for TrustedRunnerConfig {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TrustedRunnerConfig")
            .field("executable", &self.executable)
            .field("working_directory", &self.working_directory)
            .field("environment_keys", &self.environment_keys())
            .field("environment", &"[REDACTED]")
            .field("provenance", &self.provenance)
            .finish()
    }
}

impl TrustedRunnerConfig {
    /// Creates the immutable launch configuration for the trusted runner.
    ///
    /// # Errors
    ///
    /// Returns [`TrustedRunnerConfigError`] when either path is not absolute or
    /// the bounded environment violates its allowlist and uniqueness rules.
    pub fn new(
        executable: PathBuf,
        working_directory: PathBuf,
        environment: Vec<(OsString, OsString)>,
        provenance: TrustedRunnerProvenance,
    ) -> Result<Self, TrustedRunnerConfigError> {
        if !executable.is_absolute() {
            return Err(TrustedRunnerConfigError::ExecutableNotAbsolute);
        }
        if !working_directory.is_absolute() {
            return Err(TrustedRunnerConfigError::WorkingDirectoryNotAbsolute);
        }
        validate_environment(&environment)?;
        Ok(Self {
            executable,
            working_directory,
            environment,
            provenance,
        })
    }

    pub(super) fn contained_launch(&self) -> ContainedLaunch {
        ContainedLaunch {
            executable: self.executable.clone(),
            arguments: Vec::new(),
            working_directory: self.working_directory.clone(),
            environment: self.environment.clone(),
        }
    }

    pub(super) const fn provenance(&self) -> &TrustedRunnerProvenance {
        &self.provenance
    }

    fn environment_keys(&self) -> Vec<&OsStr> {
        self.environment
            .iter()
            .map(|(key, _)| key.as_os_str())
            .collect()
    }
}

fn validate_environment(
    environment: &[(OsString, OsString)],
) -> Result<(), TrustedRunnerConfigError> {
    if environment.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(TrustedRunnerConfigError::TooManyEnvironmentEntries);
    }
    let mut keys = BTreeSet::new();
    for (key, value) in environment {
        let Some(key) = key.to_str() else {
            return Err(TrustedRunnerConfigError::InvalidEnvironmentKey);
        };
        let normalized = key.to_ascii_uppercase();
        if !ALLOWED_ENVIRONMENT_KEYS.contains(&normalized.as_str()) {
            return Err(TrustedRunnerConfigError::InvalidEnvironmentKey);
        }
        if !keys.insert(normalized) {
            return Err(TrustedRunnerConfigError::DuplicateEnvironmentKey);
        }
        if value.to_string_lossy().contains('\0') {
            return Err(TrustedRunnerConfigError::EnvironmentContainsNul);
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn absolute_test_path(component: &str) -> PathBuf {
    std::env::current_dir()
        .expect("test current directory is absolute")
        .join(component)
}
