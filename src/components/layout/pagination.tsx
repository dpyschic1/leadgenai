"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_PAGE_SIZE, type Pagination as PageRequest } from "@/lib/validation/pagination";

/**
 * The page a list is on. It goes back to page 1 whenever `resetKey` changes (a new search, tab or
 * filter), and changing page scrolls back to the top of the list.
 */
export function usePage(resetKey: string, pageSize = DEFAULT_PAGE_SIZE): [PageRequest, (page: number) => void] {
  const [state, setState] = useState({ key: resetKey, page: 1 });
  const page = state.key === resetKey ? state.page : 1;
  const setPage = useCallback(
    (next: number) => {
      setState({ key: resetKey, page: next });
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [resetKey],
  );
  return [{ page, pageSize }, setPage];
}

/**
 * Footer for a server-paged list: "Showing 26–50 of 105", previous/next and page numbers (with
 * gaps on long lists). Renders nothing when everything fits on one page.
 */
export function Pagination({
  page,
  pageSize,
  total,
  noun,
  onChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Plural name of the rows, e.g. "companies". */
  noun: string;
  onChange: (page: number) => void;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Past the end (e.g. the last row on the last page was deleted): move to the new last page.
  useEffect(() => {
    if (page > pages) onChange(pages);
  }, [page, pages, onChange]);
  if (total <= pageSize && page === 1) return null;
  const first = Math.min(total, (page - 1) * pageSize + 1);
  const last = Math.min(total, page * pageSize);

  return (
    <nav aria-label="Pagination" className={cn("flex flex-wrap items-center justify-between gap-3 text-sm", className)}>
      <p className="tabular-nums text-muted-foreground" aria-live="polite">
        Showing {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
          <ChevronLeftIcon />
          <span className="hidden sm:inline">Previous</span>
        </Button>
        {/* Page numbers from small screens up; phones keep just previous/next. */}
        <div className="hidden items-center gap-1 sm:flex">
          {pageNumbers(page, pages).map((n, index) =>
            n === null ? (
              <span key={`gap-${index}`} className="px-1.5 text-muted-foreground" aria-hidden="true">
                …
              </span>
            ) : (
              <Button
                key={n}
                variant={n === page ? "secondary" : "ghost"}
                size="sm"
                className="min-w-8 tabular-nums"
                aria-current={n === page ? "page" : undefined}
                aria-label={`Page ${n}`}
                onClick={() => onChange(n)}
              >
                {n}
              </Button>
            ),
          )}
        </div>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">
          <span className="hidden sm:inline">Next</span>
          <ChevronRightIcon />
        </Button>
      </div>
    </nav>
  );
}

/** 1 … 4 5 6 … 12: the first and last page, the current one and its neighbours; `null` marks a gap. */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return shown.flatMap((n, index) => (index > 0 && n - shown[index - 1] > 1 ? [null, n] : [n]));
}
