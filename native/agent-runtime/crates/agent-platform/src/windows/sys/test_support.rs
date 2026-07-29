use std::mem::size_of;
use std::os::windows::io::OwnedHandle;
use std::ptr;

use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent};

use super::super::WindowsContainmentError;
use super::handle::{own_handle, raw};

pub(in crate::windows) fn create_inheritable_event() -> Result<OwnedHandle, WindowsContainmentError>
{
    create_event(true)
}

pub(in crate::windows) fn create_noninheritable_event()
-> Result<OwnedHandle, WindowsContainmentError> {
    create_event(false)
}

fn create_event(inheritable: bool) -> Result<OwnedHandle, WindowsContainmentError> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
            .map_err(|_| WindowsContainmentError::LimitOverflow("SECURITY_ATTRIBUTES"))?,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: i32::from(inheritable),
    };
    // SAFETY: the security attributes are valid for this call. The fresh event
    // ownership handle is wrapped immediately.
    let event = unsafe { CreateEventW(ptr::from_ref(&attributes), 1, 0, ptr::null()) };
    own_handle(event, "CreateEventW(sentinel)")
}

pub(in crate::windows) fn is_handle_inheritable(
    handle: &OwnedHandle,
) -> Result<bool, WindowsContainmentError> {
    let mut flags = 0;
    // SAFETY: `handle` remains live and `flags` is writable for the call.
    if unsafe { GetHandleInformation(raw(handle), ptr::from_mut(&mut flags)) } == 0 {
        return Err(WindowsContainmentError::last_os_error(
            "GetHandleInformation",
        ));
    }
    Ok(flags & HANDLE_FLAG_INHERIT != 0)
}

pub(in crate::windows) fn raw_handle_value(handle: &OwnedHandle) -> usize {
    raw(handle) as usize
}

pub(in crate::windows) fn signal_raw_handle(value: usize) -> Result<(), WindowsContainmentError> {
    let handle = value as windows_sys::Win32::Foundation::HANDLE;
    // SAFETY: this intentionally probes whether the numeric handle is valid in
    // the child process. Failure is the expected non-inheritance result.
    if unsafe { SetEvent(handle) } == 0 {
        return Err(WindowsContainmentError::last_os_error("SetEvent(sentinel)"));
    }
    Ok(())
}
