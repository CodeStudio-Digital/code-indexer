import { parseMarkdownDocument } from './markdown-document.js';

self.onmessage = (event: MessageEvent<{ id: number; text: string }>) => {
  try {
    self.postMessage({ id: event.data.id, document: parseMarkdownDocument(event.data.text) });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: String(error) });
  }
};
