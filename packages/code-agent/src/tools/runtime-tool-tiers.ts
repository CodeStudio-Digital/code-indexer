import type { CoderTool } from '@mcp/code-agent/core/tool.js';
/** Display data for an opt-in tool group (system-prompt listing). */
export interface CustomTierInfo {
  displayName: string;
  toolCount: number;
}
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';

export interface RuntimeToolTierCatalog {
  tierMap: Map<string, ToolTier>;
  summary: Map<string, CustomTierInfo>;
}

/**
 * Collect opt-in tiers declared by dynamic tools. Keeping this on the tool
 * object lets any runtime contributor register a tier without teaching the
 * core runner how its tool names are encoded.
 */
export function collectRuntimeToolTiers(
  tools: readonly CoderTool[],
): RuntimeToolTierCatalog {
  const tierMap = new Map<string, ToolTier>();
  const summary = new Map<string, CustomTierInfo>();

  for (const tool of tools) {
    if (!tool.runtimeTier) continue;
    const id = tool.runtimeTier.id.trim();
    const displayName = tool.runtimeTier.displayName.trim();
    if (!id || !displayName) {
      throw new Error(`Invalid runtime tier metadata for tool "${tool.name}".`);
    }

    tierMap.set(tool.name, id);
    const existing = summary.get(id);
    if (existing) {
      if (existing.displayName !== displayName) {
        throw new Error(
          `Runtime tier "${id}" has conflicting display names: ` +
            `"${existing.displayName}" and "${displayName}".`,
        );
      }
      existing.toolCount += 1;
    } else {
      summary.set(id, { displayName, toolCount: 1 });
    }
  }

  return { tierMap, summary };
}

/** Merge independently discovered dynamic tier summaries. */
export function mergeRuntimeTierSummaries(
  ...summaries: ReadonlyMap<string, CustomTierInfo>[]
): Map<string, CustomTierInfo> {
  const merged = new Map<string, CustomTierInfo>();
  for (const summary of summaries) {
    for (const [id, info] of summary) {
      const existing = merged.get(id);
      if (existing) {
        existing.toolCount += info.toolCount;
        if (!existing.displayName.includes(info.displayName)) {
          existing.displayName += ` + ${info.displayName}`;
        }
      } else {
        merged.set(id, { ...info });
      }
    }
  }
  return merged;
}
