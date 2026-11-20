import Link from "next/link";
import { CATEGORY_LABELS, CATEGORY_SLUGS, type CategorySlug } from "@league/catalog-contract";

const TABS: Array<{ label: string; category: CategorySlug | undefined }> = [
  { label: "All", category: undefined },
  ...CATEGORY_SLUGS.map((slug) => ({ label: CATEGORY_LABELS[slug], category: slug })),
];

export function CategoryTabs({ active }: { active: CategorySlug | undefined }) {
  return (
    <nav aria-label="Filter by category" className="flex gap-2 overflow-x-auto">
      {TABS.map((tab) => {
        const isActive = tab.category === active;
        return (
          <Link
            key={tab.label}
            href={tab.category ? `/?category=${tab.category}` : "/"}
            aria-current={isActive ? "page" : undefined}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
