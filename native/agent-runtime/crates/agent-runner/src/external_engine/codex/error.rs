use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug)]
pub enum CodexGatewayError {
    InvalidContext(&'static str),
    InvalidProtocol(&'static str),
    Io(std::io::Error),
    Json(serde_json::Error),
    Spawn(&'static str),
    Rpc { code: i64, message: String },
}

impl Display for CodexGatewayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidContext(reason) => write!(formatter, "invalid Codex context: {reason}"),
            Self::InvalidProtocol(reason) => write!(formatter, "invalid Codex protocol: {reason}"),
            Self::Io(error) => write!(formatter, "Codex I/O failed: {error}"),
            Self::Json(error) => write!(formatter, "Codex JSON failed: {error}"),
            Self::Spawn(reason) => write!(formatter, "Codex spawn failed: {reason}"),
            Self::Rpc { code, message } => {
                write!(formatter, "Codex RPC failed ({code}): {message}")
            }
        }
    }
}

impl Error for CodexGatewayError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for CodexGatewayError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CodexGatewayError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
