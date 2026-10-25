export interface SkillSuggestion { id: string; name: string; description: string; command: string | null }
export interface SkillMention { trigger: '#' | '/'; query: string; start: number; end: number }

/** Only a token at the caret: not C#, URLs, Markdown headings or ordinary slashes. */
export function skillMention(text: string, caret: number): SkillMention | null {
  const prefix = text.slice(0, caret);
  const hash = /(?:^|\s)#([\p{L}\p{N}_:.-]*)$/u.exec(prefix);
  if (hash) return { trigger: '#', query: hash[1]!, start: caret - hash[1]!.length - 1, end: caret };
  const slash = /^\/([\w:.-]*)$/.exec(prefix);
  return slash ? { trigger: '/', query: slash[1]!, start: 0, end: caret } : null;
}
