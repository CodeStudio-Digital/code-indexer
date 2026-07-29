use std::io::{self, Cursor, Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use prost::Message;

use super::{DelimitedFrameChannel, DelimitedFrameCodec, FramingError};

#[derive(Clone, PartialEq, Message)]
struct TestFrame {
    #[prost(string, tag = "1")]
    value: String,
}

fn codec(maximum: u32) -> DelimitedFrameCodec {
    DelimitedFrameCodec::new(maximum).expect("non-zero cap")
}

#[test]
fn round_trips_a_canonical_length_delimited_message() {
    let expected = TestFrame {
        value: "bounded".to_owned(),
    };
    let mut encoded = Vec::new();
    codec(64)
        .write(&mut encoded, &expected)
        .expect("encode frame");

    let actual = codec(64)
        .read::<TestFrame>(&mut Cursor::new(encoded))
        .expect("decode frame")
        .expect("one frame");

    assert_eq!(actual, expected);
}

#[test]
fn clean_eof_is_distinct_from_a_truncated_prefix() {
    assert!(
        codec(64)
            .read::<TestFrame>(&mut Cursor::new([]))
            .expect("clean EOF")
            .is_none()
    );
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([0x80])),
        Err(FramingError::TruncatedLength)
    ));
}

#[test]
fn rejects_zero_non_canonical_and_overflowing_lengths() {
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([0])),
        Err(FramingError::EmptyFrame)
    ));
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([0x81, 0])),
        Err(FramingError::NonCanonicalLength)
    ));
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([0xff; 5])),
        Err(FramingError::LengthOverflow)
    ));
}

#[test]
fn rejects_an_oversized_length_before_reading_a_body() {
    let error = codec(1_024)
        .read::<TestFrame>(&mut Cursor::new([0x81, 0x08]))
        .expect_err("1,025 bytes exceeds cap");

    assert!(matches!(
        error,
        FramingError::FrameTooLarge {
            declared: 1_025,
            maximum: 1_024,
        }
    ));
}

#[test]
fn distinguishes_truncated_and_malformed_bodies() {
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([5, 0x0a])),
        Err(FramingError::TruncatedFrame { declared: 5 })
    ));
    assert!(matches!(
        codec(64).read::<TestFrame>(&mut Cursor::new([1, 0xff])),
        Err(FramingError::MalformedFrame(_))
    ));
}

#[test]
fn writer_rejects_a_message_above_the_cap() {
    let frame = TestFrame {
        value: "too large".repeat(8),
    };

    assert!(matches!(
        codec(8).write(&mut Vec::new(), &frame),
        Err(FramingError::FrameTooLarge { maximum: 8, .. })
    ));
}

#[test]
fn stateful_channel_poisoning_blocks_reads_after_desynchronization() {
    let bytes = [0x81, 0x00, 0x02, 0x0a, 0x00];
    let mut channel = DelimitedFrameChannel::new(codec(64), Cursor::new(bytes), Vec::<u8>::new());

    assert!(matches!(
        channel.read::<TestFrame>(),
        Err(FramingError::NonCanonicalLength)
    ));
    assert!(channel.is_poisoned());
    assert!(matches!(
        channel.read::<TestFrame>(),
        Err(FramingError::ChannelPoisoned)
    ));
    assert!(matches!(
        channel.into_inner(),
        Err(FramingError::ChannelPoisoned)
    ));
}

#[derive(Debug, Default)]
struct PartialWriter {
    accepted: usize,
}

impl Write for PartialWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.accepted == 0 {
            self.accepted = 1;
            Ok(bytes.len().min(1))
        } else {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "injected partial write",
            ))
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn stateful_channel_poisoning_blocks_writes_after_partial_output() {
    let message = TestFrame {
        value: "partial".into(),
    };
    let mut channel =
        DelimitedFrameChannel::new(codec(64), Cursor::new([]), PartialWriter::default());

    assert!(matches!(channel.write(&message), Err(FramingError::Io(_))));
    assert!(channel.is_poisoned());
    assert!(matches!(
        channel.write(&message),
        Err(FramingError::ChannelPoisoned)
    ));
    assert!(matches!(
        channel.into_inner(),
        Err(FramingError::ChannelPoisoned)
    ));
}

#[derive(Debug)]
struct DropIo(Arc<AtomicUsize>);

impl Drop for DropIo {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl Read for DropIo {
    fn read(&mut self, _bytes: &mut [u8]) -> io::Result<usize> {
        Ok(0)
    }
}

impl Write for DropIo {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn poison_closes_owned_streams_without_waiting_for_channel_drop() {
    let drops = Arc::new(AtomicUsize::new(0));
    let mut channel = DelimitedFrameChannel::new(
        codec(64),
        DropIo(Arc::clone(&drops)),
        DropIo(Arc::clone(&drops)),
    );

    channel.poison();

    assert_eq!(drops.load(Ordering::SeqCst), 2);
    assert!(channel.is_poisoned());
}
