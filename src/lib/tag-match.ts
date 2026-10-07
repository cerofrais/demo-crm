/**
 * Whether a tag filter wants items carrying ANY of the selected tags, or ALL
 * of them. One definition for every page that filters by tag — the leads
 * board (in the browser) and the Tasks, Deleted Leads and Guests APIs (in
 * the database) — so the radio on each page means the same thing.
 *
 * Pure: no Prisma, safe in client components.
 */

export type TagMatch = "any" | "all";

export const TAG_MATCH_LABEL: Record<TagMatch, string> = {
  any: "Any tag",
  all: "All tags",
};

/**
 * Read `?tagMatch=` from a request. The fallback is the page's own historic
 * behaviour, so a client that never sends the parameter — an old tab, a
 * bookmarked URL — gets exactly what it got before.
 */
export function parseTagMatch(raw: string | null | undefined, fallback: TagMatch): TagMatch {
  return raw === "any" || raw === "all" ? raw : fallback;
}

/** Whether an item's tags satisfy the filter. No selection matches everything. */
export function matchesTags(itemTags: readonly string[], selected: readonly string[], mode: TagMatch): boolean {
  if (!selected.length) return true;
  return mode === "all"
    ? selected.every((t) => itemTags.includes(t))
    : selected.some((t) => itemTags.includes(t));
}

/** The Prisma scalar-list filter for a tag selection, or undefined for none. */
export function tagListFilter(
  selected: readonly string[],
  mode: TagMatch,
): { hasSome: string[] } | { hasEvery: string[] } | undefined {
  if (!selected.length) return undefined;
  return mode === "all" ? { hasEvery: [...selected] } : { hasSome: [...selected] };
}
