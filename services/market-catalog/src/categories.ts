import type { CategorySlug } from "@league/catalog-contract";

/**
 * Which Polymarket tag slugs put an event into each product category. An event carrying
 * several of these tags belongs to several categories; an event with none is "other".
 * Slugs picked from a live census of active events on 2026-11-21 (see Stage 1 notes):
 * the genres with substantial question counts. Add a slug here to widen a category.
 */
export const CATEGORY_PROVIDER_TAGS: Readonly<Record<Exclude<CategorySlug, "other">, readonly string[]>> = {
  politics: ["politics"],
  sports: ["sports"],
  crypto: ["crypto"],
  "pop-culture": ["pop-culture"],
  geopolitics: ["geopolitics"],
  economy: ["economy"],
  finance: ["finance"],
  tech: ["tech"],
  weather: ["weather"],
};

const CATEGORY_BY_TAG = new Map<string, CategorySlug>(
  Object.entries(CATEGORY_PROVIDER_TAGS).flatMap(([category, slugs]) => slugs.map((slug) => [slug, category as CategorySlug] as const)),
);

/** Sorted, de-duplicated; never empty (falls back to "other"). */
export function categoriesForTags(tagSlugs: readonly string[]): CategorySlug[] {
  const found = new Set<CategorySlug>();
  for (const slug of tagSlugs) {
    const category = CATEGORY_BY_TAG.get(slug);
    if (category) found.add(category);
  }
  return found.size > 0 ? [...found].sort() : ["other"];
}
