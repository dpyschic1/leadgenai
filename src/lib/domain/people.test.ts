import { describe, expect, it } from "vitest";
import { CONTACT_CONFIDENCE_THRESHOLD, IDENTITY_LEVELS, identityColumns, identityLevel, isSuggestable } from "./people";

describe("identity levels", () => {
  it("round-trips every level through its stored form", () => {
    for (const level of IDENTITY_LEVELS) {
      const { identityStatus, identityConfidence } = identityColumns(level);
      expect(identityLevel(identityStatus, identityConfidence)).toBe(level);
    }
  });

  it("treats people added before confidence was recorded as confirmed", () => {
    expect(identityLevel("resolved", null)).toBe("confirmed");
  });

  it("maps a data provider's confidence onto the same scale", () => {
    expect(identityLevel("resolved", 95)).toBe("confirmed");
    expect(identityLevel("resolved", CONTACT_CONFIDENCE_THRESHOLD)).toBe("likely");
    expect(identityLevel("resolved", CONTACT_CONFIDENCE_THRESHOLD - 1)).toBe("unsure");
    expect(identityLevel("unresolved", 99)).toBe("unsure");
    expect(identityLevel("suppressed", 99)).toBe("do_not_contact");
  });

  it("suggests only confirmed and likely people as contacts", () => {
    expect(IDENTITY_LEVELS.filter(isSuggestable)).toEqual(["confirmed", "likely"]);
  });
});
