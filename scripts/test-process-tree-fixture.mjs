import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode = process.argv[2];
if (mode === 'leaf') {
  setInterval(() => {}, 1000);
} else if (mode === 'branch') {
  const leaf = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf'], { detached: true, stdio: 'ignore', windowsHide: true });
  leaf.unref();
  setInterval(() => {}, 1000);
} else {
  const branch = spawn(process.execPath, [fileURLToPath(import.meta.url), 'branch'], { detached: true, stdio: 'ignore', windowsHide: true });
  branch.unref();
  // Both descendant levels are detached deliberately; the Windows job owns them.
  setTimeout(() => { if (mode !== 'timeout') process.exit(0); }, 750);
  if (mode === 'timeout') setInterval(() => {}, 1000);
}
