use super::SpecValidationError;

pub(super) const MAX_SPEC_TEXT_BYTES: usize = 512;

pub(super) fn validate_required_text(
    field: &'static str,
    value: &str,
) -> Result<(), SpecValidationError> {
    validate_text(field, value, MAX_SPEC_TEXT_BYTES)
}

pub(super) fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), SpecValidationError> {
    if let Some(value) = value {
        validate_required_text(field, value)?;
    }
    Ok(())
}

pub(super) fn validate_text(
    field: &'static str,
    value: &str,
    maximum: usize,
) -> Result<(), SpecValidationError> {
    let reason = if value.trim().is_empty() {
        Some("text is empty")
    } else if value.contains('\0') {
        Some("text contains NUL")
    } else if value.len() > maximum {
        Some("text exceeds its byte limit")
    } else {
        None
    };

    if let Some(reason) = reason {
        return Err(SpecValidationError::InvalidText { field, reason });
    }
    Ok(())
}
