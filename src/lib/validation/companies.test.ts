import { describe, expect, it } from "vitest";
import { companySchema, normalizeDomain, personSchema } from "./companies";

const company = {
  name: "Hartley & Co",
  domain: "",
  industry: null,
  employeeCount: null,
  description: "",
  hqCity: "",
  hqRegion: "",
  hqCountry: null,
};

const person = {
  name: "Emma Hartley",
  title: "",
  seniority: "unknown" as const,
  jobFunction: null,
  relationship: "employee" as const,
  email: "",
  phone: "",
  professionalUrl: "",
  location: "",
};

describe("normalizeDomain", () => {
  it.each([
    ["https://www.HartleyCo.co.uk/about?x=1", "hartleyco.co.uk"],
    ["hartleyco.co.uk:8080", "hartleyco.co.uk"],
    ["  Example.com  ", "example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
});

describe("companySchema", () => {
  it("turns empty optional fields into null", () => {
    expect(companySchema.parse(company)).toMatchObject({ domain: null, description: null, hqCity: null });
  });

  it("accepts already-validated values (null instead of empty strings)", () => {
    const validated = companySchema.parse(company);
    expect(companySchema.parse(validated)).toEqual(validated);
  });

  it("rejects a malformed domain", () => {
    const result = companySchema.safeParse({ ...company, domain: "not a domain" });
    expect(result.error?.issues[0]?.path).toEqual(["domain"]);
  });
});

describe("personSchema", () => {
  it("normalises email to lowercase", () => {
    expect(personSchema.parse({ ...person, email: " Emma@HartleyCo.co.uk " }).email).toBe("emma@hartleyco.co.uk");
  });

  it.each([
    ["email", "emma@"],
    ["phone", "call me"],
    ["professionalUrl", "linkedin.com/in/emma"],
  ])("rejects an invalid %s", (field, value) => {
    const result = personSchema.safeParse({ ...person, [field]: value });
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });
});
