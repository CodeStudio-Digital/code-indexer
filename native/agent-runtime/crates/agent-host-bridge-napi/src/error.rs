use napi::{Error, Status};

#[cfg(windows)]
pub fn invalid(message: &'static str) -> Error {
    Error::new(Status::InvalidArg, message)
}

#[cfg(windows)]
pub fn closed() -> Error {
    Error::new(Status::Cancelled, "native Host bridge channels are closed")
}

#[cfg(windows)]
pub fn concurrent(operation: &'static str) -> Error {
    Error::new(
        Status::GenericFailure,
        match operation {
            "read" => "native Host bridge forbids concurrent reads",
            "write" => "native Host bridge forbids concurrent writes",
            _ => "native Host bridge operation is concurrent",
        },
    )
}

#[cfg(not(windows))]
pub fn unsupported() -> Error {
    Error::new(
        Status::GenericFailure,
        "native Host bridge platform is unavailable",
    )
}

pub fn bridge(source: &agent_host_bridge::HostBridgeError) -> Error {
    Error::new(Status::GenericFailure, source.to_string())
}

#[cfg(windows)]
pub fn io(operation: &'static str, source: &std::io::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("native Host bridge {operation} failed: {source}"),
    )
}
