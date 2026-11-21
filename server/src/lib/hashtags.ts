export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  const matches = text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]{1,50})/gu);
  for (const match of matches) {
    names.add(match[1].toLowerCase());
    if (names.size >= 30) break;
  }
  return [...names];
}

export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  const matches = text.matchAll(/(?:^|\s)@([a-z0-9_]{3,20})/g);
  for (const match of matches) {
    names.add(match[1].toLowerCase());
    if (names.size >= 20) break;
  }
  return [...names];
}
