import "server-only";
import type { Collector } from "../types";
import { careerPages } from "./career-pages";

/**
 * Every collector, by source slug. Adding a source means writing one collector, listing it here and
 * seeding its `sources` row (approved only after its terms are reviewed); the runner doesn't change.
 */
export const COLLECTORS: Record<string, Collector> = {
  [careerPages.slug]: careerPages,
};
