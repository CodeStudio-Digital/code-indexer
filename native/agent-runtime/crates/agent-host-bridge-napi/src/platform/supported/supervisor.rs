use std::sync::atomic::AtomicBool;

use agent_host_bridge::{
    AuthenticatedHostSupervisorChannel, HostSupervisorVerifiedStream, SupervisorCloseEvidence,
    SupervisorProcessOwner,
};
use napi::Result;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf, split};
use tokio::sync::Mutex;
use zeroize::Zeroize;

use super::MAX_TRANSPORT_CHUNK_BYTES;
use super::authority::{Activity, CloseAuthority};
use crate::error;

pub struct NativeSupervisorSet {
    binding: NativeSupervisorBinding,
    reader: Mutex<Option<ReadHalf<HostSupervisorVerifiedStream>>>,
    writer: Mutex<Option<WriteHalf<HostSupervisorVerifiedStream>>>,
    reading: AtomicBool,
    writing: AtomicBool,
    close: CloseAuthority,
    process: Mutex<ProcessState>,
}

struct NativeSupervisorBinding {
    connection_id: String,
    maximum_frame_bytes: u32,
    peer_pid: u32,
}

enum ProcessState {
    Owned(Option<SupervisorProcessOwner>),
    Settled(std::result::Result<SupervisorCloseEvidence, String>),
}

impl NativeSupervisorSet {
    pub fn from_owner(owner: AuthenticatedHostSupervisorChannel) -> Self {
        let binding = NativeSupervisorBinding {
            connection_id: owner.binding().connection_id().to_owned(),
            maximum_frame_bytes: owner.binding().maximum_frame_bytes(),
            peer_pid: owner.binding().peer_pid(),
        };
        let (_, stream, process) = owner.into_parts();
        let (reader, writer) = split(stream);
        Self {
            binding,
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            reading: AtomicBool::new(false),
            writing: AtomicBool::new(false),
            close: CloseAuthority::new(),
            process: Mutex::new(ProcessState::Owned(Some(process))),
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.binding.connection_id
    }

    pub const fn maximum_frame_bytes(&self) -> u32 {
        self.binding.maximum_frame_bytes
    }

    pub const fn peer_pid(&self) -> u32 {
        self.binding.peer_pid
    }

    pub fn is_closed(&self) -> bool {
        self.close.is_closed()
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "the mutex guard owns exclusive access to the split reader across the awaited read"
    )]
    pub async fn read(&self, maximum: u32) -> Result<Option<Vec<u8>>> {
        if maximum == 0 || maximum > MAX_TRANSPORT_CHUNK_BYTES {
            self.close.begin();
            return Err(error::invalid("native supervisor read cap is invalid"));
        }
        let _activity = Activity::acquire(&self.reading, "read", &self.close)?;
        self.close.ensure_open()?;
        let mut cancellation = self.close.subscribe();
        let mut bytes = vec![0; maximum as usize];
        let outcome = {
            let mut owner = self.reader.lock().await;
            let reader = owner.as_mut().ok_or_else(error::closed)?;
            tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    let _ = changed;
                    None
                }
                read = reader.read(&mut bytes) => Some(read),
            }
        };
        match outcome {
            None => {
                bytes.zeroize();
                Err(error::closed())
            }
            Some(Err(source)) => {
                bytes.zeroize();
                self.close.begin();
                Err(error::io("supervisor read", &source))
            }
            Some(Ok(0)) => {
                bytes.zeroize();
                self.reader.lock().await.take();
                Ok(None)
            }
            Some(Ok(length)) => {
                bytes.truncate(length);
                Ok(Some(bytes))
            }
        }
    }

    #[allow(
        clippy::significant_drop_tightening,
        reason = "the mutex guard owns exclusive access to the split writer across the awaited write"
    )]
    pub async fn write(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > MAX_TRANSPORT_CHUNK_BYTES as usize {
            self.close.begin();
            return Err(error::invalid("native supervisor write chunk is invalid"));
        }
        let _activity = Activity::acquire(&self.writing, "write", &self.close)?;
        self.close.ensure_open()?;
        let mut cancellation = self.close.subscribe();
        let mut owner = self.writer.lock().await;
        let writer = owner.as_mut().ok_or_else(error::closed)?;
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                let _ = changed;
                Err(error::closed())
            }
            result = writer.write_all(bytes) => {
                result.map_err(|source| {
                    self.close.begin();
                    error::io("supervisor write", &source)
                })
            }
        }
    }

    pub async fn close(&self) -> Result<SupervisorCloseEvidence> {
        self.close.begin();
        self.reader.lock().await.take();
        self.writer.lock().await.take();
        let mut state = self.process.lock().await;
        match &mut *state {
            ProcessState::Settled(result) => clone_close_result(result),
            ProcessState::Owned(owner) => {
                let owner = owner
                    .take()
                    .ok_or_else(|| error::supervisor_cleanup("process owner is unavailable"))?;
                let settled = tokio::task::spawn_blocking(move || owner.close())
                    .await
                    .map_err(|source| error::supervisor_cleanup(&source.to_string()))?
                    .map_err(|source| source.to_string());
                *state = ProcessState::Settled(settled);
                match &*state {
                    ProcessState::Settled(result) => clone_close_result(result),
                    ProcessState::Owned(_) => unreachable!("settled state was installed"),
                }
            }
        }
    }
}

fn clone_close_result(
    value: &std::result::Result<SupervisorCloseEvidence, String>,
) -> Result<SupervisorCloseEvidence> {
    value
        .as_ref()
        .copied()
        .map_err(|message| error::supervisor_cleanup(message))
}

impl Drop for NativeSupervisorSet {
    fn drop(&mut self) {
        self.close.begin();
    }
}
