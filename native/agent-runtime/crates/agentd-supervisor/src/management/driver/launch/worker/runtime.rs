use std::sync::Arc;
use std::sync::mpsc;

use agent_platform::containment::{ContainmentPort, SpawnFailure};
use tokio::sync::mpsc as tokio_mpsc;

use super::cleanup::{RemoteCleanupCommand, RemoteCleanupResult};
use super::guard::fail_stop;
use super::{PhysicalLaunchWorkerCommand, PhysicalLaunchWorkerEvent};
use crate::management::driver::launch::operation::PhysicalLaunchWorkerInput;
use crate::management::driver::provision::{
    ProtectedLaunchCompletion, ProtectedLaunchProvisionPort, ProtectedLaunchRequest,
};
use crate::process_table::execute_contained_spawn;

pub(super) fn run_worker<P, V>(
    input: PhysicalLaunchWorkerInput,
    containment: &Arc<P>,
    provisioner: &Arc<V>,
    commands: &mut tokio_mpsc::Receiver<PhysicalLaunchWorkerCommand>,
    events: &tokio_mpsc::Sender<PhysicalLaunchWorkerEvent<P::Group>>,
    cleanup_commands: &mpsc::Receiver<RemoteCleanupCommand>,
    cleanup_results: &mpsc::SyncSender<RemoteCleanupResult>,
) where
    P: ContainmentPort + Send + Sync + 'static,
    P::Group: Send + 'static,
    V: ProtectedLaunchProvisionPort + Send + Sync + 'static,
{
    let (launch, plan, peer_authority, contained_launch) = input.into_worker_parts();
    let request = ProtectedLaunchRequest::new(&launch, &plan, &peer_authority);
    let prepared = provisioner.prepare(&request);
    drop(request);
    drop(launch);
    let prepared = match prepared {
        Ok(prepared) => {
            send_event(events, PhysicalLaunchWorkerEvent::Prepared(true));
            prepared
        }
        Err(error) => {
            drop(error);
            send_event(events, PhysicalLaunchWorkerEvent::Prepared(false));
            return;
        }
    };
    match commands.blocking_recv() {
        Some(PhysicalLaunchWorkerCommand::Spawn) => {}
        Some(PhysicalLaunchWorkerCommand::Stop) | None => {
            drop(prepared);
            send_event(events, PhysicalLaunchWorkerEvent::Stopped);
            return;
        }
        Some(PhysicalLaunchWorkerCommand::Complete(_)) => fail_stop(),
    }
    let (child_handles, pending) = prepared.into_spawn_parts();
    let spawned = execute_contained_spawn(
        containment.as_ref(),
        plan.metadata().resource_group_id,
        plan.budget(),
        &contained_launch,
        child_handles,
    );
    let spawned_ok = spawned.is_ok();
    let spawned = spawned.map_err(|failure| match failure {
        SpawnFailure::Clean(error) => {
            drop(error);
            SpawnFailure::Clean(())
        }
        SpawnFailure::Owned { spawned, error } => {
            drop(error);
            SpawnFailure::Owned { spawned, error: () }
        }
    });
    send_event(events, PhysicalLaunchWorkerEvent::Spawned(spawned));
    if !spawned_ok {
        return;
    }
    match commands.blocking_recv() {
        Some(PhysicalLaunchWorkerCommand::Complete(physical)) => {
            match provisioner.complete_after_spawn(pending, &physical) {
                ProtectedLaunchCompletion::Completed(receipt) => {
                    send_event(events, PhysicalLaunchWorkerEvent::Completed(receipt));
                }
                ProtectedLaunchCompletion::CleanupRequired(failure) => {
                    let (error, cleanup) = failure.into_parts();
                    drop(error);
                    send_event(events, PhysicalLaunchWorkerEvent::CompletionCleanupRequired);
                    run_remote_cleanup(cleanup, cleanup_commands, cleanup_results);
                }
            }
        }
        Some(PhysicalLaunchWorkerCommand::Stop) | None => {
            drop(pending);
            send_event(events, PhysicalLaunchWorkerEvent::Stopped);
        }
        Some(PhysicalLaunchWorkerCommand::Spawn) => fail_stop(),
    }
}

fn run_remote_cleanup<C>(
    mut cleanup: crate::management::driver::provision::ProtectedLaunchCleanupOwner<C>,
    commands: &mpsc::Receiver<RemoteCleanupCommand>,
    results: &mpsc::SyncSender<RemoteCleanupResult>,
) where
    C: crate::management::driver::provision::ProtectedLaunchCleanupPort,
{
    while matches!(commands.recv(), Ok(RemoteCleanupCommand::Try)) {
        let result = if cleanup.cleanup().is_ok() {
            RemoteCleanupResult::Completed
        } else {
            RemoteCleanupResult::Retry
        };
        if results.send(result).is_err() {
            fail_stop();
        }
        if matches!(result, RemoteCleanupResult::Completed) {
            break;
        }
    }
}

fn send_event<G>(
    events: &tokio_mpsc::Sender<PhysicalLaunchWorkerEvent<G>>,
    event: PhysicalLaunchWorkerEvent<G>,
) where
    G: Send + 'static,
{
    if events.blocking_send(event).is_err() {
        fail_stop();
    }
}
