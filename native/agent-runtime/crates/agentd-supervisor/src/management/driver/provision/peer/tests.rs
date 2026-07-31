use super::{ProtectedLaunchPeerAuthority, ProtectedLaunchPeerAuthorityError};

#[test]
fn peer_authority_rejects_non_physical_process_identity() {
    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(0, 2, UNIX_USER_ID, UNIX_USER_ID),
        Err(ProtectedLaunchPeerAuthorityError::ZeroProcessId)
    );
    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(7, 7, UNIX_USER_ID, UNIX_USER_ID),
        Err(ProtectedLaunchPeerAuthorityError::DuplicateProcessId)
    );
}

#[test]
fn peer_authority_requires_complete_platform_identity() {
    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(1, 2, Some(1_000), None),
        Err(ProtectedLaunchPeerAuthorityError::IncompleteUnixIdentity)
    );

    #[cfg(windows)]
    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(1, 2, Some(1_000), Some(1_000)),
        Err(ProtectedLaunchPeerAuthorityError::UnexpectedUnixIdentity)
    );

    #[cfg(unix)]
    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(1, 2, None, None),
        Err(ProtectedLaunchPeerAuthorityError::MissingUnixIdentity)
    );
}

#[test]
fn peer_authority_requires_the_physical_supervisor_process() {
    let supervisor_process_id = std::process::id();
    let wrong_supervisor_process_id = distinct_process_id(&[supervisor_process_id]);
    let host_process_id =
        distinct_process_id(&[supervisor_process_id, wrong_supervisor_process_id]);

    assert_eq!(
        ProtectedLaunchPeerAuthority::new_for_test(
            host_process_id,
            wrong_supervisor_process_id,
            UNIX_USER_ID,
            UNIX_USER_ID,
        ),
        Err(ProtectedLaunchPeerAuthorityError::SupervisorProcessIdMismatch)
    );
}

#[test]
fn peer_authority_keeps_expected_peers_explicit_but_redacts_debug() {
    let supervisor_process_id = std::process::id();
    let host_process_id = distinct_process_id(&[supervisor_process_id]);
    let authority = ProtectedLaunchPeerAuthority::new_for_test(
        host_process_id,
        supervisor_process_id,
        UNIX_USER_ID,
        UNIX_USER_ID,
    )
    .expect("valid");

    assert_eq!(authority.expected_host_peer().process_id, host_process_id);
    assert_eq!(
        authority.expected_supervisor_peer().process_id,
        supervisor_process_id
    );
    let debug = format!("{authority:?}");
    assert!(!debug.contains(&host_process_id.to_string()));
    assert!(!debug.contains(&supervisor_process_id.to_string()));
    assert!(debug.contains("[REDACTED]"));
}

fn distinct_process_id(excluded: &[u32]) -> u32 {
    (1..=u32::MAX)
        .find(|candidate| !excluded.contains(candidate))
        .expect("finite exclusions leave a valid process ID")
}

#[cfg(windows)]
const UNIX_USER_ID: Option<u32> = None;

#[cfg(unix)]
const UNIX_USER_ID: Option<u32> = Some(1_000);
