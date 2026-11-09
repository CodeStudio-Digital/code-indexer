import { describe, expect, it, vi } from 'vitest';
import { buildPluginTools, type EnabledPlugin } from '@mcp/plugin-host';

const plugins: EnabledPlugin[] = [
  {
    namespace: 'hello-plugin',
    tools: [
      {
        name: 'echo',
        description: 'Echoes',
        parameters: { type: 'object', properties: {} },
        mutates: false,
        outputPolicy: {
          mode: 'structured',
          reducer: 'smart',
          recovery: 'output_store',
          maxInlineChars: 12_000,
          preserveOnError: true,
        },
      },
      { name: 'write', description: 'Writes', parameters: {}, mutates: true, riskLevel: 'write' },
    ],
  },
];

describe('buildPluginTools', () => {
  it('omits oversized plugin contracts while keeping healthy tools', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tools = buildPluginTools([{ namespace: 'fixture', tools: [
        { name: 'huge', description: '', parameters: { type: 'object', properties: {}, description: 'x'.repeat(70_000) } },
        { name: 'healthy', description: '', parameters: { type: 'object', properties: {} } },
      ] }], async () => ({ content: '' }));
      expect(tools.map(tool => tool.name)).toEqual(['plugin__fixture__healthy']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('omitted tool "fixture/huge"'));
    } finally { warn.mockRestore(); }
  });

  it('synthesizes namespaced CoderTools with mapped flags', () => {
    const tools = buildPluginTools(plugins, async () => ({ content: '' }));
    expect(tools.map((t) => t.name)).toEqual([
      'plugin__hello-plugin__echo',
      'plugin__hello-plugin__write',
    ]);

    const echo = tools[0];
    expect(echo.source).toBe('mcp_external');
    expect(echo.runtimeTier).toEqual({
      id: 'plugin:hello-plugin',
      displayName: 'plugin hello-plugin',
    });
    expect(echo.outputPolicy).toEqual({
      mode: 'structured',
      reducer: 'smart',
      recovery: 'output_store',
      maxInlineChars: 12_000,
      preserveOnError: true,
    });
    expect(echo.mutates).toBe(true);
    expect(echo.parallelSafe).toBe(false);
    expect(echo.riskLevel).toBe('write');

    // empty parameters get coerced to a valid object JSON schema
    expect(tools[1].parameters).toEqual({ type: 'object', properties: {} });
    expect(tools[1].mutates).toBe(true);
    expect(tools[1].riskLevel).toBe('write');
  });

  it('handler forwards to the invoker and maps the result', async () => {
    const sourceTruncations = [{
      technique: 'plugin-page-limit',
      inputSize: 20,
      outputSize: 10,
      unit: 'items' as const,
      recoverable: true,
      outputId: 'deadbeef',
    }];
    const invoke = vi.fn(async () => ({ content: 'pong', isError: false, sourceTruncations }));
    const tools = buildPluginTools(plugins, invoke);
    const res = await tools[0].handler({ text: 'x' }, { projectName: 'demo', cwd: '/tmp' } as never);
    expect(invoke).toHaveBeenCalledWith('hello-plugin', 'echo', { text: 'x' }, {
      projectName: 'demo',
      cwd: '/tmp',
    });
    expect(res.content).toBe('pong');
    expect(res.isError).toBe(false);
    expect(res.sourceTruncations).toEqual([{
      technique: 'plugin-page-limit',
      inputSize: 20,
      outputSize: 10,
      unit: 'items',
      recoverable: true,
    }]);
  });

  it('bounds malformed plugin omission metadata without trusting snapshot ids', async () => {
    const contributed = [
      null,
      'bad',
      ...Array.from({ length: 30 }, (_, index) => ({
        technique: `plugin-cap-${index}`,
        inputSize: 2,
        outputSize: 1,
        unit: 'items',
        recoverable: true,
        outputId: 'deadbeef',
      })),
    ];
    const tools = buildPluginTools(plugins, async () => ({
      content: 'bounded',
      sourceTruncations: contributed,
    }));

    const res = await tools[0].handler({}, { projectName: 'demo', cwd: '/tmp' } as never);
    expect(res.sourceTruncations).toHaveLength(14);
    expect(res.sourceTruncations?.every((source) => source.outputId === undefined)).toBe(true);
  });
});
