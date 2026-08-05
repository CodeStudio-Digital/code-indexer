#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineLimits {
    context_bytes: usize,
    provider_events: usize,
    provider_event_bytes: usize,
    response_bytes: usize,
    output_tokens: u64,
    cost_micros: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidEngineLimits;

impl EngineLimits {
    /// Creates hard in-memory and provider-usage bounds for one engine.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidEngineLimits`] when a bound is zero or the maximum
    /// provider event cannot fit inside the response window.
    pub const fn new(
        max_context_bytes: usize,
        max_provider_events: usize,
        max_provider_event_bytes: usize,
        max_response_bytes: usize,
        max_output_tokens: u64,
        max_cost_micros: u64,
    ) -> Result<Self, InvalidEngineLimits> {
        if max_context_bytes == 0
            || max_provider_events == 0
            || max_provider_event_bytes == 0
            || max_response_bytes == 0
            || max_provider_event_bytes > max_response_bytes
            || max_output_tokens == 0
            || max_cost_micros == 0
        {
            return Err(InvalidEngineLimits);
        }
        Ok(Self {
            context_bytes: max_context_bytes,
            provider_events: max_provider_events,
            provider_event_bytes: max_provider_event_bytes,
            response_bytes: max_response_bytes,
            output_tokens: max_output_tokens,
            cost_micros: max_cost_micros,
        })
    }

    pub(crate) const fn max_context_bytes(self) -> usize {
        self.context_bytes
    }

    pub(crate) const fn max_provider_events(self) -> usize {
        self.provider_events
    }

    pub(crate) const fn max_provider_event_bytes(self) -> usize {
        self.provider_event_bytes
    }

    pub(crate) const fn max_response_bytes(self) -> usize {
        self.response_bytes
    }

    pub(crate) const fn usage_within_budget(self, usage: ProviderUsage) -> bool {
        usage.output_tokens <= self.output_tokens && usage.cost_micros <= self.cost_micros
    }
}

use crate::ports::ProviderUsage;
