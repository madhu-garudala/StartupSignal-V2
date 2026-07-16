export function sanitizeInlineCitations(value: string, validIds: Set<string>) {
  return value
    .replace(/\[([^\]]{1,120})\]/g, (citation, content: string) => {
      const ids = [...content.matchAll(/\bev-[\w-]+\b/g)].map((match) => match[0]);
      if (ids.length) {
        const supported = [...new Set(ids.filter((id) => validIds.has(id)))];
        return supported.length ? `[${supported.join(", ")}]` : "";
      }
      return content.includes("currentInvestigation.") ? "" : citation;
    })
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function inlineEvidenceIds(value: string) {
  return [...value.matchAll(/\[([^\]]+)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/\bev-[\w-]+\b/g)].map((id) => id[0]));
}
