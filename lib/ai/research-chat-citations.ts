export function sanitizeInlineCitations(value: string, validIds: Set<string>) {
  return value
    .replace(/\[([^\]]{1,120})\]/g, (citation, id: string) => validIds.has(id) ? citation : "")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function inlineEvidenceIds(value: string) {
  return [...value.matchAll(/\[(ev-[\w-]+)\]/g)].map((match) => match[1]);
}
