use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use super::{
    RunnerBootstrapReceiveFailure, RunnerBootstrapSendFailure, RunnerBootstrapTransportError,
    handoff_codec, read_exactly_one, ready_codec,
};
use crate::runner_bootstrap::{
    AwaitingRunnerEndpointsReady, MatchedRunnerEndpointsReady, PreparedRunnerLaunchHandoff,
};

pub struct SupervisorPhysicalBootstrapSender<R, W> {
    reader: R,
    writer: W,
}

pub struct AwaitingPhysicalRunnerReady<R> {
    reader: R,
    expected: AwaitingRunnerEndpointsReady,
}

impl<R, W> Debug for SupervisorPhysicalBootstrapSender<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorPhysicalBootstrapSender")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<R> Debug for AwaitingPhysicalRunnerReady<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AwaitingPhysicalRunnerReady")
            .field("transport", &"[PROTECTED]")
            .field("expected", &self.expected)
            .finish_non_exhaustive()
    }
}

impl<R, W> SupervisorPhysicalBootstrapSender<R, W> {
    #[must_use]
    pub const fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }
}

impl<R: Read, W: Write> SupervisorPhysicalBootstrapSender<R, W> {
    /// Sends the handoff and discards transport ownership on failure.
    ///
    /// Production cleanup paths should use [`Self::send_owned`].
    ///
    /// # Errors
    ///
    /// Any framing, write or flush failure consumes all authority.
    pub fn send(
        self,
        prepared: PreparedRunnerLaunchHandoff,
    ) -> Result<AwaitingPhysicalRunnerReady<R>, RunnerBootstrapTransportError> {
        self.send_owned(prepared)
            .map_err(RunnerBootstrapSendFailure::into_error)
    }

    /// Sends the sole handoff while retaining both transport halves on failure.
    ///
    /// Success closes the writer before returning the Ready reader, making EOF
    /// observable by the runner. Failure consumes and scrubs `prepared`, while
    /// returning transport ownership for cancellation and reaping.
    ///
    /// # Errors
    ///
    /// Returns the reader, writer and exact framing/transport failure together.
    pub fn send_owned(
        self,
        prepared: PreparedRunnerLaunchHandoff,
    ) -> Result<AwaitingPhysicalRunnerReady<R>, RunnerBootstrapSendFailure<R, W>> {
        let Self { reader, mut writer } = self;
        let transmitted = prepared.transmit_with(|frame| {
            handoff_codec().write_raw(&mut writer, frame)?;
            writer.flush().map_err(RunnerBootstrapTransportError::Flush)
        });
        let expected = match transmitted {
            Ok(expected) => expected,
            Err(error) => {
                return Err(RunnerBootstrapSendFailure::new(reader, writer, error));
            }
        };
        drop(writer);
        Ok(AwaitingPhysicalRunnerReady { reader, expected })
    }
}

impl<R: Read> AwaitingPhysicalRunnerReady<R> {
    /// Receives Ready and discards reader ownership on failure.
    ///
    /// Production cleanup paths should use [`Self::receive_owned`].
    ///
    /// # Errors
    ///
    /// Missing, extra, malformed, oversized or mismatched frames fail closed.
    pub fn receive(self) -> Result<MatchedRunnerEndpointsReady, RunnerBootstrapTransportError> {
        self.receive_owned()
            .map_err(RunnerBootstrapReceiveFailure::into_error)
    }

    /// Receives the sole Ready frame while retaining its reader on failure.
    ///
    /// # Errors
    ///
    /// Missing, extra, malformed, oversized or mismatched frames return the
    /// reader and exact failure together for cancellation and reaping.
    pub fn receive_owned(
        self,
    ) -> Result<MatchedRunnerEndpointsReady, RunnerBootstrapReceiveFailure<R>> {
        let Self {
            mut reader,
            expected,
        } = self;
        let encoded = match read_exactly_one(&mut reader, ready_codec(), "RunnerEndpointsReady") {
            Ok(encoded) => encoded,
            Err(error) => return Err(RunnerBootstrapReceiveFailure::new(reader, error)),
        };
        expected
            .accept_ready(&encoded)
            .map_err(RunnerBootstrapTransportError::from)
            .map_err(|error| RunnerBootstrapReceiveFailure::new(reader, error))
    }
}
