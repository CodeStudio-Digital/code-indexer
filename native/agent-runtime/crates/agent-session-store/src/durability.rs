use crate::SessionStoreError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DurabilityClass {
    Authoritative,
    Durable,
    Coalesced,
}

impl DurabilityClass {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Authoritative => "authoritative",
            Self::Durable => "durable",
            Self::Coalesced => "coalesced",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, SessionStoreError> {
        match value {
            "authoritative" => Ok(Self::Authoritative),
            "durable" => Ok(Self::Durable),
            "coalesced" => Ok(Self::Coalesced),
            _ => Err(SessionStoreError::CorruptJournal),
        }
    }
}
