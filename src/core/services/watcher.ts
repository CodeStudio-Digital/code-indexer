import { watch, type FSWatcher } from 'chokidar';

export interface WatcherEvents {
  onFileChanged(files: string[]): void | Promise<void>;
}

export interface WatcherOptions {
  rootPath: string;
  debounce: number;
  ignorePatterns?: string[];
}

export class FileWatcherService {
  private watchers = new Map<number, FSWatcher>();
  private pendingChanges = new Map<number, Set<string>>();
  private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  startWatching(projectId: number, options: WatcherOptions, events: WatcherEvents): void {
    if (this.watchers.has(projectId)) return;

    const ignored = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      ...(options.ignorePatterns ?? []),
    ];

    const watcher = watch(options.rootPath, {
      persistent: true,
      ignoreInitial: true,
      ignored,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.pendingChanges.set(projectId, new Set());

    const handleChange = (filePath: string) => {
      const pending = this.pendingChanges.get(projectId)!;
      pending.add(filePath);

      // Reset debounce timer
      const existingTimer = this.debounceTimers.get(projectId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(async () => {
        const files = Array.from(pending);
        pending.clear();
        if (files.length > 0) {
          await events.onFileChanged(files);
        }
      }, options.debounce);

      this.debounceTimers.set(projectId, timer);
    };

    watcher.on('add', handleChange);
    watcher.on('change', handleChange);
    watcher.on('unlink', handleChange);

    this.watchers.set(projectId, watcher);
  }

  async stopWatching(projectId: number): Promise<void> {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(projectId);
    }

    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }

    this.pendingChanges.delete(projectId);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.watchers.keys());
    await Promise.all(ids.map(id => this.stopWatching(id)));
  }

  isWatching(projectId: number): boolean {
    return this.watchers.has(projectId);
  }

  listWatching(): number[] {
    return Array.from(this.watchers.keys());
  }
}
