import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, errorResponse } from "./errors";

describe("errorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps an AppError to its status and the error contract", async () => {
    const response = errorResponse(
      new AppError("VALIDATION_FAILED", "Some fields are invalid.", { email: ["Bad email"] }),
      "req_1",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid.",
        request_id: "req_1",
        field_errors: { email: ["Bad email"] },
      },
    });
  });

  it("hides unexpected errors behind a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new Error("connection string leaked"), "req_2");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("leaked");
  });
});
