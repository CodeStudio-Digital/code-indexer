mod attributes;
mod compare;
mod filesystem;
mod filesystem_move;
mod handle;
mod job;
mod process;
mod resource;
#[cfg(test)]
mod test_pipe;
#[cfg(test)]
mod test_support;

pub(super) use attributes::ProcessAttributeList;
pub(super) use compare::compare_ordinal_ignore_case;
pub(super) use filesystem::{final_file_path, path_is_within};
pub(super) use filesystem_move::rename_no_replace;
pub(super) use job::{
    configure_job, create_job, prove_limits, query_accounting, query_peak_memory, terminate_job,
};
pub(super) use process::{
    ProcessSpawnFailure, SpawnFault, WaitState, exit_code, spawn_in_job, wait_process,
};
pub(super) use resource::sample_current_process;

#[cfg(test)]
pub(super) use process::{is_member, open_process_for_wait};
#[cfg(test)]
pub(super) use test_pipe::{
    connect_and_wait_for_byte, create_test_pipe, open_test_pipe_client, server_process_id,
    write_release_byte,
};
#[cfg(test)]
pub(super) use test_support::{
    create_inheritable_event, create_noninheritable_event, is_handle_inheritable, raw_handle_value,
    signal_raw_handle,
};
