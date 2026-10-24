use napi::{Error, Result, Status};
use napi_derive::napi;

/// Synchronous dispatch preserves the Host's invocation fence at the physical
/// boundary. Parent and source handles remain pinned through the rename.
/// # Errors
/// Fails closed on unsupported platforms, root escapes and existing targets.
#[napi]
pub fn rename_native_path_no_replace(
    root: String,
    source: String,
    destination: String,
) -> Result<()> {
    #[cfg(windows)]
    {
        let root = std::path::PathBuf::from(root);
        let source = std::path::PathBuf::from(source);
        let destination = std::path::PathBuf::from(destination);
        agent_host_bridge::rename_path_no_replace(&root, &source, &destination)
            .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = (root, source, destination);
        Err(Error::new(
            Status::GenericFailure,
            "exclusive native rename requires Windows",
        ))
    }
}
