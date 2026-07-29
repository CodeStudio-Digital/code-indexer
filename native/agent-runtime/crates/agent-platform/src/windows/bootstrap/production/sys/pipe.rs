use std::fmt::Write as _;
use std::io;
use std::mem::size_of;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
    OPEN_EXISTING, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
};
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use zeroize::Zeroize;

use crate::windows::ipc::PipeSecurity;

const RANDOM_NAME_BYTES: usize = 16;
const PIPE_PREFIX: &str = r"\\.\pipe\codestudio-agent-bootstrap-";

#[derive(Clone, Copy)]
pub(in crate::windows::bootstrap::production) enum ParentDirection {
    Reads,
    Writes,
}

impl ParentDirection {
    const fn server_access(self) -> u32 {
        match self {
            Self::Reads => PIPE_ACCESS_INBOUND,
            Self::Writes => PIPE_ACCESS_OUTBOUND,
        }
    }

    const fn child_access(self) -> u32 {
        match self {
            Self::Reads => GENERIC_WRITE,
            Self::Writes => GENERIC_READ,
        }
    }
}

pub(in crate::windows::bootstrap::production) struct PrivatePipePair {
    pub parent: OwnedHandle,
    pub child: OwnedHandle,
}

pub(in crate::windows::bootstrap::production) fn create_private_pair(
    direction: ParentDirection,
    capacity: u32,
) -> io::Result<PrivatePipePair> {
    let name = RandomPipeName::generate()?;
    let mut security =
        PipeSecurity::for_current_logon().map_err(|error| io::Error::other(Box::new(error)))?;
    let open_mode =
        direction.server_access() | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE;
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: the random name is NUL-terminated, the DACL remains live for the
    // call, and a successful raw ownership handle is wrapped exactly once.
    let parent = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            pipe_mode,
            1,
            capacity,
            capacity,
            0,
            security.attributes_mut_ptr().cast_const().cast(),
        )
    };
    let parent = own(parent)?;
    let child_attributes = inheritable_attributes()?;
    // SAFETY: the same private name remains live. No FILE_FLAG_OVERLAPPED is
    // supplied, so the client is synchronous and is opened before any spawn.
    let child = unsafe {
        CreateFileW(
            name.as_ptr(),
            direction.child_access(),
            0,
            ptr::from_ref(&child_attributes),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            ptr::null_mut(),
        )
    };
    let child = own(child)?;
    Ok(PrivatePipePair { parent, child })
}

struct RandomPipeName(Vec<u16>);

impl RandomPipeName {
    fn generate() -> io::Result<Self> {
        let mut random = [0_u8; RANDOM_NAME_BYTES];
        // SAFETY: the stack buffer is writable for its exact declared length;
        // a null algorithm handle selects the Windows system RNG.
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                random.as_mut_ptr(),
                u32::try_from(random.len())
                    .map_err(|_| io::Error::other("random name length overflow"))?,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            random.fill(0);
            return Err(io::Error::other(format!(
                "BCryptGenRandom failed with NTSTATUS {status:#x}"
            )));
        }
        let mut text = String::with_capacity(PIPE_PREFIX.len() + RANDOM_NAME_BYTES * 2);
        text.push_str(PIPE_PREFIX);
        for byte in &random {
            if write!(&mut text, "{byte:02x}").is_err() {
                random.zeroize();
                text.zeroize();
                return Err(io::Error::other("formatting random pipe name failed"));
            }
        }
        random.zeroize();
        let mut encoded = text.encode_utf16().collect::<Vec<_>>();
        encoded.push(0);
        text.zeroize();
        Ok(Self(encoded))
    }

    const fn as_ptr(&self) -> *const u16 {
        self.0.as_ptr()
    }
}

impl Drop for RandomPipeName {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

fn inheritable_attributes() -> io::Result<SECURITY_ATTRIBUTES> {
    Ok(SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| io::Error::other("SECURITY_ATTRIBUTES size overflow"))?,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    })
}

fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: callers pass a fresh Win32 ownership handle exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}
