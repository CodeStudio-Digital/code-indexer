use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::OwnedHandle;
use std::ptr;

use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_END_OF_JOB_TIME_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectEndOfJobTimeInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};

use super::super::WindowsContainmentError;
use super::handle::{own_handle, raw};

pub(in crate::windows) fn create_job() -> Result<OwnedHandle, WindowsContainmentError> {
    // SAFETY: null security attributes and null name create an anonymous,
    // non-inheritable Job Object. A successful raw handle is immediately owned.
    let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    own_handle(handle, "CreateJobObjectW")
}

pub(in crate::windows) fn configure_job(
    job: &OwnedHandle,
    extended: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    end_of_job: &JOBOBJECT_END_OF_JOB_TIME_INFORMATION,
) -> Result<(), WindowsContainmentError> {
    set_job_information(
        job,
        JobObjectExtendedLimitInformation,
        ptr::from_ref(extended).cast(),
        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(),
        "SetInformationJobObject(extended limits)",
    )?;
    set_job_information(
        job,
        JobObjectEndOfJobTimeInformation,
        ptr::from_ref(end_of_job).cast(),
        size_of::<JOBOBJECT_END_OF_JOB_TIME_INFORMATION>(),
        "SetInformationJobObject(end-of-job action)",
    )
}

pub(in crate::windows) fn prove_limits(
    job: &OwnedHandle,
    expected: &JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    expected_end: &JOBOBJECT_END_OF_JOB_TIME_INFORMATION,
) -> Result<(), WindowsContainmentError> {
    let mut actual = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    query_job_information(
        job,
        JobObjectExtendedLimitInformation,
        ptr::from_mut(&mut actual).cast(),
        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(),
        "QueryInformationJobObject(extended limits)",
    )?;
    let actual_basic = &actual.BasicLimitInformation;
    let expected_basic = &expected.BasicLimitInformation;
    if actual_basic.LimitFlags != expected_basic.LimitFlags
        || actual_basic.ActiveProcessLimit != expected_basic.ActiveProcessLimit
        || actual_basic.PerJobUserTimeLimit != expected_basic.PerJobUserTimeLimit
        || actual.JobMemoryLimit != expected.JobMemoryLimit
    {
        return Err(WindowsContainmentError::ConfiguredLimitsNotProven);
    }
    let mut actual_end = JOBOBJECT_END_OF_JOB_TIME_INFORMATION::default();
    query_job_information(
        job,
        JobObjectEndOfJobTimeInformation,
        ptr::from_mut(&mut actual_end).cast(),
        size_of::<JOBOBJECT_END_OF_JOB_TIME_INFORMATION>(),
        "QueryInformationJobObject(end-of-job action)",
    )?;
    if actual_end.EndOfJobTimeAction != expected_end.EndOfJobTimeAction {
        return Err(WindowsContainmentError::ConfiguredLimitsNotProven);
    }
    Ok(())
}

pub(in crate::windows) fn terminate_job(
    job: &OwnedHandle,
    exit_code: u32,
) -> Result<(), WindowsContainmentError> {
    // SAFETY: `job` is the unique owned Job handle for this attempt.
    if unsafe { TerminateJobObject(raw(job), exit_code) } == 0 {
        return Err(WindowsContainmentError::last_os_error("TerminateJobObject"));
    }
    Ok(())
}

pub(in crate::windows) fn query_accounting(
    job: &OwnedHandle,
) -> Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, WindowsContainmentError> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    query_job_information(
        job,
        JobObjectBasicAccountingInformation,
        ptr::from_mut(&mut accounting).cast(),
        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(),
        "QueryInformationJobObject(accounting)",
    )?;
    Ok(accounting)
}

pub(in crate::windows) fn query_peak_memory(
    job: &OwnedHandle,
) -> Result<u64, WindowsContainmentError> {
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    query_job_information(
        job,
        JobObjectExtendedLimitInformation,
        ptr::from_mut(&mut limits).cast(),
        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>(),
        "QueryInformationJobObject(peak memory)",
    )?;
    Ok(limits.PeakJobMemoryUsed as u64)
}

fn set_job_information(
    job: &OwnedHandle,
    class: i32,
    information: *const c_void,
    length: usize,
    operation: &'static str,
) -> Result<(), WindowsContainmentError> {
    let length =
        u32::try_from(length).map_err(|_| WindowsContainmentError::LimitOverflow(operation))?;
    // SAFETY: class, pointer and length are paired by the typed callers above.
    if unsafe { SetInformationJobObject(raw(job), class, information, length) } == 0 {
        return Err(WindowsContainmentError::last_os_error(operation));
    }
    Ok(())
}

fn query_job_information(
    job: &OwnedHandle,
    class: i32,
    information: *mut c_void,
    length: usize,
    operation: &'static str,
) -> Result<(), WindowsContainmentError> {
    let length =
        u32::try_from(length).map_err(|_| WindowsContainmentError::LimitOverflow(operation))?;
    // SAFETY: class, writable pointer and length are paired by typed callers.
    if unsafe { QueryInformationJobObject(raw(job), class, information, length, ptr::null_mut()) }
        == 0
    {
        return Err(WindowsContainmentError::last_os_error(operation));
    }
    Ok(())
}
