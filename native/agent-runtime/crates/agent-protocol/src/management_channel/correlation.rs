use crate::generated::v1 as wire;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LaunchCorrelation {
    identity: wire::AttemptIdentity,
    budget: wire::ResourceBudget,
    hard_deadline_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct QueryCorrelation {
    identity_filter: Option<wire::AttemptIdentity>,
    include_resource_samples: bool,
}

impl QueryCorrelation {
    pub(super) fn from_query(value: &wire::QuerySupervisorState) -> Self {
        Self {
            identity_filter: value.identity_filter.clone(),
            include_resource_samples: value.include_resource_samples,
        }
    }

    pub(super) fn accepts(&self, value: &wire::SupervisorState) -> bool {
        let resource_shape_matches = if self.include_resource_samples {
            value.resources.is_some()
                && value
                    .attempts
                    .iter()
                    .all(|attempt| attempt.resources.is_some())
        } else {
            value.resources.is_none()
                && value
                    .attempts
                    .iter()
                    .all(|attempt| attempt.resources.is_none())
        };
        if !resource_shape_matches {
            return false;
        }
        self.identity_filter.as_ref().is_none_or(|expected| {
            value.attempts.len() <= 1
                && value
                    .attempts
                    .iter()
                    .all(|attempt| attempt.identity.as_ref() == Some(expected))
        })
    }
}

impl LaunchCorrelation {
    pub(super) fn from_launch(value: &wire::LaunchAttemptProcess) -> Option<Self> {
        Some(Self {
            identity: value.identity.clone()?,
            budget: value.resource_budget?,
            hard_deadline_at_unix_ms: value.hard_deadline_at_unix_ms,
        })
    }

    pub(super) fn accepts(&self, value: &wire::LaunchAccepted) -> bool {
        value.identity.as_ref() == Some(&self.identity)
            && value.reserved_budget == Some(self.budget)
            && value.hard_deadline_at_unix_ms == self.hard_deadline_at_unix_ms
    }

    pub(super) fn rejects(&self, value: &wire::LaunchRejected) -> bool {
        value.identity.as_ref() == Some(&self.identity)
    }
}
