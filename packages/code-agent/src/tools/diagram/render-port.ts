/** Pure rendering bridge: it accepts XML, never filesystem paths, and performs
 * no project writes. The tool persists the validated image through its fence. */
export interface DiagramRenderRequest { requestId: string; xml: string; format: 'svg' | 'png' }
export interface DiagramRenderer {
  render(request: DiagramRenderRequest, signal?: AbortSignal): Promise<string>;
}
let renderer: DiagramRenderer | null = null;
export function setDiagramRenderer(value: DiagramRenderer | null): void { renderer = value; }
export function getDiagramRenderer(): DiagramRenderer | null { return renderer; }

export function decodeDiagramImage(data: unknown, format: 'svg' | 'png'): Buffer {
  if (typeof data !== 'string' || data.length > 12 * 1024 * 1024) throw new Error('Diagram image exceeds 8 MiB or has invalid content');
  const mime = format === 'png' ? 'image/png' : 'image/svg+xml';
  const prefix = `data:${mime};base64,`;
  if (!data.startsWith(prefix)) throw new Error(`Diagram renderer returned an unexpected ${format} encoding`);
  const encoded = data.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid diagram image base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new Error('Invalid or oversized diagram image');
  if (format === 'png' ? bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.subarray(12, 16).toString() !== 'IHDR' || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 2048
    || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 2048 : !/<svg[\s>]/.test(bytes.toString('utf8'))) {
    throw new Error(`Diagram renderer returned an invalid ${format} image`);
  }
  return bytes;
}
