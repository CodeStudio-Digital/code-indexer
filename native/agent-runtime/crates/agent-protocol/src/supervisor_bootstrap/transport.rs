use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use crate::framing::DelimitedFrameCodec;
use crate::generated::v1 as wire;

use super::validation;
use super::{
    SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES, SUPERVISOR_PROCESS_READY_MAX_BYTES,
    SupervisorBootstrapError, ValidatedSupervisorProcessHandoff,
};

mod ready;

pub struct SupervisorPhysicalBootstrapReceiver<R, W> {
    reader: R,
    writer: W,
}

pub struct SupervisorPhysicalBootstrapSender<R, W> {
    reader: R,
    writer: W,
}

pub struct ReceivedSupervisorProcessHandoff<W> {
    handoff: ValidatedSupervisorProcessHandoff,
    ready: SupervisorBootstrapReadyTransport<W>,
}

pub struct SentSupervisorProcessHandoff<R> {
    reader: R,
}

pub struct SupervisorBootstrapReadyTransport<W> {
    writer: W,
}

impl<R, W> SupervisorPhysicalBootstrapReceiver<R, W> {
    #[must_use]
    pub const fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }
}

impl<R, W> SupervisorPhysicalBootstrapSender<R, W> {
    #[must_use]
    pub const fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }
}

impl<R: Read, W: Write> SupervisorPhysicalBootstrapSender<R, W> {
    /// Writes one bounded handoff, flushes it and closes the request direction
    /// so the child can prove exact EOF before opening management.
    ///
    /// # Errors
    ///
    /// Rejects empty or oversized handoffs and propagates physical I/O errors.
    pub fn send(
        self,
        handoff: &wire::SupervisorProcessHandoff,
    ) -> Result<SentSupervisorProcessHandoff<R>, SupervisorBootstrapError> {
        let Self { reader, mut writer } = self;
        codec(SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES).write(&mut writer, handoff)?;
        writer.flush().map_err(SupervisorBootstrapError::Flush)?;
        drop(writer);
        Ok(SentSupervisorProcessHandoff { reader })
    }
}

impl<R: Read, W: Write> SupervisorPhysicalBootstrapReceiver<R, W> {
    /// Receives exactly one handoff and requires EOF on the inherited request
    /// direction before returning permanent-channel authority.
    ///
    /// # Errors
    ///
    /// Rejects missing, malformed, oversized, physically mismatched or
    /// trailing handoff bytes.
    pub fn receive(
        self,
        expected_host_process_id: u32,
        expected_supervisor_process_id: u32,
    ) -> Result<ReceivedSupervisorProcessHandoff<W>, SupervisorBootstrapError> {
        let Self { mut reader, writer } = self;
        let codec = codec(SUPERVISOR_PROCESS_HANDOFF_MAX_BYTES);
        let encoded = codec
            .read_raw(&mut reader)?
            .ok_or(SupervisorBootstrapError::UnexpectedEof)?;
        let handoff = validation::decode(
            encoded,
            expected_host_process_id,
            expected_supervisor_process_id,
        )?;
        let mut trailing = [0_u8; 1];
        if reader
            .read(&mut trailing)
            .map_err(crate::framing::FramingError::Io)?
            != 0
        {
            return Err(SupervisorBootstrapError::TrailingBytes);
        }
        Ok(ReceivedSupervisorProcessHandoff {
            handoff,
            ready: SupervisorBootstrapReadyTransport { writer },
        })
    }
}

impl<R: Read> SentSupervisorProcessHandoff<R> {
    /// Receives exactly one bounded Ready and requires EOF on the response
    /// direction before accepting the physical supervisor.
    ///
    /// # Errors
    ///
    /// Rejects malformed, trailing, stale or mismatched Ready evidence.
    pub fn receive_ready(
        mut self,
        expected_supervisor_process_id: u32,
        expected_connection_id: &str,
        expected_endpoint_address: &str,
    ) -> Result<wire::SupervisorProcessReady, SupervisorBootstrapError> {
        let ready = codec(SUPERVISOR_PROCESS_READY_MAX_BYTES)
            .read(&mut self.reader)?
            .ok_or(SupervisorBootstrapError::UnexpectedEof)?;
        let mut trailing = [0_u8; 1];
        if self
            .reader
            .read(&mut trailing)
            .map_err(crate::framing::FramingError::Io)?
            != 0
        {
            return Err(SupervisorBootstrapError::TrailingBytes);
        }
        ready::validate(
            &ready,
            expected_supervisor_process_id,
            expected_connection_id,
            expected_endpoint_address,
        )?;
        Ok(ready)
    }
}

impl<W> ReceivedSupervisorProcessHandoff<W> {
    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        ValidatedSupervisorProcessHandoff,
        SupervisorBootstrapReadyTransport<W>,
    ) {
        (self.handoff, self.ready)
    }
}

impl<W: Write> SupervisorBootstrapReadyTransport<W> {
    /// Writes and flushes the sole bounded process Ready response.
    ///
    /// # Errors
    ///
    /// Propagates framing, write and flush failures while consuming the
    /// response transport.
    pub fn send(
        mut self,
        ready: &wire::SupervisorProcessReady,
    ) -> Result<(), SupervisorBootstrapError> {
        codec(SUPERVISOR_PROCESS_READY_MAX_BYTES).write(&mut self.writer, ready)?;
        self.writer.flush().map_err(SupervisorBootstrapError::Flush)
    }
}

impl<R, W> Debug for SupervisorPhysicalBootstrapReceiver<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorPhysicalBootstrapReceiver")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<R, W> Debug for SupervisorPhysicalBootstrapSender<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorPhysicalBootstrapSender")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<W> Debug for ReceivedSupervisorProcessHandoff<W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReceivedSupervisorProcessHandoff")
            .field("handoff", &self.handoff)
            .field("ready", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

impl<W> Debug for SupervisorBootstrapReadyTransport<W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorBootstrapReadyTransport")
            .field("transport", &"[PROTECTED]")
            .finish()
    }
}

impl<R> Debug for SentSupervisorProcessHandoff<R> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SentSupervisorProcessHandoff")
            .field("transport", &"[PROTECTED]")
            .finish_non_exhaustive()
    }
}

fn codec(maximum: usize) -> DelimitedFrameCodec {
    DelimitedFrameCodec::new(u32::try_from(maximum).expect("bootstrap cap fits u32"))
        .expect("bootstrap cap is non-zero")
}
