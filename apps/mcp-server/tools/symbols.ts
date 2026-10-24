import type { McpTool } from '../tool.js';
import { findReferences as find_references } from './symbol-references.js';
import { getSymbolBody as get_symbol_body } from './symbol-body.js';
import { getHierarchy as get_hierarchy, findImplementations as find_implementations } from './type-relations.js';
import { semanticNeighbors as semantic_neighbors } from './semantic-neighbors.js';
import { traceUsage as trace_usage } from './usage-trace.js';
import { prepareEdit as prepare_edit } from './prepare-edit.js';

// Retired get_symbol_details/get_class_members remain absent from the surface.
export const symbolTools: McpTool[] = [
  find_references,
  get_hierarchy,
  find_implementations,
  trace_usage,
  get_symbol_body,
  prepare_edit,
  semantic_neighbors,
];
