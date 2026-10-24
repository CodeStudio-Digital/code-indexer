use std::collections::VecDeque;
use std::io::{self, Read};

#[derive(Debug)]
pub struct CommandCapture {
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
    pub total_bytes: u64,
}

pub fn read(mut stream: impl Read, maximum: usize) -> io::Result<CommandCapture> {
    let head_max = maximum.div_ceil(2);
    let tail_max = maximum - head_max;
    let mut head = Vec::with_capacity(head_max);
    let mut tail = VecDeque::with_capacity(tail_max);
    let mut total_bytes = 0_u64;
    let mut buffer = [0_u8; 8192];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
            Err(error) => return Err(error),
        };
        total_bytes = total_bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("output byte overflow"))?;
        let head_count = count.min(head_max - head.len());
        head.extend_from_slice(&buffer[..head_count]);
        if tail_max > 0 {
            for byte in &buffer[head_count..count] {
                if tail.len() == tail_max {
                    tail.pop_front();
                }
                tail.push_back(*byte);
            }
        }
    }
    Ok(CommandCapture {
        head,
        tail: tail.into(),
        total_bytes,
    })
}
