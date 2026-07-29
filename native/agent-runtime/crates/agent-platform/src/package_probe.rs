//! Side-effect-free readiness probe for installed release artifacts.
//!
//! This mode never creates runtime authority. It exists only so packaging CI
//! can prove that the exact installed binaries start from a read-only tree and
//! remain killable. Normal execution stays fail-closed until bootstrap owns
//! the required handles.

use std::ffi::OsString;
use std::io::{self, Read, Write};

use zeroize::Zeroize;

const COMMAND: &str = "--package-smoke";
const TOKEN_ENV: &str = "CODESTUDIO_AGENT_PACKAGE_SMOKE_TOKEN";
const TOKEN_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageBinaryRole {
    Runner,
    Supervisor,
}

impl PackageBinaryRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Runner => "runner",
            Self::Supervisor => "supervisor",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageProbeDispatch {
    NotRequested,
    Completed,
    Rejected,
}

/// Runs the package-only probe when the exact diagnostic flag is present.
#[must_use]
pub fn dispatch_current_process(role: PackageBinaryRole) -> PackageProbeDispatch {
    let arguments = std::env::args_os();
    let token = std::env::var_os(TOKEN_ENV);
    dispatch(
        role,
        arguments,
        token,
        io::stdin().lock(),
        io::stdout().lock(),
    )
}

fn dispatch<I, R, W>(
    role: PackageBinaryRole,
    arguments: I,
    token: Option<OsString>,
    mut reader: R,
    mut writer: W,
) -> PackageProbeDispatch
where
    I: IntoIterator<Item = OsString>,
    R: Read,
    W: Write,
{
    let mut arguments = arguments.into_iter();
    let _program = arguments.next();
    let Some(command) = arguments.next() else {
        return PackageProbeDispatch::NotRequested;
    };
    if command != COMMAND {
        return PackageProbeDispatch::NotRequested;
    }
    if arguments.next().is_some() {
        return PackageProbeDispatch::Rejected;
    }
    let Some(mut token) = token.and_then(|value| value.into_string().ok()) else {
        return PackageProbeDispatch::Rejected;
    };
    let valid_token = token.len() == TOKEN_BYTES
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    token.zeroize();
    if !valid_token {
        return PackageProbeDispatch::Rejected;
    }
    if writeln!(
        writer,
        "CODESTUDIO_AGENT_PACKAGE_READY_V1 role={} pid={}",
        role.as_str(),
        std::process::id(),
    )
    .and_then(|()| writer.flush())
    .is_err()
    {
        return PackageProbeDispatch::Rejected;
    }

    let mut unexpected = [0_u8; 1];
    match reader.read(&mut unexpected) {
        Ok(0) => PackageProbeDispatch::Completed,
        Ok(_) | Err(_) => PackageProbeDispatch::Rejected,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn exact_probe_reports_role_and_completes_on_eof() {
        let mut output = Vec::new();
        let result = dispatch(
            PackageBinaryRole::Runner,
            arguments(&["agent-runner", COMMAND]),
            Some(OsString::from("a".repeat(TOKEN_BYTES))),
            Cursor::new(Vec::<u8>::new()),
            &mut output,
        );
        assert_eq!(result, PackageProbeDispatch::Completed);
        let output = String::from_utf8(output).expect("utf8");
        assert!(output.starts_with("CODESTUDIO_AGENT_PACKAGE_READY_V1 role=runner pid="));
    }

    #[test]
    fn missing_or_invalid_authority_rejects_probe() {
        let args = arguments(&["agentd-supervisor", COMMAND]);
        assert_eq!(
            dispatch(
                PackageBinaryRole::Supervisor,
                args.clone(),
                None,
                Cursor::new(Vec::<u8>::new()),
                Vec::new(),
            ),
            PackageProbeDispatch::Rejected,
        );
        assert_eq!(
            dispatch(
                PackageBinaryRole::Supervisor,
                args,
                Some(OsString::from("A".repeat(TOKEN_BYTES))),
                Cursor::new(Vec::<u8>::new()),
                Vec::new(),
            ),
            PackageProbeDispatch::Rejected,
        );
    }

    #[test]
    fn normal_or_ambiguous_invocation_never_enters_probe() {
        assert_eq!(
            dispatch(
                PackageBinaryRole::Runner,
                arguments(&["agent-runner"]),
                None,
                Cursor::new(Vec::<u8>::new()),
                Vec::new(),
            ),
            PackageProbeDispatch::NotRequested,
        );
        assert_eq!(
            dispatch(
                PackageBinaryRole::Runner,
                arguments(&["agent-runner", COMMAND, "extra"]),
                Some(OsString::from("a".repeat(TOKEN_BYTES))),
                Cursor::new(Vec::<u8>::new()),
                Vec::new(),
            ),
            PackageProbeDispatch::Rejected,
        );
    }
}
