use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpoolQuota {
    limit_bytes: u64,
    reserved_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaError {
    ZeroLimit,
    Exceeded,
    ReleaseExceedsReservation,
}

impl Display for QuotaError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "spool quota error: {self:?}")
    }
}

impl Error for QuotaError {}

impl SpoolQuota {
    /// Creates a bounded spool quota.
    ///
    /// # Errors
    ///
    /// Returns [`QuotaError::ZeroLimit`] when no finite capacity is provided.
    pub const fn new(limit_bytes: u64) -> Result<Self, QuotaError> {
        if limit_bytes == 0 {
            return Err(QuotaError::ZeroLimit);
        }
        Ok(Self {
            limit_bytes,
            reserved_bytes: 0,
        })
    }

    #[must_use]
    pub const fn reserved_bytes(self) -> u64 {
        self.reserved_bytes
    }

    /// Reserves bytes before accepting content.
    ///
    /// # Errors
    ///
    /// Returns [`QuotaError::Exceeded`] when the addition overflows or exceeds
    /// the configured limit.
    pub fn reserve(&mut self, bytes: u64) -> Result<(), QuotaError> {
        let next = self
            .reserved_bytes
            .checked_add(bytes)
            .ok_or(QuotaError::Exceeded)?;
        if next > self.limit_bytes {
            return Err(QuotaError::Exceeded);
        }
        self.reserved_bytes = next;
        Ok(())
    }

    /// Releases a prior reservation.
    ///
    /// # Errors
    ///
    /// Returns [`QuotaError::ReleaseExceedsReservation`] when more bytes are
    /// released than currently reserved.
    pub fn release(&mut self, bytes: u64) -> Result<(), QuotaError> {
        self.reserved_bytes = self
            .reserved_bytes
            .checked_sub(bytes)
            .ok_or(QuotaError::ReleaseExceedsReservation)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{QuotaError, SpoolQuota};

    #[test]
    fn reservations_are_bounded_and_recoverable() {
        let mut quota = SpoolQuota::new(10).expect("valid quota");

        quota.reserve(7).expect("within quota");
        assert_eq!(quota.reserve(4), Err(QuotaError::Exceeded));
        quota.release(7).expect("release reservation");
        assert_eq!(quota.reserved_bytes(), 0);
    }
}
