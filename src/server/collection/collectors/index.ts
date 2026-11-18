import "server-only";
import type { Collector } from "../types";
import { careerPages } from "./career-pages";
import { hackerNews } from "./hacker-news";
import { gemBoards, ripplingBoards } from "./hosted-boards";
import { samGov } from "./sam-gov";

/**
 * Every collector, by source slug. Adding a source means writing one collector, listing it here and
 * seeding its `sources` row (approved only after its terms are reviewed); the runner doesn't change.
 */
export const COLLECTORS: Record<string, Collector> = {
  [careerPages.slug]: careerPages,
  [gemBoards.slug]: gemBoards,
  [ripplingBoards.slug]: ripplingBoards,
  [hackerNews.slug]: hackerNews,
  [samGov.slug]: samGov,
};
