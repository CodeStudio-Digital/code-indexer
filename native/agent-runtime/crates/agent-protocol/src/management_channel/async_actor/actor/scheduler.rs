use tokio::io::AsyncWrite;
use tokio::sync::mpsc;

use super::ManagementActor;
use crate::management_channel::async_actor::AsyncManagementActorError;
use crate::management_channel::async_actor::command::{CommandQueues, OutboundCommand};
use crate::management_channel::async_actor::event::EventSender;
use crate::management_channel::async_actor::worker::{ReadOutcome, ReaderWorker};

impl<W: AsyncWrite + Unpin> ManagementActor<W> {
    pub(super) async fn run_loop(
        &mut self,
        worker: &ReaderWorker,
        reads: &mut mpsc::Receiver<ReadOutcome>,
        commands: &mut CommandQueues,
        events: &EventSender,
    ) -> bool {
        let mut urgent_burst = 0_u8;
        let mut non_normal_burst = 0_u8;
        loop {
            let can_dispatch = self.semantics.can_dispatch();
            let outstanding_wait = self.semantics.outstanding_wait();
            if outstanding_wait.is_some_and(|wait| wait.is_zero()) {
                let _ = events.try_send(Err(AsyncManagementActorError::OutstandingDeadlineElapsed));
                return false;
            }
            if can_dispatch && commands.normal_open && non_normal_burst >= 4 {
                match try_command(&mut commands.normal, &mut commands.normal_open) {
                    Ok(command) => {
                        if !self.process_command(command).await {
                            return false;
                        }
                        urgent_burst = 0;
                        non_normal_burst = 0;
                        continue;
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => continue,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
                non_normal_burst = 0;
            }
            if urgent_burst >= 4 {
                if let Ok(outcome) = reads.try_recv() {
                    if !self.process_read(outcome, worker, events).await {
                        return false;
                    }
                    urgent_burst = 0;
                    non_normal_burst = non_normal_burst.saturating_add(1);
                    continue;
                }
                urgent_burst = 0;
            }
            if can_dispatch && commands.urgent_open && urgent_burst < 4 {
                match try_command(&mut commands.urgent, &mut commands.urgent_open) {
                    Ok(command) => {
                        if !self.process_command(command).await {
                            return false;
                        }
                        urgent_burst += 1;
                        non_normal_burst = non_normal_burst.saturating_add(1);
                        continue;
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => continue,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            let timer =
                tokio::time::sleep(outstanding_wait.unwrap_or(std::time::Duration::from_hours(1)));
            tokio::pin!(timer);
            tokio::select! {
                biased;
                () = &mut timer, if outstanding_wait.is_some() => {
                    let _ = events.try_send(Err(
                        AsyncManagementActorError::OutstandingDeadlineElapsed,
                    ));
                    return false;
                }
                outcome = reads.recv() => {
                    let Some(outcome) = outcome else { return false };
                    if !self.process_read(outcome, worker, events).await {
                        return false;
                    }
                    urgent_burst = 0;
                    non_normal_burst = non_normal_burst.saturating_add(1);
                }
                command = commands.urgent.recv(),
                    if commands.urgent_open && can_dispatch => {
                    match command {
                        Some(command) => {
                            if !self.process_command(command).await { return false; }
                            urgent_burst += 1;
                            non_normal_burst = non_normal_burst.saturating_add(1);
                        }
                        None => commands.urgent_open = false,
                    }
                }
                command = commands.normal.recv(),
                    if commands.normal_open && can_dispatch => {
                    match command {
                        Some(command) => {
                            if !self.process_command(command).await { return false; }
                            urgent_burst = 0;
                            non_normal_burst = 0;
                        }
                        None => commands.normal_open = false,
                    }
                }
            }
        }
    }
}

fn try_command(
    receiver: &mut mpsc::Receiver<OutboundCommand>,
    open: &mut bool,
) -> Result<OutboundCommand, mpsc::error::TryRecvError> {
    match receiver.try_recv() {
        Ok(command) => Ok(command),
        Err(error @ mpsc::error::TryRecvError::Empty) => Err(error),
        Err(mpsc::error::TryRecvError::Disconnected) => {
            *open = false;
            Err(mpsc::error::TryRecvError::Disconnected)
        }
    }
}
