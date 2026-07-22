import { apiBaseUrl } from '../../../lib/api-client.js';

export type EditorMediaKind = 'html' | 'svg' | 'image' | 'video' | 'audio' | 'pdf';
export type BinaryMediaKind = Exclude<EditorMediaKind, 'html' | 'svg'>;

const EXTENSION_KIND: Record<string, EditorMediaKind> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  opus: 'audio',
  pdf: 'pdf',
};

export function editorMediaKind(filePath: string): EditorMediaKind | null {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return extension ? EXTENSION_KIND[extension] ?? null : null;
}

export function rawProjectFileUrl(projectId: number, filePath: string): string {
  const base = apiBaseUrl().replace(/\/$/, '');
  return `${base}/api/projects/${projectId}/file/raw?path=${encodeURIComponent(filePath)}`;
}
