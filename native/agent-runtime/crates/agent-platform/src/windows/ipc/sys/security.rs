use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_GROUPS, TOKEN_QUERY,
    TokenLogonSid,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::ipc::ProtectedEndpointError;

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: both conversion APIs return LocalAlloc ownership exactly
            // once; this wrapper is deliberately not cloneable.
            unsafe { LocalFree(self.0) };
        }
    }
}

pub(in crate::windows) struct PipeSecurity {
    _descriptor: LocalAllocation,
    attributes: SECURITY_ATTRIBUTES,
}

impl PipeSecurity {
    pub(in crate::windows) fn for_current_logon() -> Result<Self, ProtectedEndpointError> {
        let sddl = current_logon_acl_sddl()?;
        let mut encoded: Vec<u16> = sddl.encode_utf16().collect();
        encoded.push(0);
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `encoded` is NUL-terminated and both output pointers are
        // writable for the call.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                encoded.as_ptr(),
                SDDL_REVISION_1,
                ptr::from_mut(&mut descriptor),
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(ProtectedEndpointError::last_os_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        let descriptor = LocalAllocation(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
                .map_err(|_| ProtectedEndpointError::InvalidAddress("SECURITY_ATTRIBUTES"))?,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        Ok(Self {
            _descriptor: descriptor,
            attributes,
        })
    }

    pub(in crate::windows) const fn attributes_mut_ptr(&mut self) -> *mut c_void {
        ptr::from_mut(&mut self.attributes).cast()
    }
}

pub(in crate::windows::ipc) fn current_logon_acl_sddl() -> Result<String, ProtectedEndpointError> {
    let token = current_process_token()?;
    let required = token_information_size(&token)?;
    let words = usize::try_from(required)
        .map_err(|_| ProtectedEndpointError::InvalidPeer)?
        .div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut written = required;
    // SAFETY: aligned storage has at least the requested byte length and the
    // token remains live.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenLogonSid,
            storage.as_mut_ptr().cast(),
            required,
            &raw mut written,
        )
    } == 0
    {
        return Err(ProtectedEndpointError::last_os_error(
            "GetTokenInformation(TokenLogonSid)",
        ));
    }
    if written > required {
        return Err(ProtectedEndpointError::InvalidPeer);
    }
    // SAFETY: successful TokenLogonSid returns TOKEN_GROUPS in the validated,
    // aligned output buffer.
    let groups = unsafe { &*storage.as_ptr().cast::<TOKEN_GROUPS>() };
    if groups.GroupCount != 1 || groups.Groups[0].Sid.is_null() {
        return Err(ProtectedEndpointError::InvalidPeer);
    }
    let sid = sid_string(groups.Groups[0].Sid)?;
    Ok(format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"))
}

fn current_process_token() -> Result<OwnedHandle, ProtectedEndpointError> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: pseudo process handle is always live and output is writable.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(ProtectedEndpointError::last_os_error("OpenProcessToken"));
    }
    if token.is_null() {
        return Err(ProtectedEndpointError::InvalidPeer);
    }
    // SAFETY: successful OpenProcessToken returns one new ownership handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(token) })
}

fn token_information_size(token: &OwnedHandle) -> Result<u32, ProtectedEndpointError> {
    let mut required = 0;
    // SAFETY: documented sizing call uses a null output buffer.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenLogonSid,
            ptr::null_mut(),
            0,
            &raw mut required,
        );
    }
    let minimum = u32::try_from(size_of::<TOKEN_GROUPS>())
        .map_err(|_| ProtectedEndpointError::InvalidPeer)?;
    if required < minimum {
        return Err(ProtectedEndpointError::last_os_error(
            "GetTokenInformation(TokenLogonSid size)",
        ));
    }
    Ok(required)
}

fn sid_string(sid: windows_sys::Win32::Security::PSID) -> Result<String, ProtectedEndpointError> {
    let mut text = ptr::null_mut();
    // SAFETY: TokenLogonSid returned a live SID and output pointer is writable.
    if unsafe { ConvertSidToStringSidW(sid, &raw mut text) } == 0 {
        return Err(ProtectedEndpointError::last_os_error(
            "ConvertSidToStringSidW",
        ));
    }
    let allocation = LocalAllocation(text.cast());
    let mut length = 0_usize;
    // SID strings are tightly bounded by Windows; the cap also protects us
    // from scanning arbitrary memory if the OS contract were violated.
    while length < 256 {
        // SAFETY: `text` points to a NUL-terminated LocalAlloc string.
        if unsafe { *text.add(length) } == 0 {
            // SAFETY: the preceding loop proved this many initialized units.
            let units = unsafe { std::slice::from_raw_parts(text, length) };
            return String::from_utf16(units).map_err(|_| ProtectedEndpointError::InvalidPeer);
        }
        length += 1;
    }
    drop(allocation);
    Err(ProtectedEndpointError::InvalidPeer)
}
