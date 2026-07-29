use std::fmt::{self, Display, Formatter};

use super::ControlError;

impl Display for ControlError {
    #[allow(clippy::too_many_lines)]
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRuntimeInstanceId(error) => {
                write!(formatter, "invalid runtime instance ID: {error}")
            }
            Self::InvalidAgentHello(reason) => write!(formatter, "invalid AgentHello: {reason}"),
            Self::InvalidHostHello(reason) => write!(formatter, "invalid HostHello: {reason}"),
            Self::Handshake(error) => Display::fmt(error, formatter),
            Self::LaunchAuthorityMismatch => {
                formatter.write_str("attempt differs from trusted launch authority")
            }
            Self::ConnectionNotEstablished => {
                formatter.write_str("host connection is not established")
            }
            Self::ConnectionContextMismatch => {
                formatter.write_str("frame differs from negotiated connection context")
            }
            Self::UnexpectedInboundMessage(kind) => {
                write!(formatter, "unexpected inbound control message {kind}")
            }
            Self::InboundFrame(error) => Display::fmt(error, formatter),
            Self::InvalidResolvedSpec(error) => {
                write!(formatter, "invalid resolved attempt spec: {error}")
            }
            Self::UnsupportedSpecSchemaVersion(version) => {
                write!(
                    formatter,
                    "resolved spec schema version {version} is unsupported"
                )
            }
            Self::InvalidSpecDeadline(value) => {
                write!(formatter, "resolved spec deadline {value} must be positive")
            }
            Self::SpecDeadlineExceedsLaunch { spec, launch } => write!(
                formatter,
                "resolved spec deadline {spec} exceeds launch hard deadline {launch}"
            ),
            Self::AttemptDeadlineExpired { deadline, now } => {
                write!(formatter, "attempt deadline {deadline} expired at {now}")
            }
            Self::InvalidEffectiveResourceBudget(field) => {
                write!(formatter, "invalid effective resource budget: {field}")
            }
            Self::EffectiveResourceBudgetMismatch => {
                formatter.write_str("effective resource budget differs from launch authority")
            }
            Self::InvalidEffectiveContainment(reason) => {
                write!(formatter, "invalid effective containment: {reason}")
            }
            Self::InvalidReadyAtUnixMs(value) => {
                write!(
                    formatter,
                    "ready timestamp {value} is outside the preparation window"
                )
            }
            Self::HydratedFactsTooLarge { length, maximum } => write!(
                formatter,
                "hydrated facts have {length} bytes; maximum is {maximum}"
            ),
            Self::InvalidHydrationToken => formatter.write_str("hydration token is invalid"),
            Self::PrepareNotHydrating => {
                formatter.write_str("attempt is not awaiting hydration completion")
            }
            Self::RequiredContainmentLevelMissing => {
                formatter.write_str("effective containment level is weaker than required")
            }
            Self::RequiredContainmentLimitMissing(limit) => {
                write!(
                    formatter,
                    "required containment limit {limit:?} is not enforced"
                )
            }
            Self::ContainmentCapabilityMismatch(limit) => write!(
                formatter,
                "containment capabilities do not prove enforced limit {limit:?}"
            ),
            Self::MissingSpecResourceBudget => {
                formatter.write_str("resolved spec resource budget is missing")
            }
            Self::MissingRequiredSpecSnapshot(field) => {
                write!(formatter, "resolved spec snapshot {field} is missing")
            }
            Self::MissingSpecTask => formatter.write_str("resolved spec task is missing"),
            Self::MissingSpecTaskBody => formatter.write_str("resolved spec task body is missing"),
            Self::InvalidSpecField(field) => {
                write!(formatter, "resolved spec field {field} is invalid")
            }
            Self::InvalidSnapshot {
                collection,
                index,
                reason,
            } => write!(
                formatter,
                "invalid {collection} snapshot at index {index}: {reason}"
            ),
            Self::SnapshotCoverageMismatch => {
                formatter.write_str("snapshot manifest differs from resolved spec")
            }
            Self::ArtifactCoverageMismatch => {
                formatter.write_str("artifact manifest differs from resolved spec")
            }
            Self::ArtifactOwnerMismatch { index } => {
                write!(
                    formatter,
                    "artifact at index {index} belongs to another session"
                )
            }
            Self::ArtifactBudgetExceeded => {
                formatter.write_str("resolved artifact bytes exceed the attempt budget")
            }
            Self::InvalidValidatedArtifact { index, reason } => {
                write!(
                    formatter,
                    "invalid validated artifact at index {index}: {reason}"
                )
            }
            Self::MissingIdentity => formatter.write_str("attempt identity is missing"),
            Self::MissingSpecIdentity => {
                formatter.write_str("resolved attempt spec identity is missing")
            }
            Self::InvalidIdentity(error) => write!(formatter, "invalid attempt identity: {error}"),
            Self::SpecIdentityMismatch => {
                formatter.write_str("prepare identity differs from resolved spec identity")
            }
            Self::ActivationIdentityMismatch => {
                formatter.write_str("activation identity differs from prepared attempt identity")
            }
            Self::EmptyEncodedSpec => formatter.write_str("encoded resolved spec is empty"),
            Self::ZeroSpecSchemaVersion => {
                formatter.write_str("resolved spec schema version must be positive")
            }
            Self::MalformedResolvedSpec => {
                formatter.write_str("encoded resolved spec is malformed")
            }
            Self::SpecSchemaVersionMismatch { outer, decoded } => write!(
                formatter,
                "resolved spec schema version {decoded} differs from outer version {outer}"
            ),
            Self::InvalidIdempotencyKey(error) => {
                write!(formatter, "invalid idempotency key: {error}")
            }
            Self::InvalidTerminationReasonCode(error) => {
                write!(formatter, "invalid termination reason code: {error}")
            }
            Self::InvalidTerminationReasonCodeCharacters => {
                formatter.write_str("termination reason code contains unsupported characters")
            }
            Self::InvalidActivationNonce(error) => {
                write!(formatter, "invalid activation nonce: {error}")
            }
            Self::InvalidExpectedSpecHashLength(length) => write!(
                formatter,
                "expected spec SHA-256 has {length} bytes; expected 32"
            ),
            Self::InvalidActivationSpecHashLength(length) => write!(
                formatter,
                "activation spec SHA-256 has {length} bytes; expected 32"
            ),
            Self::SpecHashMismatch => formatter.write_str("resolved spec SHA-256 does not match"),
            Self::SemanticHash(error) => write!(formatter, "semantic hash failed: {error}"),
            Self::ControlMessageTooLarge { length, maximum } => write!(
                formatter,
                "control message has {length} bytes; maximum is {maximum}"
            ),
            Self::PreparedResponseTooLarge { length, maximum } => write!(
                formatter,
                "prepared response has {length} bytes; maximum is {maximum}"
            ),
            Self::InvalidOutboundHeader(reason) => {
                write!(formatter, "invalid outbound control header: {reason}")
            }
            Self::FrameEncoding(error) => {
                write!(formatter, "control frame encoding failed: {error}")
            }
            Self::PrepareConflict => {
                formatter.write_str("prepare conflicts with the assigned attempt")
            }
            Self::ActivationBeforePrepare => {
                formatter.write_str("attempt cannot activate before prepare")
            }
            Self::ActivationConflict => {
                formatter.write_str("activation conflicts with the accepted activation")
            }
            Self::TerminationIdentityMismatch => {
                formatter.write_str("termination identity differs from the active attempt")
            }
            Self::TerminationNotActive => {
                formatter.write_str("attempt cannot terminate before activation")
            }
            Self::TerminationConflict => {
                formatter.write_str("termination conflicts with the accepted termination")
            }
            Self::InvalidCancelAttempt(reason) => {
                write!(formatter, "invalid CancelAttempt: {reason}")
            }
            Self::InvalidFenceAttempt(reason) => {
                write!(formatter, "invalid FenceAttempt: {reason}")
            }
            Self::ZeroAgentRunVersion => formatter.write_str("agent run version must be positive"),
            Self::ZeroAttemptVersion => formatter.write_str("attempt version must be positive"),
            Self::ActivationAgentRunVersionMismatch { expected, actual } => write!(
                formatter,
                "activation agent run version {actual} differs from sealed version {expected}"
            ),
            Self::ActivationAttemptVersionMismatch { expected, actual } => write!(
                formatter,
                "activation attempt version {actual} differs from sealed version {expected}"
            ),
            Self::ActivationNonceMismatch => {
                formatter.write_str("activation nonce differs from sealed SHA-256 commitment")
            }
            Self::ActivationDeadlineExceedsSpec {
                requested,
                immutable,
            } => write!(
                formatter,
                "activation deadline {requested} exceeds immutable deadline {immutable}"
            ),
            Self::Lifecycle(error) => Display::fmt(error, formatter),
        }
    }
}
