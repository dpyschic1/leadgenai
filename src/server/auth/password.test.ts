import { describe, expect, it } from "vitest";
import { hashPassword, verifyDummyPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces an argon2id hash that verifies the original password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("treats a malformed hash as a mismatch instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("runs the dummy verification without throwing", async () => {
    await expect(verifyDummyPassword("anything")).resolves.toBeUndefined();
  });
});
