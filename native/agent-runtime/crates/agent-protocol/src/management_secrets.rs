use zeroize::Zeroize;

use crate::generated::v1 as wire;

pub const fn contains_protected_material(body: &wire::management_payload::Body) -> bool {
    matches!(
        body,
        wire::management_payload::Body::HostSupervisorHello(_)
            | wire::management_payload::Body::SupervisorHello(_)
            | wire::management_payload::Body::LaunchAttemptProcess(_)
    )
}

pub fn scrub_protected_body(body: &mut wire::management_payload::Body) {
    match body {
        wire::management_payload::Body::HostSupervisorHello(value) => {
            value.management_session_token.as_mut_slice().zeroize();
        }
        wire::management_payload::Body::SupervisorHello(value) => {
            value.launch_nonce.as_mut_slice().zeroize();
        }
        wire::management_payload::Body::LaunchAttemptProcess(value) => {
            value.launch_nonce.as_mut_slice().zeroize();
            for endpoint in &mut value.protected_endpoints {
                endpoint.connection_token.as_mut_slice().zeroize();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::scrub_protected_body;
    use crate::generated::v1 as wire;

    #[test]
    fn scrub_clears_launch_and_bootstrap_material() {
        let mut launch =
            wire::management_payload::Body::LaunchAttemptProcess(wire::LaunchAttemptProcess {
                launch_nonce: vec![1, 2],
                protected_endpoints: vec![wire::ProtectedAttemptEndpoint {
                    connection_token: vec![3, 4],
                    ..Default::default()
                }],
                ..Default::default()
            });
        let mut host =
            wire::management_payload::Body::HostSupervisorHello(wire::HostSupervisorHello {
                management_session_token: vec![5, 6],
                ..Default::default()
            });
        let mut supervisor =
            wire::management_payload::Body::SupervisorHello(wire::SupervisorHello {
                launch_nonce: vec![7, 8],
                ..Default::default()
            });

        scrub_protected_body(&mut launch);
        scrub_protected_body(&mut host);
        scrub_protected_body(&mut supervisor);

        assert_launch_scrubbed(launch);
        assert_host_scrubbed(host);
        assert_supervisor_scrubbed(supervisor);
    }

    fn assert_launch_scrubbed(body: wire::management_payload::Body) {
        let wire::management_payload::Body::LaunchAttemptProcess(value) = body else {
            panic!("launch body");
        };
        assert_eq!(value.launch_nonce, [0, 0]);
        assert_eq!(value.protected_endpoints[0].connection_token, [0, 0]);
    }

    fn assert_host_scrubbed(body: wire::management_payload::Body) {
        let wire::management_payload::Body::HostSupervisorHello(value) = body else {
            panic!("host hello");
        };
        assert_eq!(value.management_session_token, [0, 0]);
    }

    fn assert_supervisor_scrubbed(body: wire::management_payload::Body) {
        let wire::management_payload::Body::SupervisorHello(value) = body else {
            panic!("supervisor hello");
        };
        assert_eq!(value.launch_nonce, [0, 0]);
    }
}
