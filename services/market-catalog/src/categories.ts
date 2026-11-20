import type { CategorySlug } from "@league/catalog-contract";

/**
 * Which Polymarket tags feed each product category.
 *
 * Verified on 2026-11-20 against GET https://gamma-api.polymarket.com/tags/slug/{slug}:
 *   politics    -> tag id 2,   label "Politics"
 *   pop-culture -> tag id 596, label "Culture" (Polymarket's site calls this section "Culture")
 * We query by slug rather than numeric id so the mapping stays readable.
 * A market whose event carries several of these tags gets several categories.
 */
export const CATEGORY_PROVIDER_TAGS: ReadonlyArray<{ category: CategorySlug; polymarketTagSlug: string }> = [
  { category: "politics", polymarketTagSlug: "politics" },
  { category: "pop-culture", polymarketTagSlug: "pop-culture" },
];
