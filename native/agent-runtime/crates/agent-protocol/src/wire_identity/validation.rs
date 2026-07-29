use crate::identity::{EmptyIdentifier, InvalidUuidIdentifier, is_canonical_uuid};

use super::{MAX_WIRE_IDENTIFIER_BYTES, WireIdentityError};

pub fn parse_required<T>(
    value: &str,
    field: &'static str,
    constructor: impl FnOnce(&str) -> Result<T, EmptyIdentifier>,
) -> Result<T, WireIdentityError> {
    validate_required_identifier(value, field)?;
    constructor(value).map_err(|source| WireIdentityError::InvalidField { field, source })
}

pub fn parse_optional<T>(
    value: Option<&str>,
    field: &'static str,
    constructor: impl FnOnce(&str) -> Result<T, EmptyIdentifier>,
) -> Result<Option<T>, WireIdentityError> {
    validate_optional_identifier(value, field)?;
    value.map_or_else(
        || Ok(None),
        |value| {
            constructor(value)
                .map(Some)
                .map_err(|source| WireIdentityError::InvalidField { field, source })
        },
    )
}

pub fn parse_required_uuid<T>(
    value: &str,
    field: &'static str,
    constructor: impl FnOnce(&str) -> Result<T, InvalidUuidIdentifier>,
) -> Result<T, WireIdentityError> {
    validate_required_uuid(value, field)?;
    constructor(value).map_err(|source| WireIdentityError::InvalidUuidField { field, source })
}

pub fn parse_optional_uuid<T>(
    value: Option<&str>,
    field: &'static str,
    constructor: impl FnOnce(&str) -> Result<T, InvalidUuidIdentifier>,
) -> Result<Option<T>, WireIdentityError> {
    validate_optional_uuid(value, field)?;
    value.map_or_else(
        || Ok(None),
        |value| {
            constructor(value)
                .map(Some)
                .map_err(|source| WireIdentityError::InvalidUuidField { field, source })
        },
    )
}

pub fn validate_required_identifier(
    value: &str,
    field: &'static str,
) -> Result<(), WireIdentityError> {
    if value.is_empty() {
        return Err(WireIdentityError::MissingField(field));
    }
    bounded(value, field)?;
    if value.trim().is_empty() {
        return Err(WireIdentityError::InvalidField {
            field,
            source: EmptyIdentifier,
        });
    }
    Ok(())
}

pub fn validate_required_uuid(value: &str, field: &'static str) -> Result<(), WireIdentityError> {
    if value.is_empty() {
        return Err(WireIdentityError::MissingField(field));
    }
    bounded(value, field)?;
    if !is_canonical_uuid(value) {
        let source = if value.trim().is_empty() {
            InvalidUuidIdentifier::Empty
        } else {
            InvalidUuidIdentifier::NonCanonical
        };
        return Err(WireIdentityError::InvalidUuidField { field, source });
    }
    Ok(())
}

fn validate_optional_identifier(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), WireIdentityError> {
    if let Some(value) = value {
        validate_required_identifier(value, field).map_err(|error| match error {
            WireIdentityError::MissingField(_) => WireIdentityError::InvalidField {
                field,
                source: EmptyIdentifier,
            },
            other => other,
        })?;
    }
    Ok(())
}

pub fn validate_optional_uuid(
    value: Option<&str>,
    field: &'static str,
) -> Result<(), WireIdentityError> {
    if let Some(value) = value {
        validate_required_uuid(value, field).map_err(|error| match error {
            WireIdentityError::MissingField(_) => WireIdentityError::InvalidUuidField {
                field,
                source: InvalidUuidIdentifier::Empty,
            },
            other => other,
        })?;
    }
    Ok(())
}

fn bounded(value: &str, field: &'static str) -> Result<(), WireIdentityError> {
    if value.contains('\0') {
        return Err(WireIdentityError::ContainsNul(field));
    }
    if value.len() > MAX_WIRE_IDENTIFIER_BYTES {
        return Err(WireIdentityError::FieldTooLong {
            field,
            length: value.len(),
            maximum: MAX_WIRE_IDENTIFIER_BYTES,
        });
    }
    Ok(())
}
