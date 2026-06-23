/**
 * The `diagram_*` tool set — author/edit draw.io diagrams as real `.drawio`
 * files in the project. Static array (each tool reads ctx.cwd and writes via
 * the fs port — no module-global store), registered once and gated to the
 * `diagram` tool tier so it only surfaces for the `diagram` agent (or after
 * `expand_toolset('diagram')`).
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { diagramCreateTool, diagramUpdateTool } from './mutate.js';
import { diagramReadTool, diagramListTool, diagramExportTool } from './query.js';

export const diagramTools: CoderTool[] = [
  diagramCreateTool,
  diagramUpdateTool,
  diagramReadTool,
  diagramListTool,
  diagramExportTool,
];
