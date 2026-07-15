export interface EditResult { text: string; changed: boolean }

function newlineOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

interface TextBlock { openEnd: number; close: number }

/** Find a direct XML child without parsing/reformatting the document. */
function directXmlChild(text: string, parentName: string, childName: string): TextBlock | null {
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([A-Za-z_][\w:.-]*)\b[^>]*>/g;
  const stack: Array<{ name: string; openEnd: number; wanted: boolean }> = [];
  for (const match of text.matchAll(tags)) {
    if (!match[1] || match.index === undefined) continue;
    const raw = match[0];
    const name = match[1].split(':').pop()!.toLowerCase();
    if (raw.startsWith('</')) {
      const frame = stack.pop();
      if (frame?.wanted && frame.name === childName) return { openEnd: frame.openEnd, close: match.index };
      continue;
    }
    const parent = stack.at(-1)?.name;
    const frame = { name, openEnd: match.index + raw.length, wanted: name === childName && parent === parentName };
    if (!raw.endsWith('/>')) stack.push(frame);
  }
  return null;
}

interface MavenDependencyMatch { start: number; full: string; inner: string; innerOffset: number }

function findMavenDependency(body: string, groupId: string, artifactId: string): MavenDependencyMatch | null {
  for (const match of body.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const group = /<groupId>\s*([^<]+?)\s*<\/groupId>/i.exec(match[1])?.[1];
    const artifact = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/i.exec(match[1])?.[1];
    if (group === groupId && artifact === artifactId && match.index !== undefined) {
      return { start: match.index, full: match[0], inner: match[1], innerOffset: match[0].indexOf(match[1]) };
    }
  }
  return null;
}

export function addMavenDependency(text: string, id: string, version: string): EditResult {
  const [groupId, artifactId] = id.split(':');
  if (!groupId || !artifactId) throw new Error('Maven package id must be groupId:artifactId');
  const dependencies = directXmlChild(text, 'project', 'dependencies');
  if (dependencies) {
    const body = text.slice(dependencies.openEnd, dependencies.close);
    const existing = findMavenDependency(body, groupId, artifactId);
    if (existing) {
      const versionTag = /(<version\b[^>]*>)([\s\S]*?)(<\/version>)/i.exec(existing.inner);
      if (versionTag?.index !== undefined) {
        if (versionTag[2].trim() === version) return { text, changed: false };
        const leading = /^\s*/.exec(versionTag[2])?.[0] ?? '';
        const trailing = /\s*$/.exec(versionTag[2])?.[0] ?? '';
        const valueStart = dependencies.openEnd + existing.start + existing.innerOffset
          + versionTag.index + versionTag[1].length;
        const valueEnd = valueStart + versionTag[2].length;
        return {
          text: `${text.slice(0, valueStart)}${leading}${version}${trailing}${text.slice(valueEnd)}`,
          changed: true,
        };
      }

      // A matching dependency without an explicit version gets one directly
      // after artifactId, preserving inline versus line-oriented formatting.
      const artifactTag = /<artifactId\b[^>]*>[\s\S]*?<\/artifactId>/i.exec(existing.inner);
      if (!artifactTag || artifactTag.index === undefined) return { text, changed: false };
      const tagEnd = artifactTag.index + artifactTag[0].length;
      const lineStart = Math.max(existing.inner.lastIndexOf('\n', artifactTag.index) + 1, 0);
      const lineEndRaw = existing.inner.indexOf('\n', tagEnd);
      const lineEnd = lineEndRaw < 0 ? existing.inner.length : lineEndRaw;
      const ownLine = existing.inner.slice(lineStart, artifactTag.index).trim() === ''
        && existing.inner.slice(tagEnd, lineEnd).trim() === '';
      const indent = /^\s*/.exec(existing.inner.slice(lineStart, artifactTag.index))?.[0] ?? '';
      const insertion = ownLine ? `${newlineOf(text)}${indent}<version>${version}</version>` : `<version>${version}</version>`;
      const insertAt = dependencies.openEnd + existing.start + existing.innerOffset + tagEnd;
      return { text: `${text.slice(0, insertAt)}${insertion}${text.slice(insertAt)}`, changed: true };
    }
  }
  const nl = newlineOf(text);
  const dependencyBlock = (itemIndent: string, valueIndent: string): string => [
    `${itemIndent}<dependency>`,
    `${valueIndent}<groupId>${groupId}</groupId>`,
    `${valueIndent}<artifactId>${artifactId}</artifactId>`,
    `${valueIndent}<version>${version}</version>`,
    `${itemIndent}</dependency>`,
  ].join(nl);
  if (dependencies) {
    const lineStart = Math.max(text.lastIndexOf('\n', dependencies.close) + 1, 0);
    const linePrefix = text.slice(lineStart, dependencies.close);
    const closingOnOwnLine = /^\s*$/.test(linePrefix);
    const closeIndent = closingOnOwnLine ? linePrefix : /^\s*/.exec(linePrefix)?.[0] ?? '';
    const itemIndent = `${closeIndent}  `;
    const valueIndent = `${itemIndent}  `;
    const block = dependencyBlock(itemIndent, valueIndent);
    const insertion = closingOnOwnLine ? lineStart : dependencies.close;
    const leading = closingOnOwnLine ? '' : nl;
    const trailing = closingOnOwnLine ? '' : closeIndent;
    return { text: `${text.slice(0, insertion)}${leading}${block}${nl}${trailing}${text.slice(insertion)}`, changed: true };
  }
  const projectClose = text.lastIndexOf('</project>');
  if (projectClose < 0) throw new Error('invalid pom.xml: missing </project>');
  const section = `  <dependencies>${nl}${dependencyBlock('    ', '      ')}${nl}  </dependencies>${nl}`;
  const lineStart = Math.max(text.lastIndexOf('\n', projectClose) + 1, 0);
  return { text: `${text.slice(0, lineStart)}${section}${text.slice(lineStart)}`, changed: true };
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i + 2); if (i < 0) return -1; continue; }
    if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

/** First project-level dependencies block, excluding buildscript/subprojects. */
function dependenciesBlock(text: string): TextBlock | null {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '/' && text[i + 1] === '/') { i = text.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') { depth--; continue; }
    if (depth === 0 && text.startsWith('dependencies', i) && !/[\w$]/.test(text[i - 1] ?? '')) {
      const after = i + 'dependencies'.length;
      if (/[\w$]/.test(text[after] ?? '')) continue;
      const open = /^\s*\{/.exec(text.slice(after))?.[0];
      if (!open) continue;
      const openIndex = after + open.lastIndexOf('{');
      const close = closingBrace(text, openIndex);
      if (close >= 0) return { openEnd: openIndex + 1, close };
    }
  }
  return null;
}

export function addGradleDependency(text: string, id: string, version: string, kotlin: boolean): EditResult {
  const coordinate = `${id}:${version}`;
  const nl = newlineOf(text);
  const line = kotlin ? `    implementation("${coordinate}")` : `    implementation '${coordinate}'`;
  const block = dependenciesBlock(text);
  if (!block) {
    const prefix = text.length > 0 && !text.endsWith(nl) ? nl : '';
    return { text: `${text}${prefix}dependencies {${nl}${line}${nl}}${nl}`, changed: true };
  }
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`["']${escapedId}:[^"']+["']`).test(text.slice(block.openEnd, block.close))) {
    return { text, changed: false };
  }
  const before = text.slice(0, block.close);
  const separator = before.endsWith('\n') || before.endsWith('\r') ? '' : nl;
  return { text: `${before}${separator}${line}${nl}${text.slice(block.close)}`, changed: true };
}
