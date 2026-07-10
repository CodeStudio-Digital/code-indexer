/**
 * Stack pin validated against the official Cloudflare documentation.
 * Update this profile centrally after scaffold/tests pass; individual agents
 * may research newer guidance but never mutate managed runtime fields.
 */
export const APP_STUDIO_STACK_PROFILE = {
  id: 'cf-fullstack-v1',
  compatibilityDate: '2026-07-03',
  checkedAt: '2026-07-09T00:00:00.000Z',
  officialSources: [
    'https://developers.cloudflare.com/workers/vite-plugin/',
    'https://developers.cloudflare.com/workers/testing/vitest-integration/',
    'https://developers.cloudflare.com/d1/reference/migrations/',
  ],
} as const;

export const APP_STACK_PROFILE_ID = APP_STUDIO_STACK_PROFILE.id;
