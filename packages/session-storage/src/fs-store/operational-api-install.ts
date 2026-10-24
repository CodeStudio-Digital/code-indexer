export function installOperationalSessionApi(
  target: object,
  operations: object,
): void {
  const prototype = Object.getPrototypeOf(operations) as object;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const method = (operations as Record<string, unknown>)[name];
    if (typeof method === 'function') {
      Object.defineProperty(target, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: method.bind(operations),
      });
    }
  }
  for (const name of Object.getOwnPropertyNames(operations)) {
    if (
      [
        'advanced',
        'goals',
        'planning',
        'tasks',
        'taskRuns',
        'drive',
        'tools',
        'groups',
        'filesystemRoots',
      ].includes(name)
    ) {
      continue;
    }
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (operations as Record<string, unknown>)[name],
    });
  }
}
