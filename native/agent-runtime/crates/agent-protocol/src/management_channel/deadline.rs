use super::ManagementChannelError;

/// Relative outbound deadline selected by a handler.
///
/// The private header authority converts this duration to its own clock domain
/// and rejects values above the immutable negotiated write timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagementDeadlinePolicy {
    timeout_ms: u64,
}

impl ManagementDeadlinePolicy {
    /// Creates a non-zero relative timeout.
    ///
    /// # Errors
    ///
    /// Zero cannot produce a usable deadline.
    pub const fn new(timeout_ms: u64) -> Result<Self, ManagementChannelError> {
        if timeout_ms == 0 {
            return Err(ManagementChannelError::InvalidDeadlinePolicy {
                timeout_ms,
                maximum: 0,
            });
        }
        Ok(Self { timeout_ms })
    }

    pub(super) fn deadline_at(
        self,
        sent_at_unix_ms: i64,
        maximum_timeout_ms: u64,
    ) -> Result<i64, ManagementChannelError> {
        if self.timeout_ms > maximum_timeout_ms {
            return Err(ManagementChannelError::InvalidDeadlinePolicy {
                timeout_ms: self.timeout_ms,
                maximum: maximum_timeout_ms,
            });
        }
        let timeout = i64::try_from(self.timeout_ms).map_err(|_| {
            ManagementChannelError::InvalidDeadlinePolicy {
                timeout_ms: self.timeout_ms,
                maximum: maximum_timeout_ms,
            }
        })?;
        sent_at_unix_ms
            .checked_add(timeout)
            .ok_or(ManagementChannelError::InvalidDeadlinePolicy {
                timeout_ms: self.timeout_ms,
                maximum: maximum_timeout_ms,
            })
    }
}
