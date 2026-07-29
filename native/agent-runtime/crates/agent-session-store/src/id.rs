use crate::SessionStoreError;

macro_rules! uuid_identifier {
    ($name:ident, $error:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            /// Creates a canonical lowercase UUID-shaped identifier.
            ///
            /// # Errors
            ///
            /// Returns an error for non-canonical or path-capable input.
            pub fn parse(value: impl Into<String>) -> Result<Self, SessionStoreError> {
                let value = value.into();
                if !is_canonical_uuid(&value) {
                    return Err(SessionStoreError::$error);
                }
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

uuid_identifier!(SessionId, InvalidSessionId);
uuid_identifier!(OperationId, InvalidOperationId);
uuid_identifier!(WriterId, InvalidWriterId);

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{OperationId, SessionId};

    #[test]
    fn accepts_only_canonical_lowercase_uuid_shape() {
        let valid = "12345678-1234-1234-1234-123456789abc";
        assert!(SessionId::parse(valid).is_ok());
        assert!(OperationId::parse(valid).is_ok());
        assert!(SessionId::parse("../12345678-1234-1234-1234-123456789abc").is_err());
        assert!(SessionId::parse("12345678-1234-1234-1234-123456789ABC").is_err());
    }
}
