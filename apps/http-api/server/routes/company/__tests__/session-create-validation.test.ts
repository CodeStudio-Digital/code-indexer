import { describe, expect, it } from 'vitest';
import {
  resolveRoleProjectBindings,
} from '../session-create-validation.js';

const projects = [
  {
    id: 184,
    name: 'LaunchBoard Benchmark Backend',
    root_path: 'D:\\work\\launchboard\\backend',
    label: 'backend-api',
  },
  {
    id: 185,
    name: 'LaunchBoard Benchmark Frontend',
    root_path: 'D:\\work\\launchboard\\frontend',
    label: 'public-frontend',
  },
  {
    id: 186,
    name: 'LaunchBoard Benchmark Admin',
    root_path: 'D:\\work\\launchboard\\admin',
    label: 'admin-console',
  },
];

describe('resolveRoleProjectBindings', () => {
  it('resolves one or many symbolic template hints against selected projects', () => {
    const resolved = resolveRoleProjectBindings(
      [
        {
          role: 'backend',
          provider: 'zai',
          model: 'glm-4.7',
          tier: 'navigate',
          projectHints: ['backend'],
        },
        {
          role: 'frontend',
          provider: 'zai',
          model: 'glm-4.7',
          tier: 'navigate',
          projectHints: ['frontend', 'admin'],
        },
      ],
      projects,
    );

    expect(resolved[0].projectIds).toEqual([184]);
    expect(resolved[1].projectIds).toEqual([185, 186]);
  });

  it('uses common service aliases without broad substring matching', () => {
    const resolved = resolveRoleProjectBindings(
      [
        {
          role: 'backend',
          provider: 'zai',
          model: 'glm-4.5',
          tier: 'navigate',
          projectHints: ['backend'],
        },
        {
          role: 'frontend',
          provider: 'zai',
          model: 'glm-5',
          tier: 'navigate',
          projectHints: ['frontend'],
        },
      ],
      [
        { id: 1, name: 'Orders API', root_path: 'D:\\apps\\orders-api' },
        { id: 2, name: 'Customer Web', root_path: 'D:\\apps\\customer-web' },
        { id: 3, name: 'Capital Reports', root_path: 'D:\\apps\\capital' },
      ],
    );

    expect(resolved[0].projectIds).toEqual([1]);
    expect(resolved[1].projectIds).toEqual([2]);
  });

  it('preserves explicit selected bindings and leaves unmatched hints unbound', () => {
    const resolved = resolveRoleProjectBindings(
      [
        {
          role: 'backend',
          provider: 'zai',
          model: 'glm-4.7',
          tier: 'navigate',
          projectHints: ['frontend'],
          projectIds: [184, 999],
        },
        {
          role: 'mobile',
          provider: 'zai',
          model: 'glm-5.1',
          tier: 'navigate',
          projectHints: ['mobile'],
        },
      ],
      projects,
    );

    expect(resolved[0].projectIds).toEqual([184]);
    expect(resolved[1].projectIds).toBeUndefined();
    expect(resolved[1].projectHints).toEqual(['mobile']);
  });
});
