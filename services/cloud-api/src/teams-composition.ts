/** Teams composition root — D1 teams repo + opaque invite tokens → TeamsService.
 *  Per request, mirroring the other roots. (The entitlements union lives in the
 *  shared `entitlements.ts` resolver, not here.) */
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createTeamsRepo } from './infra/d1/teams-repo.js';
import { opaqueTokens } from './infra/opaque-tokens.js';
import { cryptoIdGen, systemClock } from './infra/runtime.js';
import { TeamsService } from './teams/service.js';
import type { Env } from './env.js';

export interface TeamsBundle {
  service: TeamsService;
}

export function createTeamsBundle(env: Env): TeamsBundle {
  const repo = createTeamsRepo(createD1Executor(env.DB));
  return { service: new TeamsService(repo, cryptoIdGen, systemClock, opaqueTokens) };
}
