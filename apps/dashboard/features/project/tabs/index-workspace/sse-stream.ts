/**
 * Leitor mínimo de SSE-sobre-fetch. As rotas de index/embeddings emitem
 * frames `event:`/`data:` separados por linha em branco; esta função drena o
 * body de uma Response e chama `onEvent` uma vez por frame. Compartilhada pelo
 * hook de run e pelo de retry de embeddings — o loop de parse vive num lugar só.
 */
export async function readSseStream(
  res: Response,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const raw of frames) {
      let eventName = 'message';
      let dataStr = '';
      for (const ln of raw.split('\n')) {
        if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        onEvent(eventName, JSON.parse(dataStr) as Record<string, unknown>);
      } catch {
        /* frame malformado — ignora */
      }
    }
  }
}
