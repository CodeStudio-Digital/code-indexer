import { describe, expect, it } from 'vitest';
import { parsePersistedAgentsGroup } from '../agents-group-parser.js';

describe('parsePersistedAgentsGroup', () => {
  it('keeps per-agent tool counts from compact transport output', () => {
    const input = {
      agents: [
        {
          label: 'Agent Tools', task: 'Inspect agent tools', profile: 'explore',
          research_depth: 'quick', target_tool_calls: 16, target_minutes: 3,
        },
        { label: 'Company Runtime', task: 'Inspect company runtime', profile: 'explore' },
        { label: 'API Transport', task: 'Inspect API transport', profile: 'explore' },
        { label: 'Indexer Internals', task: 'Inspect indexer internals', profile: 'explore' },
        { label: 'Docs Memory Telemetry', task: 'Inspect docs memory telemetry', profile: 'explore' },
        { label: 'Providers Cloud Security', task: 'Inspect providers cloud security', profile: 'explore' },
      ],
    };
    const content = [
      '[parallel agents: 6 agents, provider=chatgpt model=gpt-5.4-mini, input=600 output=60 cache_hit=0]',
      '',
      '### Agent 1: Agent Tools',
      '[type=explore reason=completed tools=27 input=100 output=10]',
      'summary 1',
      '',
      '---',
      '',
      '### Agent 2: Company Runtime',
      '[type=explore reason=completed tools=33 input=100 output=10]',
      'summary 2',
      '',
      '---',
      '',
      '### Agent 3: API Transport',
      '[type=explore reason=completed tools=29 input=100 output=10]',
      'summary 3',
      '',
      '---',
      '',
      '### Agent 4: Indexer Internals',
      '[type=explore reason=completed tools=47 input=100 output=10]',
      'summary 4',
      '',
      '---',
      '',
      '### Agent 5: Docs Memory Telemetry',
      '[type=explore reason=completed tools=40 input=100 output=10]',
      'summary 5',
      '',
      '---',
      '',
      '### Agent 6: Providers Cloud Security',
      '[type=explore reason=completed tools=17 input=100 output=10]',
      'summary 6',
      '',
      '… [truncated for transport — 36360 more chars in DB]',
    ].join('\n');

    const group = parsePersistedAgentsGroup(input, { content, isError: false });

    expect(group?.totalUsage).toEqual({ input_tokens: 600, output_tokens: 60 });
    expect(group?.agents.map((a) => a.toolCallCount)).toEqual([27, 33, 29, 47, 40, 17]);
    expect(group?.agents[0]).toMatchObject({
      label: 'Agent Tools',
      task: 'Inspect agent tools',
      agentType: 'explore',
      researchDepth: 'quick',
      softToolTarget: 16,
      softTimeTargetMs: 180_000,
    });
    expect(group?.agents[5].summary).toBe('summary 6');
  });

  it('reads the background flag from the tool input and attempt/reason from the meta', () => {
    const input = {
      background: true,
      agents: [
        { label: 'auth', task: 'trace auth', profile: 'explore' },
        { label: 'db', task: 'trace db', profile: 'explore' },
      ],
    };
    const content = [
      '[parallel agents: 2 agents, group=9d2c41aa, provider=chatgpt model=gpt-5.4-mini, input=200 output=20 cache_hit=0]',
      '',
      '### Agent 1: auth',
      '[type=explore reason=completed tools=5 input=100 output=10 attempt=2]',
      'ok',
      '',
      '---',
      '',
      '### Agent 2: db',
      '[type=explore reason=error tools=3 input=100 output=10]',
      'boom',
    ].join('\n');

    const group = parsePersistedAgentsGroup(input, { content, isError: false });
    expect(group?.background).toBe(true);
    expect(group?.agents[0].attempt).toBe(2);
    expect(group?.agents[1].reason).toBe('error');
    expect(group?.agents[1].status).toBe('error');
  });

  it('reads the max_tools hard cap from parallel meta and the single header', () => {
    const parallel = parsePersistedAgentsGroup(
      { agents: [{ label: 'auth', task: 'trace auth', profile: 'explore' }] },
      {
        content: [
          '[parallel agents: 1 agents, provider=chatgpt model=gpt-5.4-mini, input=100 output=10 cache_hit=0]',
          '',
          '### Agent 1: auth',
          '[type=explore reason=tool_budget tools=161 input=100 output=10 attempt=2 max_tools=160]',
          'partial findings',
        ].join('\n'),
        isError: false,
      },
    );
    expect(parallel?.agents[0]).toMatchObject({
      maxToolCalls: 160,
      attempt: 2,
      status: 'partial',
      toolCallCount: 161,
    });

    const single = parsePersistedAgentsGroup(
      { agents: [{ label: 'solo', task: 'inspect', profile: 'explore' }] },
      {
        content:
          '[subagent provider=chatgpt model=gpt-5.4-mini type=explore reason=completed ' +
          'input=100 output=10 cache_hit=0 spawn=ab12cd34 max_tools=80]\n\nreport text',
        isError: false,
      },
    );
    expect(single?.agents[0].maxToolCalls).toBe(80);
    expect(single?.groupId).toBe('ab12cd34');

    // Legacy rows without the token still parse, with no denominator.
    const legacy = parsePersistedAgentsGroup(
      { agents: [{ label: 'auth', task: 'trace auth', profile: 'explore' }] },
      {
        content: [
          '[parallel agents: 1 agents, provider=chatgpt model=gpt-5.4-mini, input=100 output=10 cache_hit=0]',
          '',
          '### Agent 1: auth',
          '[type=explore reason=completed tools=5 input=100 output=10]',
          'ok',
        ].join('\n'),
        isError: false,
      },
    );
    expect(legacy?.agents[0].maxToolCalls).toBeUndefined();
    expect(legacy?.agents[0].toolCallCount).toBe(5);
  });

  it('treats a background start receipt as running with stable job/group identity', () => {
    const input = {
      background: true,
      agents: [{ label: 'Scout', task: 'Inspect the renderer', profile: 'explore' }],
    };
    const result = {
      content: '[spawn_agent background] job=job-abcd group=group-1234 agents=1 (Scout) started.\nResults are NOT available yet.',
      isError: false,
    };

    const first = parsePersistedAgentsGroup(input, result, 'tool-spawn-1');
    const second = parsePersistedAgentsGroup(input, result, 'tool-spawn-1');

    expect(first).toMatchObject({
      groupId: 'group-1234',
      toolUseId: 'tool-spawn-1',
      jobId: 'job-abcd',
      background: true,
      status: 'running',
      agents: [{ status: 'pending' }],
    });
    expect(second?.groupId).toBe(first?.groupId);
  });

  it('uses a deterministic fallback instead of wall-clock identity', () => {
    const input = { agents: [{ label: 'Scout', task: 'Inspect' }] };
    const first = parsePersistedAgentsGroup(input, undefined);
    const second = parsePersistedAgentsGroup(input, undefined);
    expect(second?.groupId).toBe(first?.groupId);
  });

  it('preserves partial and failed terminal outcomes from persisted reports', () => {
    const input = { agents: [{ label: 'Budget' }, { label: 'Failure' }] };
    const result = {
      content: [
        '[parallel agents: 2 agents, group=outcomes, provider=chatgpt model=gpt-5, input=10 output=2 cache_hit=0]',
        '',
        '### Agent 1: Budget',
        '[type=explore reason=time_budget tools=3 input=5 output=1]',
        'partial findings',
        '',
        '---',
        '',
        '### Agent 2: Failure',
        '[type=explore reason=aborted tools=1 input=5 output=1]',
        'stopped',
      ].join('\n'),
      isError: false,
    };

    const group = parsePersistedAgentsGroup(input, result, 'spawn-outcomes');
    expect(group?.agents.map((agent) => agent.status)).toEqual(['partial', 'aborted']);
  });
});
