use std::cmp::Ordering;
use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;

use super::{WindowsContainmentError, sys};

const EQUALS: u16 = b'=' as u16;
/// Conservative compatibility cap for the complete Unicode environment block.
pub(super) const MAX_ENVIRONMENT_UNITS: usize = 32_767;

struct Entry {
    encoded: Vec<u16>,
    name_units: usize,
}

pub(super) fn block(
    variables: &[(OsString, OsString)],
) -> Result<Vec<u16>, WindowsContainmentError> {
    let total_units = block_length(variables)?;
    let mut entries: Vec<Entry> = Vec::with_capacity(variables.len());
    for (name, value) in variables {
        let name_units = validate_name(name)?;
        let value_units = validate_value(value)?;
        let mut encoded = Vec::with_capacity(name_units + value_units + 2);
        encoded.extend(name.encode_wide());
        encoded.push(EQUALS);
        encoded.extend(value.encode_wide());
        encoded.push(0);
        let entry = Entry {
            encoded,
            name_units,
        };
        insert_sorted(&mut entries, entry)?;
    }

    let mut result = Vec::with_capacity(total_units);
    for entry in entries {
        result.extend(entry.encoded);
    }
    result.push(0);
    if variables.is_empty() {
        result.push(0);
    }
    debug_assert_eq!(result.len(), total_units);
    Ok(result)
}

fn insert_sorted(entries: &mut Vec<Entry>, entry: Entry) -> Result<(), WindowsContainmentError> {
    let mut position = entries.len();
    for (index, existing) in entries.iter().enumerate() {
        match sys::compare_ordinal_ignore_case(
            &entry.encoded[..entry.name_units],
            &existing.encoded[..existing.name_units],
        )? {
            Ordering::Less => {
                position = index;
                break;
            }
            Ordering::Equal => {
                return Err(WindowsContainmentError::DuplicateEnvironmentVariable);
            }
            Ordering::Greater => {}
        }
    }
    entries.insert(position, entry);
    Ok(())
}

fn block_length(variables: &[(OsString, OsString)]) -> Result<usize, WindowsContainmentError> {
    let mut units: usize = if variables.is_empty() { 2 } else { 1 };
    for (name, value) in variables {
        let entry_units = validate_name(name)?
            .checked_add(validate_value(value)?)
            .and_then(|value| value.checked_add(2))
            .ok_or(WindowsContainmentError::LimitOverflow("environment"))?;
        units = units
            .checked_add(entry_units)
            .ok_or(WindowsContainmentError::LimitOverflow("environment"))?;
    }
    if units > MAX_ENVIRONMENT_UNITS {
        return Err(WindowsContainmentError::EnvironmentTooLarge {
            units,
            maximum: MAX_ENVIRONMENT_UNITS,
        });
    }
    Ok(units)
}

fn validate_name(name: &OsStr) -> Result<usize, WindowsContainmentError> {
    let mut units = 0_usize;
    for unit in name.encode_wide() {
        if units == 0 && unit == EQUALS {
            return Err(WindowsContainmentError::InvalidLaunch(
                "environment pseudo-variables are unsupported",
            ));
        }
        if unit == 0 || unit == EQUALS {
            return Err(WindowsContainmentError::InvalidLaunch(
                "environment name is invalid",
            ));
        }
        units += 1;
    }
    if units == 0 {
        return Err(WindowsContainmentError::InvalidLaunch(
            "environment name is empty",
        ));
    }
    Ok(units)
}

fn validate_value(value: &OsStr) -> Result<usize, WindowsContainmentError> {
    let mut units = 0_usize;
    for unit in value.encode_wide() {
        if unit == 0 {
            return Err(WindowsContainmentError::InvalidLaunch(
                "environment value contains NUL",
            ));
        }
        units += 1;
    }
    Ok(units)
}
