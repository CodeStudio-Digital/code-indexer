/**
 * Dev-only branding for the Electron binary so Windows shows "CodeStudio"
 * instead of "Electron" in Task Manager.
 *
 * Why this exists: in dev we spawn the prebuilt `node_modules/electron/dist/
 * electron.exe` directly (see dev.ts). Windows Task Manager derives an app's
 * friendly name from the executable's PE `FileDescription` version field, and
 * that prebuilt binary ships with `FileDescription = "Electron"`. Neither
 * `app.setName()` nor `app.setAppUserModelId()` change the Task Manager name —
 * only the version resource does. Packaged builds already get this right
 * (electron-builder renames the exe to CodeStudio.exe and stamps it via rcedit),
 * so this only matters for the dev launcher.
 *
 * We stamp the version resource in place with rcedit, guarded to win32 and made
 * idempotent via a sentinel marker next to the binary. The marker disappears
 * whenever `node_modules/electron` is reinstalled (the whole `dist` folder is
 * replaced), so the brand re-applies automatically on the next dev launch.
 */

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mirrors APP_DISPLAY_NAME in src/app-icon.ts and `productName` in
// electron-builder.json. Deliberately inlined rather than imported: this module
// runs in the dev *launcher* (plain Node/tsx, outside Electron), and app-icon.ts
// does a top-level `import { app } from 'electron'` that only resolves inside the
// Electron runtime — importing it here would crash dev startup.
const APP_DISPLAY_NAME = 'CodeStudio';

/** Sentinel filename written next to electron.exe once branding succeeds. */
const MARKER_NAME = '.codestudio-branded';

/**
 * Stamp the dev Electron binary's version resource so it reports as
 * "CodeStudio". No-op off Windows, when already branded, or on any failure
 * (fail-open: a locked binary from a running dev instance must never block the
 * launch).
 */
export async function brandDevBinary(electronBin: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!electronBin || !existsSync(electronBin)) return;

  const marker = path.join(path.dirname(electronBin), MARKER_NAME);
  if (existsSync(marker)) return; // already branded this install

  try {
    // Imported lazily: rcedit ships a Windows-only helper exe, so importing it
    // is only meaningful on the win32 path we already guarded above. The module
    // exposes the function as a *named* export (`{ rcedit }`), not `default`.
    const { rcedit } = await import('rcedit');

    const iconPath = path.join(__dirname, 'build', 'icon.ico');
    await rcedit(electronBin, {
      'version-string': {
        FileDescription: APP_DISPLAY_NAME,
        ProductName: APP_DISPLAY_NAME,
        CompanyName: APP_DISPLAY_NAME,
      },
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    });

    writeFileSync(marker, `${APP_DISPLAY_NAME}\n`);
  } catch (err) {
    // The most common cause is the exe being locked by an already-running dev
    // instance. Warn and continue — branding is a cosmetic convenience.
    console.warn(
      `[brand-dev-binary] could not stamp Electron binary as "${APP_DISPLAY_NAME}": ${
        (err as Error)?.message ?? err
      }`,
    );
  }
}
