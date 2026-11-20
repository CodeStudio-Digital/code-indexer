/** Preserve a folder's file locator and an embedded PDF's page in citations. */
export function docPassageUri(uri: string, anchor?: string | null): string {
  if (!anchor) return uri;
  if (/^folder:\/\/[^#]+#file=/.test(uri)) return uri + '&anchor=' + encodeURIComponent(anchor);
  if (/#page=\d+(?:&|$)/.test(uri)) return uri + '&nameddest=' + encodeURIComponent(anchor);
  return uri.split('#', 1)[0] + '#' + anchor;
}
