import { expect, it } from 'vitest';
import { convertWebContent } from '../web/content-worker.js';

it('cancels expensive conversion while allowing event loop progress and awaits worker termination', async () => {
  const controller = new AbortController(); let ticked = false;
  const pending = convertWebContent('html', '<div><p>content</p></div>'.repeat(200000), controller.signal);
  setTimeout(() => { ticked = true; controller.abort(new Error('cancel conversion')); }, 20);
  await expect(pending).rejects.toThrow('cancel conversion'); expect(ticked).toBe(true);
  // Executor capacity is released only after the terminated worker is reaped.
  expect(await convertWebContent('html', '<h1>next</h1>')).toBe('# next');
});

it('rejects unbounded input before worker allocation', async () => {
  await expect(convertWebContent('html', 'x'.repeat(10 * 1024 * 1024 + 1))).rejects.toThrow('10 MiB');
});
