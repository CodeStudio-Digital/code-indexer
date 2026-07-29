use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use crate::containment::ContainedLaunch;

use super::{WindowsContainmentError, environment};

const BACKSLASH: u16 = b'\\' as u16;
const DOUBLE_QUOTE: u16 = b'"' as u16;
pub(super) const MAX_COMMAND_LINE_UNITS: usize = 32_767;

#[derive(Debug)]
pub(super) struct PreparedLaunch {
    pub application: Vec<u16>,
    pub command_line: Vec<u16>,
    pub working_directory: Vec<u16>,
    pub environment: Vec<u16>,
}

impl PreparedLaunch {
    pub(super) fn new(launch: &ContainedLaunch) -> Result<Self, WindowsContainmentError> {
        if !launch.executable.is_absolute() {
            return Err(WindowsContainmentError::InvalidLaunch(
                "executable must be absolute",
            ));
        }
        if !launch.working_directory.is_absolute() {
            return Err(WindowsContainmentError::InvalidLaunch(
                "working directory must be absolute",
            ));
        }

        // Size the bounded buffers before allocating any encoded launch field.
        let command_line = command_line(launch)?;
        let environment = environment::block(&launch.environment)?;
        let application = wide_nul(launch.executable.as_os_str(), "executable contains NUL")?;
        let working_directory = wide_nul(
            launch.working_directory.as_os_str(),
            "working directory contains NUL",
        )?;

        Ok(Self {
            application,
            command_line,
            working_directory,
            environment,
        })
    }
}

fn command_line(launch: &ContainedLaunch) -> Result<Vec<u16>, WindowsContainmentError> {
    let mut units = quoted_length(launch.executable.as_os_str())?;
    for argument in &launch.arguments {
        let argument_units = quoted_length(argument)?;
        units = units
            .checked_add(1)
            .and_then(|value| value.checked_add(argument_units))
            .ok_or(WindowsContainmentError::LimitOverflow("command line"))?;
    }
    units = units
        .checked_add(1)
        .ok_or(WindowsContainmentError::LimitOverflow("command line"))?;
    if units > MAX_COMMAND_LINE_UNITS {
        return Err(WindowsContainmentError::CommandLineTooLong {
            units,
            maximum: MAX_COMMAND_LINE_UNITS,
        });
    }

    let mut result = Vec::with_capacity(units);
    push_quoted(launch.executable.as_os_str(), &mut result);
    for argument in &launch.arguments {
        result.push(u16::from(b' '));
        push_quoted(argument, &mut result);
    }
    result.push(0);
    debug_assert_eq!(result.len(), units);
    Ok(result)
}

fn quoted_length(argument: &OsStr) -> Result<usize, WindowsContainmentError> {
    let mut units = 1_usize;
    let mut backslashes = 0_usize;
    for unit in argument.encode_wide() {
        if unit == 0 {
            return Err(WindowsContainmentError::InvalidLaunch(
                "argument contains NUL",
            ));
        }
        if unit == BACKSLASH {
            backslashes = backslashes
                .checked_add(1)
                .ok_or(WindowsContainmentError::LimitOverflow("command line"))?;
            continue;
        }
        let emitted = if unit == DOUBLE_QUOTE {
            backslashes
                .checked_mul(2)
                .and_then(|value| value.checked_add(2))
        } else {
            backslashes.checked_add(1)
        }
        .ok_or(WindowsContainmentError::LimitOverflow("command line"))?;
        units = units
            .checked_add(emitted)
            .ok_or(WindowsContainmentError::LimitOverflow("command line"))?;
        backslashes = 0;
    }
    units
        .checked_add(
            backslashes
                .checked_mul(2)
                .and_then(|value| value.checked_add(1))
                .ok_or(WindowsContainmentError::LimitOverflow("command line"))?,
        )
        .ok_or(WindowsContainmentError::LimitOverflow("command line"))
}

fn push_quoted(argument: &OsStr, output: &mut Vec<u16>) {
    output.push(DOUBLE_QUOTE);
    let mut backslashes = 0;
    for unit in argument.encode_wide() {
        if unit == BACKSLASH {
            backslashes += 1;
        } else if unit == DOUBLE_QUOTE {
            output.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2 + 1));
            output.push(DOUBLE_QUOTE);
            backslashes = 0;
        } else {
            output.extend(std::iter::repeat_n(BACKSLASH, backslashes));
            output.push(unit);
            backslashes = 0;
        }
    }
    output.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2));
    output.push(DOUBLE_QUOTE);
}

fn wide_nul(value: &OsStr, reason: &'static str) -> Result<Vec<u16>, WindowsContainmentError> {
    let mut units = 1_usize;
    for unit in value.encode_wide() {
        if unit == 0 {
            return Err(WindowsContainmentError::InvalidLaunch(reason));
        }
        units = units
            .checked_add(1)
            .ok_or(WindowsContainmentError::LimitOverflow("launch path"))?;
    }
    if units > MAX_COMMAND_LINE_UNITS {
        return Err(WindowsContainmentError::InvalidLaunch(
            "launch path exceeds Windows UTF-16 limit",
        ));
    }
    let mut wide = Vec::with_capacity(units);
    wide.extend(value.encode_wide());
    wide.push(0);
    Ok(wide)
}
