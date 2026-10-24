export const fixture = {
  events: [] as Array<{ method: string; db: number; args: unknown[] }>,
  select: async (_db: number): Promise<void> => {},
  execute: async (_method: string, _db: number, _args: unknown[]): Promise<unknown> => 'OK',
};
export default class RedisFixture {
  status = 'ready';
  private readonly ended: Array<() => void> = [];
  async connect() {}
  once(_event: 'end', listener: () => void) { this.ended.push(listener); }
  disconnect() { this.status = 'end'; for (const listener of this.ended) listener(); }
  private db = 0;
  async select(db: number) {
    fixture.events.push({ method: 'SELECT', db, args: [] });
    await fixture.select(db); this.db = db;
  }
  async call(method: string, ...args: unknown[]) {
    fixture.events.push({ method: method.toUpperCase(), db: this.db, args });
    return fixture.execute(method.toUpperCase(), this.db, args);
  }
  pipeline() {
    const commands: Array<[string, unknown[]]> = [];
    const target = { exec: async () => Promise.all(commands.map(async ([name, args]) => {
        try { return [null, await this.call(name, ...args)]; } catch (error) { return [error, undefined]; }
      })) };
    const pipe: any = new Proxy(target, { get: (value, property) => property in value ? Reflect.get(value, property)
      : (...args: unknown[]) => { commands.push([String(property), args]); return pipe; } });
    return pipe;
  }
}
