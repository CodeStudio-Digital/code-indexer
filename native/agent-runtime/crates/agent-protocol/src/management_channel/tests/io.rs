use std::io::{self, Cursor, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Default)]
pub struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

impl RecordingWriter {
    pub fn bytes(&self) -> Vec<u8> {
        self.0.lock().expect("writer lock").clone()
    }
}

impl Write for RecordingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("writer lock")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct FailWriter {
    calls: Arc<AtomicUsize>,
    fail_at: usize,
}

impl FailWriter {
    pub fn new(fail_at: usize) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            fail_at,
        }
    }
}

impl Write for FailWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call >= self.fail_at {
            Err(io::Error::other("injected management write failure"))
        } else {
            Ok(buffer.len())
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
pub struct ObservedRead {
    inner: Cursor<Vec<u8>>,
    observed: Arc<AtomicBool>,
}

impl ObservedRead {
    pub fn new(bytes: Vec<u8>, observed: Arc<AtomicBool>) -> Self {
        Self {
            inner: Cursor::new(bytes),
            observed,
        }
    }
}

impl Read for ObservedRead {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(buffer)?;
        if count > 0 {
            self.observed.store(true, Ordering::SeqCst);
        }
        Ok(count)
    }
}
