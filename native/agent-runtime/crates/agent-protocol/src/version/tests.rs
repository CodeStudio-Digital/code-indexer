use super::{
    AgentCompatibility, CompatibilityError, FeatureSet, HostCompatibility, ProtocolRange,
    ProtocolVersion, negotiate,
};

fn range(min_minor: u16, max_minor: u16) -> ProtocolRange {
    ProtocolRange::new(
        ProtocolVersion::new(1, min_minor),
        ProtocolVersion::new(1, max_minor),
    )
    .expect("valid range")
}

fn agent() -> AgentCompatibility {
    AgentCompatibility {
        versions: range(0, 3),
        supported_features: FeatureSet::from_bits(0b111),
        required_features: FeatureSet::from_bits(0b001),
        build_id: "runner-good".to_owned(),
    }
}

fn host() -> HostCompatibility {
    HostCompatibility {
        versions: range(0, 1),
        supported_features: FeatureSet::from_bits(0b011),
        required_features: FeatureSet::from_bits(0b010),
        revoked_build_ids: Vec::new(),
    }
}

#[test]
fn frame_header_version_round_trips_the_declared_packing() {
    let version = ProtocolVersion::new(1, 1);

    assert_eq!(version.to_wire(), 65_537);
    assert_eq!(ProtocolVersion::from_wire(65_537), version);
}

#[test]
fn selects_highest_common_minor_and_ignores_optional_unknown_feature() {
    let negotiated = negotiate(&agent(), &host()).expect("compatible peers");

    assert_eq!(negotiated.version, ProtocolVersion::new(1, 1));
    assert_eq!(negotiated.features.bits(), 0b011);
}

#[test]
fn rejects_incompatible_major() {
    let mut incompatible_host = host();
    incompatible_host.versions =
        ProtocolRange::new(ProtocolVersion::new(2, 0), ProtocolVersion::new(2, 2))
            .expect("valid range");

    assert_eq!(
        negotiate(&agent(), &incompatible_host),
        Err(CompatibilityError::IncompatibleVersion)
    );
}

#[test]
fn rejects_missing_required_feature() {
    let mut demanding_host = host();
    demanding_host.required_features = FeatureSet::from_bits(0b1000);
    demanding_host.supported_features = FeatureSet::from_bits(0b1011);

    assert_eq!(
        negotiate(&agent(), &demanding_host),
        Err(CompatibilityError::AgentMissingRequiredFeatures {
            missing: FeatureSet::from_bits(0b1000),
        })
    );
}

#[test]
fn rejects_revoked_build() {
    let mut revoking_host = host();
    revoking_host.revoked_build_ids = vec!["runner-good".to_owned()];

    assert_eq!(
        negotiate(&agent(), &revoking_host),
        Err(CompatibilityError::RevokedBuild)
    );
}
