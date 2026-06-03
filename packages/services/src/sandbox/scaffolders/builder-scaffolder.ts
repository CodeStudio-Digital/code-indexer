/**
 * Builder-mode scaffolder. Extends the standard Vite scaffolder with the
 * Builder studio's extras: a Tailwind + shadcn/ui foundation and the
 * source-stamp plugin + inspector runtime that power element selection.
 *
 * Parameterized by stack + `SourceStampPlugin` so React and (later) Vue
 * share this one class — the only per-framework piece is the stamp plugin.
 * `getScaffolder(stack, { studio: true })` constructs it when a stamp
 * plugin exists for the stack.
 */
import { ViteScaffolderBase } from './vite-scaffolder-base.js';
import type { ScaffoldContext } from './scaffolder-port.js';
import type { SandboxStack, ViteStampContribution } from '../types.js';
import type { SourceStampPlugin } from '../builder/source-stamp/types.js';
import { injectSourceStamp } from '../builder/scaffold/inject-stamp.js';
import { installTailwindShadcn } from '../builder/scaffold/tailwind-shadcn.js';

export interface BuilderScaffolderOptions {
  stack: SandboxStack;
  /** `--template` arg for `create-vite` (e.g. `react-ts`). */
  viteTemplate: string;
  /** Framework-specific source-stamp plugin (provides config + files). */
  sourceStamp: SourceStampPlugin;
  includeE2e?: boolean;
}

export class BuilderScaffolder extends ViteScaffolderBase {
  private readonly sourceStamp: SourceStampPlugin;

  constructor(options: BuilderScaffolderOptions) {
    super({
      stack: options.stack,
      viteTemplate: options.viteTemplate,
      includeE2e: options.includeE2e ?? false,
    });
    this.sourceStamp = options.sourceStamp;
  }

  /** Splice the framework's stamp (Babel plugin + `@/` alias) into vite.config. */
  protected override viteStampContribution(): ViteStampContribution {
    return this.sourceStamp.contribution().vite;
  }

  /**
   * After `npm install`: keep the base behaviour (optional Playwright),
   * then lay the Tailwind/shadcn foundation and inject the stamp files +
   * dev-only inspector import. Order matters — Tailwind first (touches
   * src/index.css), then the stamp (touches src/main.tsx).
   */
  protected override async afterInstall(ctx: ScaffoldContext): Promise<void> {
    await super.afterInstall(ctx);
    await installTailwindShadcn(ctx);
    await injectSourceStamp(this.sourceStamp, {
      driver: ctx.driver,
      containerId: ctx.containerId,
      workdir: ctx.workdir,
    });
  }
}
