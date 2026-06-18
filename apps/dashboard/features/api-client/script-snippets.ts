/** Insertable snippets for the Scripts tab (Postman `pm.*`). */
export interface Snippet { label: string; code: string; }

export const PRE_SNIPPETS: Snippet[] = [
  { label: 'Set env variable', code: `pm.environment.set("key", "value");` },
  { label: 'Set a header', code: `pm.request.headers.set("X-Trace", "1");` },
  { label: 'Timestamp variable', code: `pm.environment.set("ts", String(Date.now()));` },
];

export const TEST_SNIPPETS: Snippet[] = [
  { label: 'Status is 200', code: `pm.test("status is 200", () => pm.expect(pm.response).to.have.status(200));` },
  { label: 'Body has property', code: `pm.test("has id", () => pm.expect(pm.response.json()).to.have.property("id"));` },
  { label: 'Save token from response', code: `pm.environment.set("token", pm.response.json().token);` },
  { label: 'Response time < 500ms', code: `pm.test("fast", () => pm.expect(pm.response.responseTime).to.be.below(500));` },
];
