/**
 * Cocos2d-x / Cocos Creator adapter — TexturePacker "cocos2d" plist format 2
 * (XML property list), the shape `SpriteFrameCache::addSpriteFramesWithFile`
 * consumes. `rotated` is always false (pixel art never rotates) and `offset`
 * stays {0,0} because composeGrid cells are untrimmed full frames; trim
 * metadata still flows through sourceColorRect/sourceSize from the FrameRect.
 *
 * Frame keys are the rect names (plus a `.png` suffix, the cocos
 * convention); a nameless rect would fall back to `<assetSlug>_<idx3>.png`.
 * Keys and the texture file name are XML-escaped.
 */
import type { ComposedSheet, ExportMeta, FrameRect } from '../atlas-types.js';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Rect name → plist frame key (cocos keys carry the .png extension). */
function frameKey(rect: FrameRect, meta: ExportMeta, index: number): string {
  const base = rect.name || `${meta.assetSlug}_${String(index).padStart(3, '0')}`;
  return base.endsWith('.png') ? base : `${base}.png`;
}

function frameDictLines(rect: FrameRect): string[] {
  const ssz = rect.spriteSourceSize ?? { x: 0, y: 0, w: rect.w, h: rect.h };
  const src = rect.sourceSize ?? { w: rect.w, h: rect.h };
  return [
    '    <dict>',
    `      <key>frame</key><string>{{${rect.x},${rect.y}},{${rect.w},${rect.h}}}</string>`,
    '      <key>offset</key><string>{0,0}</string>',
    '      <key>rotated</key><false/>',
    `      <key>sourceColorRect</key><string>{{${ssz.x},${ssz.y}},{${rect.w},${rect.h}}}</string>`,
    `      <key>sourceSize</key><string>{${src.w},${src.h}}</string>`,
    '    </dict>',
  ];
}

/** Serialized TexturePacker plist format 2 XML (trailing newline). */
export function cocosPlistText(sheet: ComposedSheet, meta: ExportMeta, imageName: string): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>frames</key>',
    '  <dict>',
  ];
  sheet.rects.forEach((rect, i) => {
    lines.push(`    <key>${xmlEscape(frameKey(rect, meta, i))}</key>`, ...frameDictLines(rect));
  });
  lines.push(
    '  </dict>',
    '  <key>metadata</key>',
    '  <dict>',
    '    <key>format</key><integer>2</integer>',
    `    <key>textureFileName</key><string>${xmlEscape(imageName)}</string>`,
    `    <key>size</key><string>{${sheet.rgba.width},${sheet.rgba.height}}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
  );
  return `${lines.join('\n')}\n`;
}
