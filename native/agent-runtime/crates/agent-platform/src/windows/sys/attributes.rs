use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::OwnedHandle;
use std::ptr;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Threading::{
    DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, UpdateProcThreadAttribute,
};

use crate::containment::ChildHandleAllowlist;

use super::super::WindowsContainmentError;
use super::handle::raw;

/// Owns aligned attribute-list storage plus every stable raw-handle array used
/// by `CreateProcessW`.
pub(in crate::windows) struct ProcessAttributeList {
    _storage: Vec<usize>,
    job_handles: Box<[HANDLE; 1]>,
    inherited_handles: Box<[HANDLE]>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl ProcessAttributeList {
    pub(in crate::windows) fn new(
        job: &OwnedHandle,
        allowlist: &ChildHandleAllowlist,
    ) -> Result<Self, WindowsContainmentError> {
        let attribute_count = if allowlist.is_empty() { 1 } else { 2 };
        let mut required_bytes = 0_usize;
        // SAFETY: the documented sizing call uses a null list and writes only
        // the required byte count.
        unsafe {
            InitializeProcThreadAttributeList(
                ptr::null_mut(),
                attribute_count,
                0,
                ptr::from_mut(&mut required_bytes),
            );
        }
        if required_bytes == 0 {
            return Err(WindowsContainmentError::last_os_error(
                "InitializeProcThreadAttributeList(size)",
            ));
        }

        // `usize` storage gives the opaque list at least pointer alignment.
        let words = required_bytes.div_ceil(size_of::<usize>());
        let mut storage = vec![0_usize; words];
        let list = storage.as_mut_ptr().cast::<c_void>();
        // SAFETY: `storage` has the requested size and stays at a stable heap
        // address for the lifetime of this owner.
        if unsafe {
            InitializeProcThreadAttributeList(
                list,
                attribute_count,
                0,
                ptr::from_mut(&mut required_bytes),
            )
        } == 0
        {
            return Err(WindowsContainmentError::last_os_error(
                "InitializeProcThreadAttributeList",
            ));
        }

        let job_handles = Box::new([raw(job)]);
        let inherited_handles = allowlist.windows_raw_handles().collect();
        let result = Self {
            _storage: storage,
            job_handles,
            inherited_handles,
            list,
        };
        // SAFETY: the list is initialized. The boxed handle array and the Job
        // itself remain live through CreateProcessW and list destruction.
        if unsafe {
            UpdateProcThreadAttribute(
                result.list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                result.job_handles.as_ptr().cast(),
                size_of::<HANDLE>(),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            return Err(WindowsContainmentError::last_os_error(
                "UpdateProcThreadAttribute(JOB_LIST)",
            ));
        }
        if !result.inherited_handles.is_empty() {
            // SAFETY: the attribute list is initialized and the boxed raw
            // handle array remains stable until after `CreateProcessW`.
            if unsafe {
                UpdateProcThreadAttribute(
                    result.list,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    result.inherited_handles.as_ptr().cast(),
                    size_of_val(result.inherited_handles.as_ref()),
                    ptr::null_mut(),
                    ptr::null(),
                )
            } == 0
            {
                return Err(WindowsContainmentError::last_os_error(
                    "UpdateProcThreadAttribute(HANDLE_LIST)",
                ));
            }
        }
        Ok(result)
    }

    pub(in crate::windows) const fn as_ptr(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list
    }
}

impl Drop for ProcessAttributeList {
    fn drop(&mut self) {
        // SAFETY: `list` was initialized successfully and is deleted once.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}
