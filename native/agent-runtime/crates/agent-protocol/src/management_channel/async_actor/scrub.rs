use zeroize::Zeroize;

use crate::generated::v1 as wire;
use crate::management_secrets::scrub_protected_body;

pub(super) struct ScrubbedBytes(Vec<u8>);

impl ScrubbedBytes {
    pub(super) const fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub(super) fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for ScrubbedBytes {
    fn drop(&mut self) {
        self.0.as_mut_slice().zeroize();
    }
}

pub(super) struct ScrubbedManagementPayload(wire::ManagementPayload);

impl ScrubbedManagementPayload {
    pub(super) const fn new(payload: wire::ManagementPayload) -> Self {
        Self(payload)
    }

    pub(super) const fn get(&self) -> &wire::ManagementPayload {
        &self.0
    }
}

impl Drop for ScrubbedManagementPayload {
    fn drop(&mut self) {
        if let Some(body) = &mut self.0.body {
            scrub_protected_body(body);
        }
    }
}
