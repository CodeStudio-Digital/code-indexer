export const fixture = {
  pulled: 0, closed: 0, total: 10000,
  requests: [] as Array<{ op: string; input: unknown; options: unknown }>,
};
function cursor() {
  let index = 0;
  return {
    async *[Symbol.asyncIterator]() {
      while (index < fixture.total) { fixture.pulled++; yield { _id: String(++index), name: 'fixture' }; }
    },
    async close() { fixture.closed++; },
    async toArray(): Promise<never> { throw new Error('Unbounded materialization'); },
  };
}
export class ObjectId { constructor(readonly value: string) {} }
export class MongoClient {
  async connect() { return this; }
  async close() {}
  db() {
    return { collection: () => ({
      find: (input: unknown, options: unknown) => { fixture.requests.push({ op: 'find', input, options }); return cursor(); },
      aggregate: (input: unknown, options: unknown) => { fixture.requests.push({ op: 'aggregate', input, options }); return cursor(); },
    }) };
  }
}
