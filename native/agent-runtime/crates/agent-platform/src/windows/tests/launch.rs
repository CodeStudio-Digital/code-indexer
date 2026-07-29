use std::ffi::OsString;
use std::path::PathBuf;

use crate::containment::ContainedLaunch;

use super::super::WindowsContainmentError;
use super::super::environment;
use super::super::launch::{MAX_COMMAND_LINE_UNITS, PreparedLaunch};

fn launch(arguments: Vec<OsString>, environment: Vec<(OsString, OsString)>) -> ContainedLaunch {
    ContainedLaunch {
        executable: PathBuf::from(r"C:\agent.exe"),
        arguments,
        working_directory: PathBuf::from(r"C:\work"),
        environment,
    }
}

fn command_text(prepared: &PreparedLaunch) -> String {
    String::from_utf16(&prepared.command_line[..prepared.command_line.len() - 1])
        .expect("valid test command line")
}

#[test]
fn quotes_empty_trailing_slash_embedded_quote_and_unicode_arguments() {
    let prepared = PreparedLaunch::new(&launch(
        vec![
            OsString::from(""),
            OsString::from("alpha beta"),
            OsString::from("trailing\\"),
            OsString::from("a\"b"),
            OsString::from("ação 東京"),
        ],
        Vec::new(),
    ))
    .expect("prepare quoted command");

    assert_eq!(
        command_text(&prepared),
        r#""C:\agent.exe" "" "alpha beta" "trailing\\" "a\"b" "ação 東京""#
    );
}

#[test]
fn rejects_command_line_before_exceeding_windows_utf16_cap() {
    let oversized = OsString::from("x".repeat(MAX_COMMAND_LINE_UNITS));
    let error = PreparedLaunch::new(&launch(vec![oversized], Vec::new()))
        .expect_err("oversized command must fail");

    assert!(matches!(
        error,
        WindowsContainmentError::CommandLineTooLong {
            maximum: MAX_COMMAND_LINE_UNITS,
            ..
        }
    ));
}

#[test]
fn environment_is_double_nul_terminated_and_ordinally_sorted() {
    let prepared = PreparedLaunch::new(&launch(
        Vec::new(),
        vec![
            (OsString::from("zeta"), OsString::from("東京")),
            (OsString::from("Alpha"), OsString::from("ação")),
        ],
    ))
    .expect("prepare environment");
    let text = String::from_utf16(&prepared.environment).expect("valid environment");

    assert_eq!(text, "Alpha=ação\0zeta=東京\0\0");
    assert_eq!(
        environment::block(&[]).expect("empty environment"),
        vec![0, 0]
    );
}

#[test]
fn environment_deduplicates_with_windows_ordinal_case_folding() {
    let error = PreparedLaunch::new(&launch(
        Vec::new(),
        vec![
            (OsString::from("ångström"), OsString::from("1")),
            (OsString::from("ÅNGSTRÖM"), OsString::from("2")),
        ],
    ))
    .expect_err("case-insensitive duplicate must fail");

    assert!(matches!(
        error,
        WindowsContainmentError::DuplicateEnvironmentVariable
    ));
}

#[test]
fn pseudo_variables_and_oversized_environment_are_rejected() {
    let pseudo = PreparedLaunch::new(&launch(
        Vec::new(),
        vec![(OsString::from("=C:"), OsString::from(r"C:\work"))],
    ))
    .expect_err("pseudo variable is outside the supported contract");
    assert!(matches!(
        pseudo,
        WindowsContainmentError::InvalidLaunch("environment pseudo-variables are unsupported")
    ));

    let oversized = PreparedLaunch::new(&launch(
        Vec::new(),
        vec![(
            OsString::from("VALUE"),
            OsString::from("x".repeat(environment::MAX_ENVIRONMENT_UNITS)),
        )],
    ))
    .expect_err("oversized environment must fail");
    assert!(matches!(
        oversized,
        WindowsContainmentError::EnvironmentTooLarge {
            maximum: environment::MAX_ENVIRONMENT_UNITS,
            ..
        }
    ));
}
