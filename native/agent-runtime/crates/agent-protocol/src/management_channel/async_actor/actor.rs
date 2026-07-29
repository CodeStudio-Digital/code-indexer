use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;

use super::command::CommandQueues;
use super::event::{AsyncManagementEvent, EventSender};
use super::semantics::{InboundAction, ManagementSemantics};
use super::worker::{ReadOutcome, ReaderWorker};
use super::{AsyncManagementActorError, AsyncManagementPolicy};
use crate::framing::asynchronous::{AsyncFrameReader, AsyncFrameWriter};
use crate::management_channel::ManagementSessionPolicy;
use crate::management_channel::clock::ManagementClockAuthority;
use crate::management_channel::receiver::ManagementReceiver;
use crate::management_channel::sender::ManagementOutboundAuthority;

mod pending;
mod scheduler;
mod writer;

pub(super) struct ManagementActor<W> {
    writer: AsyncFrameWriter<W>,
    semantics: ManagementSemantics,
    policy: AsyncManagementPolicy,
    durable_ack_required: bool,
    reader_terminal: Option<watch::Receiver<bool>>,
}

impl<W: AsyncWrite + Unpin> ManagementActor<W> {
    pub(super) fn new(
        writer: AsyncFrameWriter<W>,
        receiver: ManagementReceiver,
        sender: ManagementOutboundAuthority,
        session: ManagementSessionPolicy,
        clock: ManagementClockAuthority,
        policy: AsyncManagementPolicy,
        durable_ack_required: bool,
    ) -> Result<Self, AsyncManagementActorError> {
        Ok(Self {
            writer,
            semantics: ManagementSemantics::new(receiver, sender, session, clock)?,
            policy,
            durable_ack_required,
            reader_terminal: None,
        })
    }

    pub(super) async fn run<R>(
        mut self,
        reader: AsyncFrameReader<R>,
        mut commands: CommandQueues,
        events: EventSender,
    ) where
        R: AsyncRead + Unpin + Send + 'static,
        W: Send + 'static,
    {
        let (worker, mut reads, terminal) = ReaderWorker::spawn(reader, &self.policy);
        self.reader_terminal = Some(terminal);
        if let Err(error) = worker.request_next() {
            let _ = events.try_send(Err(error));
            worker.stop().await;
            return;
        }
        let healthy = self
            .run_loop(&worker, &mut reads, &mut commands, &events)
            .await;
        if !healthy {
            self.semantics.poison();
        }
        worker.stop().await;
    }

    async fn process_read(
        &mut self,
        outcome: ReadOutcome,
        worker: &ReaderWorker,
        events: &EventSender,
    ) -> bool {
        let encoded = match outcome {
            Ok(encoded) => encoded,
            Err(error) => {
                let _ = events.try_send(Err(error));
                return false;
            }
        };
        let action = self.semantics.begin_inbound(encoded.as_slice());
        let action = match action {
            Ok(action) => action,
            Err(error) => {
                let _ = events.try_send(Err(error.into()));
                return false;
            }
        };
        match action {
            InboundAction::Acknowledged(receipt) => {
                if events
                    .try_send(Ok(AsyncManagementEvent::Acknowledged(receipt)))
                    .is_err()
                {
                    return false;
                }
                worker.request_next().is_ok()
            }
            InboundAction::Replay { metadata, response } => {
                if let Err(error) = self.replay(response).await {
                    let _ = events.try_send(Err(error));
                    return false;
                }
                if events
                    .try_send(Ok(AsyncManagementEvent::Replay(metadata)))
                    .is_err()
                {
                    return false;
                }
                worker.request_next().is_ok()
            }
            InboundAction::Pending(pending) => self.process_pending(pending, worker, events).await,
        }
    }
}
