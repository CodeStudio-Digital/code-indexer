use std::collections::BTreeSet;
use std::error::Error;
use std::ffi::OsString;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;

use agent_protocol::generated::v1 as wire;
use prost::Message;

use crate::control::RunnerExecutionSeed;
use crate::provider_context::ProviderContextMaterial;

const SCHEMA_ID: &str = "codestudio.agent.v1.CodexAppServerProcessSnapshotV1";
const SCHEMA_VERSION: u32 = 1;
const PROVIDER: &str = "codex_app_server";
const PROTOCOL: &str = "app-server-v2-experimental-tools";
const MAX_TEXT_BYTES: usize = 32 * 1_024;
const MAX_ENVIRONMENT_ENTRIES: usize = 32;
const MAX_ENVIRONMENT_BYTES: usize = 64 * 1_024;
const ALLOWED_ENVIRONMENT: &[&str] = &[
    "APPDATA",
    "CODEX_HOME",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];

#[derive(Debug)]
pub struct CodexAppServerProcessConfig {
    pub candidate_version: String,
    pub _protocol_version: String,
    pub _protocol_schema_sha256: [u8; 32],
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalEngineConfigError {
    AmbiguousProvider,
    MissingSnapshot,
    SnapshotContract,
    MissingMaterial,
    MalformedSnapshot,
    NonCanonicalSnapshot,
    InvalidIdentity,
    InvalidPath,
    InvalidEnvironment,
}

pub fn codex_app_server_config(
    seed: &RunnerExecutionSeed,
    material: &impl ProviderContextMaterial,
) -> Result<Option<CodexAppServerProcessConfig>, ExternalEngineConfigError> {
    let spec = seed.as_wire();
    let selected = spec
        .provider_binding
        .as_ref()
        .is_some_and(|binding| binding.effective_provider == PROVIDER);
    let reference = spec.codex_app_server_process_snapshot.as_ref();
    match (selected, reference) {
        (false, None) => return Ok(None),
        (false, Some(_)) => return Err(ExternalEngineConfigError::AmbiguousProvider),
        (true, None) => return Err(ExternalEngineConfigError::MissingSnapshot),
        (true, Some(_)) => {}
    }
    let reference = reference.expect("matched present snapshot");
    if reference.schema_id != SCHEMA_ID || reference.schema_version != SCHEMA_VERSION {
        return Err(ExternalEngineConfigError::SnapshotContract);
    }
    let bytes = material
        .snapshot_payload(reference)
        .ok_or(ExternalEngineConfigError::MissingMaterial)?;
    let value = wire::CodexAppServerProcessSnapshotV1::decode(bytes)
        .map_err(|_| ExternalEngineConfigError::MalformedSnapshot)?;
    if value.encode_to_vec() != bytes {
        return Err(ExternalEngineConfigError::NonCanonicalSnapshot);
    }
    validate(value)
}

fn validate(
    value: wire::CodexAppServerProcessSnapshotV1,
) -> Result<Option<CodexAppServerProcessConfig>, ExternalEngineConfigError> {
    if value.schema_version != SCHEMA_VERSION
        || value.candidate_version.is_empty()
        || value.candidate_version.len() > 256
        || value.candidate_version.contains('\0')
        || value.protocol_version != PROTOCOL
        || value.protocol_schema_sha256.len() != 32
    {
        return Err(ExternalEngineConfigError::InvalidIdentity);
    }
    let executable = bounded_absolute_path(value.executable)?;
    let working_directory = bounded_absolute_path(value.working_directory)?;
    let environment = validate_environment(value.environment)?;
    Ok(Some(CodexAppServerProcessConfig {
        candidate_version: value.candidate_version,
        _protocol_version: value.protocol_version,
        _protocol_schema_sha256: value
            .protocol_schema_sha256
            .try_into()
            .map_err(|_| ExternalEngineConfigError::InvalidIdentity)?,
        executable,
        working_directory,
        environment,
    }))
}

fn bounded_absolute_path(value: String) -> Result<PathBuf, ExternalEngineConfigError> {
    if value.is_empty() || value.len() > MAX_TEXT_BYTES || value.contains('\0') {
        return Err(ExternalEngineConfigError::InvalidPath);
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(ExternalEngineConfigError::InvalidPath);
    }
    Ok(path)
}

fn validate_environment(
    values: Vec<wire::ProcessEnvironmentVariable>,
) -> Result<Vec<(OsString, OsString)>, ExternalEngineConfigError> {
    if values.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(ExternalEngineConfigError::InvalidEnvironment);
    }
    let mut names = BTreeSet::new();
    let mut bytes = 0_usize;
    let mut result = Vec::with_capacity(values.len());
    for item in values {
        let canonical = item.name.to_ascii_uppercase();
        bytes = bytes
            .checked_add(item.name.len())
            .and_then(|total| total.checked_add(item.value.len()))
            .ok_or(ExternalEngineConfigError::InvalidEnvironment)?;
        if item.name.is_empty()
            || item.name.contains(['\0', '='])
            || item.value.contains('\0')
            || bytes > MAX_ENVIRONMENT_BYTES
            || !ALLOWED_ENVIRONMENT.contains(&canonical.as_str())
            || !names.insert(canonical)
        {
            return Err(ExternalEngineConfigError::InvalidEnvironment);
        }
        result.push((item.name.into(), item.value.into()));
    }
    if !names.contains("SYSTEMROOT") {
        return Err(ExternalEngineConfigError::InvalidEnvironment);
    }
    Ok(result)
}

impl Display for ExternalEngineConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid external engine configuration: {self:?}")
    }
}

impl Error for ExternalEngineConfigError {}
