import type { JsonSchema } from '@mcp/code-agent/core/tool.js';

function schemaProperties(schema: JsonSchema): Record<string, unknown> | null {
  if (typeof schema !== 'object' || schema === null) return null;
  const props = (schema as { properties?: unknown }).properties;
  return typeof props === 'object' && props !== null && !Array.isArray(props)
    ? props as Record<string, unknown>
    : null;
}

/**
 * `project_name` is a bridge concern, not a model concern. The MCP server still
 * requires it, but the bridge knows the exact project behind this tool instance
 * and injects it at call time. Hiding the field prevents weak models/subagents
 * from sending placeholders like `project` or `""`. In global sessions each
 * bridge instance is bound to one explicit linked real project.
 */
export function stripInjectedProjectName(schema: JsonSchema): JsonSchema {
  const props = schemaProperties(schema);
  if (!props || !('project_name' in props)) return schema;

  const publicProps = { ...props };
  delete publicProps.project_name;

  const publicSchema: Record<string, unknown> = {
    ...(schema as unknown as Record<string, unknown>),
    properties: publicProps,
  };

  const required = (schema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const publicRequired = required.filter((key) => key !== 'project_name');
    if (publicRequired.length > 0) {
      publicSchema.required = publicRequired;
    } else {
      delete publicSchema.required;
    }
  }

  return publicSchema as unknown as JsonSchema;
}
