import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { DIAGRAM_RENDER_DOCUMENT } from '../document.js';

/** Exercise the shipped bridge script with a controlled frame and DOM parser;
 * the physical Electron fixture covers the actual browser and SVG parser. */
function fixture(dimensions: Record<string, string> = { width: '100', height: '100000' }) {
  const send = vi.fn(); const child = { postMessage: send };
  let listener!: (event: { source: unknown; data: string }) => void;
  const window: { addEventListener: (_name: string, callback: typeof listener) => void; __diagramRender?: (xml: string, format: string) => Promise<string> } = {
    addEventListener(_name, callback) { listener = callback; },
  };
  runInNewContext(DIAGRAM_RENDER_DOCUMENT.split('<script>')[1].split('</script>')[0], {
    window, document: { getElementById: () => ({ contentWindow: child }) },
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    DOMParser: class { parseFromString() { return { documentElement: { getAttribute: (name: string) => dimensions[name] } }; } },
  });
  return { send, render: window.__diagramRender!, receive(message: unknown, source: unknown = child) { listener({ source, data: JSON.stringify(message) }); } };
}

it('waits for the owned frame and bounds a very tall PNG before requesting rasterization', async () => {
  expect(DIAGRAM_RENDER_DOCUMENT).toContain('offline=1&pwa=0');
  const f = fixture(), image = f.render('<mxGraphModel/>', 'png');
  f.receive({ event: 'init' }, null); await Promise.resolve(); expect(f.send).not.toHaveBeenCalled();
  f.receive({ event: 'init' }); await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  expect(JSON.parse(f.send.mock.calls[0][0]).action).toBe('load');
  f.receive({ event: 'load' }); expect(JSON.parse(f.send.mock.calls[1][0]).format).toBe('svg');
  f.receive({ event: 'export', data: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  expect(JSON.parse(f.send.mock.calls[2][0])).toMatchObject({ format: 'xmlpng', scale: 0.02 });
  f.receive({ event: 'export', data: 'image result' }); await expect(image).resolves.toBe('image result');
});

it('rejects invalid geometry instead of requesting an unbounded canvas', async () => {
  const f = fixture({ width: 'NaN', height: '0' }), image = f.render('<mxGraphModel/>', 'png');
  const rejected = expect(image).rejects.toThrow('dimensions');
  f.receive({ event: 'init' }); await vi.waitFor(() => expect(f.send).toHaveBeenCalled());
  f.receive({ event: 'load' });
  f.receive({ event: 'export', data: 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  await rejected; expect(f.send).toHaveBeenCalledTimes(2);
});
