use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::identity::{EmptyIdentifier, InvalidUuidIdentifier};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireIdentityError {
    MissingField(&'static str),
    InvalidField {
        field: &'static str,
        source: EmptyIdentifier,
    },
    InvalidUuidField {
        field: &'static str,
        source: InvalidUuidIdentifier,
    },
    FieldTooLong {
        field: &'static str,
        length: usize,
        maximum: usize,
    },
    ContainsNul(&'static str),
    ZeroFencingEpoch,
}

impl Display for WireIdentityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField(field) => {
                write!(formatter, "wire identity field {field} is missing")
            }
            Self::InvalidField { field, source } => {
                write!(
                    formatter,
                    "wire identity field {field} is invalid: {source}"
                )
            }
            Self::InvalidUuidField { field, source } => {
                write!(
                    formatter,
                    "wire identity field {field} is invalid: {source}"
                )
            }
            Self::FieldTooLong {
                field,
                length,
                maximum,
            } => write!(
                formatter,
                "wire identity field {field} has {length} bytes; maximum is {maximum}"
            ),
            Self::ContainsNul(field) => {
                write!(formatter, "wire identity field {field} contains NUL")
            }
            Self::ZeroFencingEpoch => {
                formatter.write_str("wire identity fencing epoch must be positive")
            }
        }
    }
}

impl Error for WireIdentityError {}
