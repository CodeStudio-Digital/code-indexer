import { describe, it, expect } from 'vitest';
import { buildDesignSystemMasterMessage } from '@apps/http-api/server/routes/design-system/round.js';
import type {
  DesignSystemSession,
  DesignSystemVersion,
} from '@mcp/store/design-system-store.js';

const baseSession: DesignSystemSession = {
  id: 1,
  company_session_id: 100,
  name: 'Acme UI',
  package_name: '@acme/ui',
  stack: 'react-ts',
  source_zip_hash: 'deadbeef',
  source_zip_path: '/host/data/uploads/x.zip',
  next_bump_hint: 'patch',
  mcp_server_config_id: null,
  created_at: '2026-04-25 10:00:00',
};

describe('buildDesignSystemMasterMessage', () => {
  it('embeds the autonomous-mode rules verbatim', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    // The autonomous directives are the most load-bearing piece of the
    // prompt — they prevent the master from blocking on human input.
    // Any rewording here should be deliberate, not accidental.
    expect(msg).toMatch(/DO NOT call `ask_user`/);
    expect(msg).toMatch(/DO NOT call `submit_plan`/);
    expect(msg).toMatch(/DO NOT pause waiting for human input/);
    expect(msg).toMatch(/End the round/);
  });

  it('renders the correct stack-specific skill for components-builder', () => {
    // Format: `Spawn role \`components-builder\`. Skill \`ds-components-<stack>\`.`
    // We assert the skill name appears verbatim somewhere in the prompt
    // (regardless of formatting around it) so refactors of the surrounding
    // prose don't fail the test, but a wrong stack absolutely does.
    expect(
      buildDesignSystemMasterMessage({
        dsSession: { ...baseSession, stack: 'react-ts' },
        latestPublished: null,
        extraInstructions: '',
      }),
    ).toMatch(/`ds-components-react`/);

    expect(
      buildDesignSystemMasterMessage({
        dsSession: { ...baseSession, stack: 'vue-ts' },
        latestPublished: null,
        extraInstructions: '',
      }),
    ).toMatch(/`ds-components-vue`/);

    expect(
      buildDesignSystemMasterMessage({
        dsSession: { ...baseSession, stack: 'angular' },
        latestPublished: null,
        extraInstructions: '',
      }),
    ).toMatch(/`ds-components-angular`/);
  });

  it('mentions 1.0.0 (initial) on the very first round', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/No previous version/);
    expect(msg).toMatch(/\*\*1\.0\.0\*\*/);
  });

  it('mentions the previous semver and bump_hint when there is a published version', () => {
    const previous: DesignSystemVersion = {
      id: 7,
      ds_session_id: 1,
      semver: '1.2.3',
      bump_kind: 'patch',
      is_auto_bump: true,
      status: 'published',
      source_hash: 'abcdef0123456789',
      tarball_path: '/x.tgz',
      manifest_json: null,
      mcp_manifest_json: null,
      docs_md: null,
      storybook_path: null,
      error: null,
      created_at: '2026-04-20 10:00:00',
      published_at: '2026-04-20 10:30:00',
    };
    const msg = buildDesignSystemMasterMessage({
      dsSession: { ...baseSession, next_bump_hint: 'minor' },
      latestPublished: previous,
      extraInstructions: '',
    });
    expect(msg).toMatch(/Last published version: 1\.2\.3/);
    expect(msg).toMatch(/source_hash=abcdef012345/);
    expect(msg).toMatch(/next bump kind is \*\*minor\*\*/);
  });

  it('appends operator extra instructions when provided', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: 'Please redesign Button with rounded-2xl corners.',
    });
    expect(msg).toMatch(/Operator instructions for this round/);
    expect(msg).toMatch(/redesign Button with rounded-2xl corners/);
  });

  it('omits the operator-instructions section when empty', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).not.toMatch(/Operator instructions for this round/);
  });

  it('points the agent at the pre-extracted ./design_system/ folder (no unzip)', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/already extracted at `\.\/design_system\/`/);
    expect(msg).toMatch(/No `unzip` step needed/);
  });

  it('warns the master not to ask subordinates to "load" their skill', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/Skills are template-locked/);
    expect(msg).toMatch(/skill markdown is already in their system prompt/);
  });

  it('embeds the FIDELITY mandate (preserve fonts, deps, colors)', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/FIDELITY/);
    expect(msg).toMatch(/Faithful empacotation, not redesign/);
    expect(msg).toMatch(/manifest\.json\.dependencies/);
    // Anchor examples that prove fidelity is concrete, not vague.
    expect(msg).toMatch(/Bootstrap, the package uses Bootstrap/);
    expect(msg).toMatch(/#9c27b0/);
  });

  it('lists all seven ds_ tools (incl. validation/audit gates) in a "Your DS toolbox" section', () => {
    // The model occasionally "forgets" tools as the system prompt grows;
    // listing the literal names (not just descriptive paragraphs) close
    // to the ABSOLUTE RULES anchors them. If this section drifts back to
    // a generic narrative, this test fails — by design.
    //
    // Session 73 incident (2026-04-25): the original prose said
    // "ds_record_component belongs to subordinates — do NOT call that
    // yourself". The model read that as "I don't have permission" and
    // escalated to the operator instead of calling the tool during a
    // recovery scenario where subordinates weren't running. The corrected
    // prose says "normally delegated to subordinates; you CAN call it
    // directly when subordinates aren't running" — anchor that wording.
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/## Your DS toolbox/);
    expect(msg).toMatch(/\*\*seven\*\*/);
    expect(msg).toMatch(/`ds_get_session_info\(\)`/);
    expect(msg).toMatch(/`ds_record_component\(/);
    expect(msg).toMatch(/`ds_validate_manifest\(/);
    expect(msg).toMatch(/`ds_validate_stories\(/);
    expect(msg).toMatch(/`ds_audit_package\(/);
    expect(msg).toMatch(/`ds_set_version_status\(/);
    expect(msg).toMatch(/`ds_publish_version\(/);
    // The master MUST be told it's allowed to call ds_record_component
    // directly during recovery — not just hinted at it.
    expect(msg).toMatch(/CAN call it directly when subordinates aren't running/);
  });

  it('runs ds_validate_stories as Phase 2 gate with retry-once for components-builder', () => {
    // Mirror of the Phase 1 gate: master must obligatorily call
    // ds_validate_stories after components-builder finishes, retry once with
    // the explicit error list, and explicitly fail the round on a second
    // failure. Phase 5b cannot recover from a Phase 2 vocab leak — that's
    // the whole reason this gate exists.
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/`ds_validate_stories\({ component_dir: 'pkg\/src' }\)`/);
    expect(msg).toMatch(/re-spawn `components-builder` exactly once/);
    expect(msg).toMatch(/Phase 5b cannot recover from a Phase 2 vocab leak/);
  });

  it('forces extractor to start from source-inventory.json and validates manifest v2 before build phases', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/Deterministic source inventory/);
    expect(msg).toMatch(/`\.\/source-inventory\.json`/);
    expect(msg).toMatch(/compact index/);
    expect(msg).toMatch(/recommended_read_order/);
    expect(msg).toMatch(/`\.\/source-inventory\/dependencies\.json`/);
    expect(msg).toMatch(/`\.\/source-inventory\/components\.json`/);
    expect(msg).toMatch(/DesignSystemManifestV2/);
    expect(msg).toMatch(/Every component MUST include/);
    expect(msg).toMatch(/`html`/);
    expect(msg).toMatch(/`source_refs`/);
    expect(msg).toMatch(/`props_schema`/);
    expect(msg).toMatch(/`ds_validate_manifest\({ manifest_path: 'manifest\.json', strict: true }\)`/);
    expect(msg).toMatch(/re-spawn `extractor` exactly once/);
  });

  it('runs deterministic package audit before publish and treats publish audit as a final gate', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/`ds_audit_package\({ pkg_dir: 'pkg' }\)` first/);
    expect(msg).toMatch(/MCP manifest/);
    expect(msg).toMatch(/Storybook static output/);
    expect(msg).toMatch(/React story prop drift/);
    expect(msg).toMatch(/publish tool also runs the audit as a final safety check/);
  });

  it('reinforces manifest-as-source-of-truth for stories vocabulary (session 73 v1.2.2 regression)', () => {
    // Background: agent generated `variant: 'contained'` in Button.stories.tsx
    // (Material UI vocabulary leaked from training), Bootstrap CSS only has
    // `.btn-primary`/`.btn-secondary`/etc., so the rendered className
    // `btn-contained` matched no rule and Storybook displayed the Button as
    // unstyled text "Primary". Lock the prompt's anti-leak instructions so
    // future refactors can't silently weaken them.
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/Manifest is the SINGLE source of truth/);
    expect(msg).toMatch(/Material UI vocabulary/);
    // The literal "subset" constraint binds the agent at instruction level.
    expect(msg).toMatch(/SUBSET of/);
    expect(msg).toMatch(/manifest\.props_schema/);
    // Anchor the v1.2.2 incident name so anyone reading future drift in tests
    // can trace it back to a real failure mode.
    expect(msg).toMatch(/v1\.2\.2/);
  });

  it('forbids emojis explicitly at master level', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/NO EMOJIS in the design system/);
    expect(msg).toMatch(/preserve them identically; if it doesn't, never add any/);
  });

  it('mandates that the master MUST publish or explicitly fail', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    expect(msg).toMatch(/YOU MUST PUBLISH OR FAIL EXPLICITLY/);
    expect(msg).toMatch(/`ds_publish_version\({ pkg_dir: 'pkg' }\)`/);
    expect(msg).toMatch(/`ds_set_version_status\({ status: 'failed'/);
    expect(msg).toMatch(/no graceful silent exit/i);
  });

  it('removes the manual `npm pack` step from the master pipeline (now done by the tool)', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: '',
    });
    // The master historically ran `cd pkg && npm pack` itself before calling
    // ds_publish_version — that was load-bearing wiring that broke (master
    // has no shell). Make sure the regression doesn't sneak back in: the
    // master prompt MUST NOT instruct the master to pack manually.
    // (Subordinates may still run `npm pack` for verification builds — but
    // that's separate from the publish flow.)
    expect(msg).not.toMatch(/cd pkg && npm pack/);
    expect(msg).not.toMatch(/instruct a brief subordinate.*npm pack/i);
    // The tool's self-pack should be advertised explicitly.
    expect(msg).toMatch(/runs `npm pack` itself/);
  });

  it('always ends with "START NOW"', () => {
    const msg = buildDesignSystemMasterMessage({
      dsSession: baseSession,
      latestPublished: null,
      extraInstructions: 'foo',
    });
    expect(msg.trimEnd().endsWith('## START NOW')).toBe(true);
  });
});
