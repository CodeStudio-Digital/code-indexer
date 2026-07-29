use std::fmt::{self, Debug, Formatter};
use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::thread::{self, JoinHandle};

use agent_platform::containment::{ContainmentPort, SpawnResult};
use tokio::sync::mpsc;

use super::super::provision::{
    ProtectedLaunchPhysicalFacts, ProtectedLaunchProvisionPort, ProtectedLaunchReceipt,
};
use super::operation::PhysicalLaunchWorkerInput;

mod cleanup;
mod guard;
mod runtime;

use cleanup::{RemoteCleanupCommand, RemoteCleanupResult};
pub(in crate::management) use cleanup::{RemoteLaunchCleanup, RemoteLaunchCleanupError};
use guard::reap_finished_or_fail_stop;
use runtime::run_worker;

const LAUNCH_THREAD_STACK_BYTES: usize = 1024 * 1024;
const LAUNCH_STAGE_CHANNEL_CAPACITY: usize = 1;
const CLEANUP_COMMAND_CAPACITY: usize = 1;

#[cfg(windows)]
const _: fn() = || {
    const fn assert_send<T: Send>() {}
    const fn assert_sync<T: Sync>() {}
    assert_send::<agent_platform::windows::WindowsJobGroup>();
    assert_send::<
        <super::super::provision::WindowsProtectedLaunchProvisioner as ProtectedLaunchProvisionPort>::Pending,
    >();
    assert_sync::<super::super::provision::WindowsProtectedLaunchProvisioner>();
};

pub(in crate::management) enum PhysicalLaunchWorkerCommand {
    Spawn,
    Complete(ProtectedLaunchPhysicalFacts),
    Stop,
}

pub(in crate::management) enum PhysicalLaunchWorkerEvent<G> {
    Prepared(bool),
    Spawned(SpawnResult<G, ()>),
    Completed(Box<ProtectedLaunchReceipt>),
    CompletionCleanupRequired,
    Stopped,
}

pub(in crate::management) struct PendingPhysicalLaunchWorker<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    commands: mpsc::Sender<PhysicalLaunchWorkerCommand>,
    events: mpsc::Receiver<PhysicalLaunchWorkerEvent<P::Group>>,
    cleanup_commands: std_mpsc::SyncSender<RemoteCleanupCommand>,
    cleanup_results: std_mpsc::Receiver<RemoteCleanupResult>,
    thread: Option<JoinHandle<()>>,
    provisioner: PhantomData<fn() -> V>,
}

impl<P, V> PendingPhysicalLaunchWorker<P, V>
where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
{
    pub(in crate::management) fn start(
        input: PhysicalLaunchWorkerInput,
        containment: Arc<P>,
        provisioner: Arc<V>,
    ) -> Result<Self, std::io::Error> {
        let (commands, worker_commands) = mpsc::channel(LAUNCH_STAGE_CHANNEL_CAPACITY);
        let (worker_events, events) = mpsc::channel(LAUNCH_STAGE_CHANNEL_CAPACITY);
        let (cleanup_commands, worker_cleanup_commands) =
            std_mpsc::sync_channel(CLEANUP_COMMAND_CAPACITY);
        let (worker_cleanup_results, cleanup_results) =
            std_mpsc::sync_channel(CLEANUP_COMMAND_CAPACITY);
        let thread = thread::Builder::new()
            .name("agentd-launch".into())
            .stack_size(LAUNCH_THREAD_STACK_BYTES)
            .spawn(move || {
                let mut worker_commands = worker_commands;
                run_worker(
                    input,
                    &containment,
                    &provisioner,
                    &mut worker_commands,
                    &worker_events,
                    &worker_cleanup_commands,
                    &worker_cleanup_results,
                );
            })?;
        Ok(Self {
            commands,
            events,
            cleanup_commands,
            cleanup_results,
            thread: Some(thread),
            provisioner: PhantomData,
        })
    }

    pub(in crate::management) async fn next(
        &mut self,
    ) -> Option<PhysicalLaunchWorkerEvent<P::Group>> {
        self.events.recv().await
    }

    pub(in crate::management) fn command(
        &self,
        command: PhysicalLaunchWorkerCommand,
    ) -> Result<(), PhysicalLaunchWorkerCommand> {
        self.commands
            .try_send(command)
            .map_err(tokio::sync::mpsc::error::TrySendError::into_inner)
    }

    pub(in crate::management) fn join_finished(&mut self) -> thread::Result<()> {
        self.thread
            .take()
            .expect("launch worker joined exactly once")
            .join()
    }

    pub(in crate::management) fn into_cleanup_owner(mut self) -> RemoteLaunchCleanup {
        let thread = self
            .thread
            .take()
            .expect("cleanup worker retains join ownership");
        let results = std::mem::replace(
            &mut self.cleanup_results,
            std_mpsc::sync_channel(CLEANUP_COMMAND_CAPACITY).1,
        );
        RemoteLaunchCleanup::new(self.cleanup_commands.clone(), results, thread)
    }
}

impl<P, V> Drop for PendingPhysicalLaunchWorker<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn drop(&mut self) {
        reap_finished_or_fail_stop(&mut self.thread);
    }
}

impl<P, V> Debug for PendingPhysicalLaunchWorker<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingPhysicalLaunchWorker")
            .field(
                "thread_finished",
                &self.thread.as_ref().is_none_or(JoinHandle::is_finished),
            )
            .finish_non_exhaustive()
    }
}
