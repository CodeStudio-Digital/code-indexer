import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';
import { CompanyStore } from '../../company-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

describe('Company runtime provenance', () => {
  let dir: string;
  let db: CodeIndexDB;
  let companyStore: CompanyStore;
  let sessionStore: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-company-runtime-'));
    const path = join(dir, 'test.db');
    db = new CodeIndexDB(path);
    companyStore = new CompanyStore(path);
    sessionStore = new SessionStore(path);
  });

  afterEach(() => {
    companyStore.close();
    sessionStore.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists runtime kind and configured/effective model provenance', () => {
    const project = db.createProject('app', join(dir, 'app'));
    const company = companyStore.createCompanySession({ name: 'App team', runtime_kind: 'app_studio' });
    const coder = sessionStore.createSession({
      project_id: project.id,
      title: 'Backend',
      provider: 'openai-chatgpt',
      model: 'gpt-effective',
    });
    const run = companyStore.createAgentRun({
      company_session_id: company.id,
      role: 'backend',
      coder_session_id: coder.id,
      project_ids: [project.id],
      provider: 'openai-chatgpt',
      model: 'gpt-effective',
      configured_provider: 'openai-chatgpt',
      configured_model: 'gpt-configured',
      dispatch_source: 'app_studio',
      fallback_reason: 'configured fallback #1',
    });

    expect(company.runtime_kind).toBe('app_studio');
    expect(run).toMatchObject({
      provider: 'openai-chatgpt',
      model: 'gpt-effective',
      configured_provider: 'openai-chatgpt',
      configured_model: 'gpt-configured',
      dispatch_source: 'app_studio',
      fallback_reason: 'configured fallback #1',
    });

    companyStore.updateAgentRunProvider(run.id, 'anthropic', 'claude-fallback', 'transient provider error');
    expect(companyStore.getAgentRun(run.id)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-fallback',
      configured_model: 'gpt-configured',
      fallback_reason: 'transient provider error',
    });
  });
});
