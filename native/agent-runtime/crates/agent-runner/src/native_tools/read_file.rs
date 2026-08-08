use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::time::Instant;

use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityExecutorPort, CapabilityFailure, CapabilityInvocation,
    CapabilityOutput, ExecutionClass, SealedExecutionGrant,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const RESULT_SCHEMA_ID: &str = "codestudio.agent.native-read-file-result.v1";
const RESULT_OVERHEAD_RESERVE: u64 = 1_024;
const MAX_NATIVE_READ_BYTES: u64 = 64 * 1_024 * 1_024;

#[derive(Debug, Default)]
pub struct NativeToolExecutor;

#[derive(Debug)]
pub enum NativeToolExecutorError {
    Worker(tokio::task::JoinError),
}

impl Display for NativeToolExecutorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Worker(error) => write!(formatter, "native tool worker failed: {error}"),
        }
    }
}

impl std::error::Error for NativeToolExecutorError {}

impl CapabilityExecutorPort for NativeToolExecutor {
    type Error = NativeToolExecutorError;

    async fn execute(
        &mut self,
        invocation: &CapabilityInvocation,
        grant: &SealedExecutionGrant,
    ) -> Result<CapabilityExecutionOutcome, Self::Error> {
        let started = Instant::now();
        let request = match validate_request(invocation, grant) {
            Ok(request) => request,
            Err(reason_code) => return Ok(failed(reason_code, started)),
        };
        tokio::task::spawn_blocking(move || execute_read(&request, started))
            .await
            .map_err(NativeToolExecutorError::Worker)
    }
}

struct ReadRequest {
    root: PathBuf,
    relative: PathBuf,
    offset: u64,
    limit: usize,
    require_utf8: bool,
    max_output_bytes: usize,
}

fn validate_request(
    invocation: &CapabilityInvocation,
    grant: &SealedExecutionGrant,
) -> Result<ReadRequest, &'static str> {
    if grant.effective_input_sha256 != invocation.input_sha256 {
        return Err("grant_authority_mismatch");
    }
    if invocation.capability_id != "native.read_file"
        || invocation.execution_class != ExecutionClass::NativeRead
        || invocation.mutates
        || grant.capability_id != invocation.capability_id
        || grant.capability_version != invocation.capability_version
        || grant.operation_id != invocation.operation_id
        || grant.tool_use_id != invocation.tool_use_id
        || grant.execution_class != invocation.execution_class
        || grant.mutates
    {
        return Err("grant_authority_mismatch");
    }
    let binding = grant
        .native_filesystem_read
        .as_ref()
        .ok_or("missing_native_read_binding")?;
    if !Path::new(binding.canonical_root_path.as_str()).is_absolute()
        || binding.max_read_bytes == 0
        || binding.max_read_bytes > MAX_NATIVE_READ_BYTES
        || binding.max_output_bytes == 0
        || binding.max_output_bytes > MAX_NATIVE_READ_BYTES
    {
        return Err("invalid_native_read_binding");
    }
    let (relative, offset, requested) = parse_input(&invocation.encoded_json_input)?;
    let content_limit = requested
        .unwrap_or(binding.max_read_bytes)
        .min(binding.max_read_bytes)
        .min(
            binding
                .max_output_bytes
                .saturating_sub(RESULT_OVERHEAD_RESERVE),
        );
    let limit = usize::try_from(content_limit).map_err(|_| "read_limit_overflow")?;
    let max_output_bytes =
        usize::try_from(binding.max_output_bytes).map_err(|_| "output_limit_overflow")?;
    if limit == 0 || max_output_bytes == 0 {
        return Err("read_limit_exceeded");
    }
    Ok(ReadRequest {
        root: PathBuf::from(binding.canonical_root_path.as_str()),
        relative,
        offset,
        limit,
        require_utf8: binding.require_utf8,
        max_output_bytes,
    })
}

fn parse_input(encoded: &[u8]) -> Result<(PathBuf, u64, Option<u64>), &'static str> {
    let Value::Object(mut value) = serde_json::from_slice(encoded).map_err(|_| "invalid_input")?
    else {
        return Err("invalid_input");
    };
    if value
        .keys()
        .any(|key| !matches!(key.as_str(), "path" | "offset" | "length"))
    {
        return Err("invalid_input");
    }
    let path = value
        .remove("path")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .ok_or("invalid_input")?;
    if path.is_empty() || path.len() > 32_768 || path.contains('\0') {
        return Err("invalid_input");
    }
    let offset = optional_u64(value.remove("offset"))?.unwrap_or(0);
    let length = optional_u64(value.remove("length"))?;
    if length == Some(0) {
        return Err("invalid_input");
    }
    Ok((PathBuf::from(path), offset, length))
}

fn optional_u64(value: Option<Value>) -> Result<Option<u64>, &'static str> {
    value
        .map(|value| value.as_u64().ok_or("invalid_input"))
        .transpose()
}

fn execute_read(request: &ReadRequest, started: Instant) -> CapabilityExecutionOutcome {
    #[cfg(windows)]
    let read = agent_platform::windows::filesystem::read_file_within_root(
        &request.root,
        &request.relative,
        request.offset,
        request.limit,
    );
    #[cfg(not(windows))]
    let read = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "native read backend is not implemented for this platform",
    ));
    let read = match read {
        Ok(read) => read,
        Err(error) => return failed(io_reason(&error), started),
    };
    let content = if request.require_utf8 {
        match String::from_utf8(read.content) {
            Ok(content) => content,
            Err(_) => return failed("invalid_utf8", started),
        }
    } else {
        return failed("binary_output_not_supported", started);
    };
    let encoded_result = match serde_json::to_vec(&json!({
        "path": path_text(&request.relative),
        "offset": request.offset,
        "content": content,
        "truncated": read.truncated,
        "eof": read.eof,
    })) {
        Ok(encoded) if encoded.len() <= request.max_output_bytes => encoded,
        _ => return failed("output_limit_exceeded", started),
    };
    let bytes_emitted = u64::try_from(encoded_result.len()).unwrap_or(u64::MAX);
    CapabilityExecutionOutcome::Succeeded(CapabilityOutput {
        schema_id: RESULT_SCHEMA_ID.into(),
        schema_version: 1,
        result_sha256: Sha256::digest(&encoded_result).into(),
        encoded_result,
        bytes_read: read.bytes_read,
        bytes_emitted,
        truncated: read.truncated,
        duration_ms: duration_ms(started),
    })
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn io_reason(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => "not_found",
        ErrorKind::PermissionDenied => "path_outside_binding",
        ErrorKind::InvalidInput => "invalid_input",
        ErrorKind::Unsupported => "platform_unsupported",
        _ => "read_failed",
    }
}

fn failed(reason_code: &str, started: Instant) -> CapabilityExecutionOutcome {
    CapabilityExecutionOutcome::Failed(CapabilityFailure {
        reason_code: reason_code.into(),
        duration_ms: duration_ms(started),
    })
}

fn duration_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(all(test, windows))]
mod tests;
