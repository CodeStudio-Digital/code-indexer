use zeroize::Zeroize;

use crate::generated::v1 as wire;

pub(in crate::runner_bootstrap) struct ScrubbedHandoff(pub wire::RunnerLaunchHandoff);

impl Drop for ScrubbedHandoff {
    fn drop(&mut self) {
        scrub_handoff(&mut self.0);
    }
}

// Prost decodes a repeated message into a temporary and only attaches it to
// the handoff after the nested merge succeeds. This local type must therefore
// scrub itself when UTF-8, wire-type, or truncation errors abandon that value.
impl Drop for wire::RunnerLaunchEndpoint {
    fn drop(&mut self) {
        scrub_endpoint(self);
    }
}

pub(super) fn scrub_handoff(value: &mut wire::RunnerLaunchHandoff) {
    value.launch_nonce.as_mut_slice().zeroize();
    record_scrub(SecretField::LaunchNonce, &value.launch_nonce);
    for endpoint in &mut value.endpoints {
        scrub_endpoint(endpoint);
    }
}

pub(in crate::runner_bootstrap) fn scrub_and_clear_handoff(value: &mut wire::RunnerLaunchHandoff) {
    scrub_handoff(value);
    value.launch_nonce.clear();
    for endpoint in &mut value.endpoints {
        endpoint.connection_token.clear();
    }
}

pub(super) fn scrub_and_clear_endpoint(value: &mut wire::RunnerLaunchEndpoint) {
    scrub_endpoint(value);
    value.connection_token.clear();
}

pub fn scrub_agent_hello(value: &mut wire::AgentHello) {
    value.launch_nonce.as_mut_slice().zeroize();
    record_scrub(SecretField::AgentHelloNonce, &value.launch_nonce);
    value.launch_nonce.clear();
}

pub fn scrub_host_hello(value: &mut wire::HostHello) {
    value.connection_session_token.as_mut_slice().zeroize();
    record_scrub(SecretField::HostHelloToken, &value.connection_session_token);
    value.connection_session_token.clear();
}

fn scrub_endpoint(value: &mut wire::RunnerLaunchEndpoint) {
    value.connection_token.as_mut_slice().zeroize();
    record_scrub(SecretField::EndpointToken, &value.connection_token);
}

#[cfg_attr(test, derive(Clone, Copy, Debug, Eq, PartialEq))]
pub enum SecretField {
    LaunchNonce,
    EndpointToken,
    AgentHelloNonce,
    HostHelloToken,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScrubAudit {
    pub field: SecretField,
    pub length: usize,
    pub all_zero: bool,
}

#[cfg(test)]
std::thread_local! {
    static SCRUB_AUDIT: std::cell::RefCell<Option<Vec<ScrubAudit>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub fn capture_scrub_audit<T>(operation: impl FnOnce() -> T) -> (T, Vec<ScrubAudit>) {
    SCRUB_AUDIT.with(|audit| {
        assert!(audit.borrow().is_none(), "nested scrub audit");
        *audit.borrow_mut() = Some(Vec::new());
    });
    let result = operation();
    let audit = SCRUB_AUDIT.with(|audit| audit.borrow_mut().take().expect("active scrub audit"));
    (result, audit)
}

#[cfg(test)]
fn record_scrub(field: SecretField, bytes: &[u8]) {
    SCRUB_AUDIT.with(|audit| {
        if let Some(audit) = audit.borrow_mut().as_mut() {
            audit.push(ScrubAudit {
                field,
                length: bytes.len(),
                all_zero: bytes.iter().all(|byte| *byte == 0),
            });
        }
    });
}

#[cfg(not(test))]
const fn record_scrub(_field: SecretField, _bytes: &[u8]) {}
