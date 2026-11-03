import { z } from "zod";

/**
 * Server-side, page-numbered pagination shared by the lists (companies, opportunities, services):
 * `?page=2&pageSize=25`. Each response carries the total, so the UI can show "26–50 of 105".
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export const paginationSchema = z.object(paginationFields);

export type Pagination = z.output<typeof paginationSchema>;

/** One page of a list and where it sits in the whole. */
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export const FIRST_PAGE: Pagination = { page: 1, pageSize: DEFAULT_PAGE_SIZE };

/** SQL `offset` for a page. */
export const offsetOf = ({ page, pageSize }: Pagination) => (page - 1) * pageSize;

/** `page`/`pageSize` as query-string params; defaults are left out to keep URLs short. */
export function setPageParams(params: URLSearchParams, { page, pageSize }: Pagination): URLSearchParams {
  if (page !== 1) params.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));
  return params;
}
