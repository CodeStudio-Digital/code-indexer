use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr;

use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::IO::CancelIoEx;
use windows_sys::Win32::System::Pipes::{
    CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};

use crate::ipc::{EndpointBufferCapacity, ProtectedEndpointError};

use super::security::PipeSecurity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::windows::ipc) enum PipeProbe {
    Available,
    Busy,
}

pub(in crate::windows::ipc) fn create_pipe(
    address: &str,
    capacity: EndpointBufferCapacity,
) -> Result<NamedPipeServer, ProtectedEndpointError> {
    let mut security = PipeSecurity::for_current_logon()?;
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .max_instances(1)
        .in_buffer_size(capacity.get())
        .out_buffer_size(capacity.get());
    // SAFETY: `security` owns a valid descriptor and attributes for the
    // complete CreateNamedPipeW call. Tokio does not retain the pointer.
    unsafe { options.create_with_security_attributes_raw(address, security.attributes_mut_ptr()) }
        .map_err(|source| ProtectedEndpointError::io("CreateNamedPipeW", source))
}

pub(in crate::windows::ipc) fn client_process_id(
    server: &NamedPipeServer,
) -> Result<u32, ProtectedEndpointError> {
    let mut process_id = 0;
    // SAFETY: the pipe handle remains live and the output pointer is writable.
    if unsafe { GetNamedPipeClientProcessId(server.as_raw_handle() as HANDLE, &raw mut process_id) }
        == 0
    {
        return Err(ProtectedEndpointError::last_os_error(
            "GetNamedPipeClientProcessId",
        ));
    }
    if process_id == 0 {
        return Err(ProtectedEndpointError::InvalidPeer);
    }
    Ok(process_id)
}

pub(in crate::windows::ipc) fn server_process_id(
    client: &NamedPipeClient,
) -> Result<u32, ProtectedEndpointError> {
    let mut process_id = 0;
    // SAFETY: the pipe handle remains live and the output pointer is writable.
    if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle() as HANDLE, &raw mut process_id) }
        == 0
    {
        return Err(ProtectedEndpointError::last_os_error(
            "GetNamedPipeServerProcessId",
        ));
    }
    if process_id == 0 {
        return Err(ProtectedEndpointError::InvalidPeer);
    }
    Ok(process_id)
}

pub(in crate::windows::ipc) fn cancel_pending_io(
    server: &NamedPipeServer,
) -> Result<(), ProtectedEndpointError> {
    // SAFETY: the handle remains live and a null OVERLAPPED requests
    // cancellation of all operations issued by this process on the endpoint.
    if unsafe { CancelIoEx(server.as_raw_handle() as HANDLE, ptr::null()) } == 0 {
        let source = std::io::Error::last_os_error();
        // ERROR_NOT_FOUND means the raced operation already completed.
        if source.raw_os_error() != Some(1_168) {
            return Err(ProtectedEndpointError::io("CancelIoEx(named pipe)", source));
        }
    }
    Ok(())
}

pub(in crate::windows::ipc) fn probe_pipe_available(
    address: &str,
    capacity: EndpointBufferCapacity,
) -> Result<PipeProbe, ProtectedEndpointError> {
    let mut security = PipeSecurity::for_current_logon()?;
    let mut encoded: Vec<u16> = address.encode_utf16().collect();
    encoded.push(0);
    let open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE;
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: address is NUL-terminated, attributes remain live for the call,
    // and a successful raw ownership handle is wrapped exactly once.
    let handle = unsafe {
        CreateNamedPipeW(
            encoded.as_ptr(),
            open_mode,
            pipe_mode,
            1,
            capacity.get(),
            capacity.get(),
            0,
            security.attributes_mut_ptr().cast_const().cast(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let source = std::io::Error::last_os_error();
        return match source.raw_os_error().map(i32::cast_unsigned) {
            Some(ERROR_PIPE_BUSY | ERROR_ACCESS_DENIED) => Ok(PipeProbe::Busy),
            _ => Err(ProtectedEndpointError::io("probe CreateNamedPipeW", source)),
        };
    }
    // SAFETY: successful CreateNamedPipeW returns one new ownership handle.
    drop(unsafe { OwnedHandle::from_raw_handle(handle) });
    Ok(PipeProbe::Available)
}
