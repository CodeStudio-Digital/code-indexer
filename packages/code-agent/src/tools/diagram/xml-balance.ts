/** A linear tag-balance scan for the uncompressed mxGraph XML accepted by the
 * diagram tools. Quoted values, comments and CDATA cannot confuse tag matching. */
export interface XmlTag {
  name: string;
  attributes: Readonly<Record<string, string>>;
  start: number;
  end: number;
  parent?: string;
  closing: boolean;
  selfClosing: boolean;
}

export function checkBalanced(xml: string, visit?: (tag: XmlTag) => void): string | null {
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (stack.length === 0 && xml.slice(cursor, start < 0 ? undefined : start).trim()) return 'text outside the XML document';
    if (start < 0) break;
    let terminator: string | undefined;
    if (xml.startsWith('<!--', start)) terminator = '-->';
    else if (xml.startsWith('<![CDATA[', start)) terminator = ']]>';
    else if (xml.startsWith('<?', start)) terminator = '?>';
    if (terminator) {
      const end = xml.indexOf(terminator, start + 2);
      if (end < 0) return 'unclosed XML comment, CDATA or declaration';
      cursor = end + terminator.length; continue;
    }
    if (xml.startsWith('<!', start)) return 'DOCTYPE and entity declarations are not supported in diagram XML';
    let quote = '', end = start + 1;
    for (; end < xml.length; end++) {
      const char = xml[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') return 'unclosed tag before another opening bracket';
    }
    if (end === xml.length) return 'unclosed tag or attribute value';
    const tag = xml.slice(start + 1, end).trim();
    const match = /^\/?([a-zA-Z][\w.\-:]*)(?=\s|\/?$)/.exec(tag);
    if (!match) return 'invalid XML tag';
    const name = match[1];
    const closing = tag.startsWith('/'), selfClosing = !closing && tag.endsWith('/');
    const parent = stack.at(-1);
    const attributes: Record<string, string> = Object.create(null);
    if (!closing) {
      const source = tag.slice(name.length, selfClosing ? -1 : undefined);
      const attribute = /\s+([a-zA-Z_:][\w.\-:]*)(?:\s*=\s*)(?:"([^"<]*)"|'([^'<]*)')/y;
      let position = 0;
      while (position < source.length) {
        attribute.lastIndex = position;
        const found = attribute.exec(source);
        if (!found) { if (source.slice(position).trim()) return 'invalid XML attribute'; break; }
        if (Object.hasOwn(attributes, found[1])) return 'duplicate XML attribute';
        attributes[found[1]] = found[2] ?? found[3];
        position = attribute.lastIndex;
      }
    }
    if (closing) {
      if (tag.slice(1).trim() !== name) return 'invalid closing tag';
      const top = stack.pop();
      if (top !== name) return `unbalanced tag </${name}> (expected </${top ?? 'nothing'}>)`;
    } else if (!selfClosing) {
      if (stack.length >= 1024) return 'diagram nesting exceeds 1024 levels';
      stack.push(name);
    }
    visit?.({ name, attributes,
      start, end: end + 1, parent, closing, selfClosing });
    cursor = end + 1;
  }
  return stack.length ? `unclosed tag(s): <${stack.slice(-5).join('>, <')}>` : null;
}
