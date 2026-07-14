export interface AppAgentProfileConfig {
  enabled: boolean;
  additional_prompt: string;
  /** Skill ids explicitly assigned to this execution profile. */
  skills: string[];
}

export interface AppAgentConfig {
  v: 1;
  coordinator_prompt: string;
  /** Skills pinned for work executed directly by the app coordinator. */
  coordinator_skills: string[];
  profiles: Record<string, AppAgentProfileConfig>;
}

const MAX_PROMPT_CHARS = 12_000;
const MAX_SKILLS = 64;

const prompt = (value: unknown): string =>
  typeof value === 'string' ? value.trim().slice(0, MAX_PROMPT_CHARS) : '';

const skills = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 160))
    .filter(Boolean))]
    .sort()
    .slice(0, MAX_SKILLS);
};

export function emptyAppAgentConfig(): AppAgentConfig {
  return { v: 1, coordinator_prompt: '', coordinator_skills: [], profiles: {} };
}

export function parseAppAgentConfig(value: unknown): AppAgentConfig {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) as unknown; } catch { return emptyAppAgentConfig(); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyAppAgentConfig();
  const record = raw as Record<string, unknown>;
  const profiles: Record<string, AppAgentProfileConfig> = {};
  if (record.profiles && typeof record.profiles === 'object' && !Array.isArray(record.profiles)) {
    for (const [name, candidate] of Object.entries(record.profiles as Record<string, unknown>)) {
      const key = name.trim().slice(0, 80);
      if (!key || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const profile = candidate as Record<string, unknown>;
      profiles[key] = {
        enabled: profile.enabled !== false,
        additional_prompt: prompt(profile.additional_prompt),
        skills: skills(profile.skills),
      };
    }
  }
  return {
    v: 1,
    coordinator_prompt: prompt(record.coordinator_prompt),
    coordinator_skills: skills(record.coordinator_skills),
    profiles,
  };
}

export function serializeAppAgentConfig(value: unknown): string {
  return JSON.stringify(parseAppAgentConfig(value));
}
