import { describe, expect, it } from "vitest";
import { pageNumbers } from "./pagination";

describe("page numbers", () => {
  it("lists every page of a short list", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
  });

  it("keeps the first, last and neighbouring pages, with gaps between", () => {
    expect(pageNumbers(1, 12)).toEqual([1, 2, null, 12]);
    expect(pageNumbers(6, 12)).toEqual([1, null, 5, 6, 7, null, 12]);
    expect(pageNumbers(12, 12)).toEqual([1, null, 11, 12]);
  });
});
