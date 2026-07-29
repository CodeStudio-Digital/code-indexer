use std::cmp::Ordering;

use windows_sys::Win32::Globalization::{
    CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN, CompareStringOrdinal,
};

use super::super::WindowsContainmentError;

pub(in crate::windows) fn compare_ordinal_ignore_case(
    left: &[u16],
    right: &[u16],
) -> Result<Ordering, WindowsContainmentError> {
    let left_len = i32::try_from(left.len())
        .map_err(|_| WindowsContainmentError::LimitOverflow("environment name"))?;
    let right_len = i32::try_from(right.len())
        .map_err(|_| WindowsContainmentError::LimitOverflow("environment name"))?;
    // SAFETY: both slices remain live for their explicit lengths. The API is
    // locale-independent when asked for ordinal, case-insensitive comparison.
    let result =
        unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) };
    match result {
        CSTR_LESS_THAN => Ok(Ordering::Less),
        CSTR_EQUAL => Ok(Ordering::Equal),
        CSTR_GREATER_THAN => Ok(Ordering::Greater),
        _ => Err(WindowsContainmentError::last_os_error(
            "CompareStringOrdinal",
        )),
    }
}
