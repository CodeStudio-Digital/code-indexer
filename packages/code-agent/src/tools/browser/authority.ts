export function browserDispatchArguments(method: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case 'open': return { url: String(input.url ?? '') };
    case 'snapshot': return input.limit === undefined ? {} : { limit: input.limit };
    case 'extract': return input.max_chars === undefined ? {} : { maxChars: input.max_chars };
    case 'click': return { ref: String(input.ref ?? '') };
    case 'fill': return { ref: String(input.ref ?? ''), value: String(input.value ?? '') };
    case 'press': return { ref: String(input.ref ?? ''), key: String(input.key ?? '') };
    case 'screenshot': return { fullPage: input.full_page === true };
    case 'close': return {};
    default: throw new Error('Browser method is not an admitted tool');
  }
}
