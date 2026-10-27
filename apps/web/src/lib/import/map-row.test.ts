import { describe, expect, it } from "vitest";
import { dedupeKeyFor, mapPatientRow, normaliseDob } from "./map-row";

describe("normaliseDob", () => {
  it("accepts ISO dates", () => {
    expect(normaliseDob("1990-01-15")).toEqual({ iso: "1990-01-15" });
  });

  it("accepts day-first dates, which is the local convention", () => {
    expect(normaliseDob("15/01/1990")).toEqual({ iso: "1990-01-15" });
  });

  it("accepts four-digit-year-first slash dates", () => {
    expect(normaliseDob("1990/01/15")).toEqual({ iso: "1990-01-15" });
  });

  it("returns null for an empty value", () => {
    expect(normaliseDob("")).toEqual({ iso: null });
    expect(normaliseDob(null)).toEqual({ iso: null });
  });

  it("rejects impossible calendar dates", () => {
    expect(normaliseDob("2023-02-30").error).toMatch(/invalid/i);
    expect(normaliseDob("31/04/2020").error).toMatch(/invalid/i);
  });

  it("rejects future dates", () => {
    const future = new Date(Date.now() + 86_400_000);
    const iso = future.toISOString().slice(0, 10);
    expect(normaliseDob(iso).error).toMatch(/future/i);
  });

  it("rejects unparseable values", () => {
    expect(normaliseDob("last tuesday").error).toMatch(/unparseable/i);
  });
});

describe("mapPatientRow", () => {
  const base = { full_name: "Amina Nakato", mrn: "MRN-1" };

  it("maps a minimal valid row", () => {
    const result = mapPatientRow({ ...base, dob: "1990-01-15", sex: "F" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      full_name: "Amina Nakato",
      mrn: "MRN-1",
      dob: "1990-01-15",
      sex: "female",
      phone: null,
      nin: null,
      village: null,
      district: null,
    });
  });

  it("accepts alternative header spellings", () => {
    const result = mapPatientRow({
      "Patient Name": "Bosco Okello",
      "medical record number": "MRN-9",
      "Date of Birth": "1985-06-01",
      Gender: "M",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mrn).toBe("MRN-9");
    expect(result.value.dob).toBe("1985-06-01");
    expect(result.value.sex).toBe("male");
  });

  it("refuses a row without an MRN rather than generating one", () => {
    const result = mapPatientRow({ full_name: "No MRN" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/mrn/i);
  });

  it("refuses a row without a name", () => {
    const result = mapPatientRow({ mrn: "MRN-2" });
    expect(result.ok).toBe(false);
  });

  it("reports a bad date as an error", () => {
    const result = mapPatientRow({ ...base, dob: "not-a-date" });
    expect(result.ok).toBe(false);
  });

  it("stores an unrecognised sex as null and warns", () => {
    const result = mapPatientRow({ ...base, sex: "X" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sex).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/unrecognised sex/i);
  });

  it("never emits a date_of_birth column", () => {
    const result = mapPatientRow({ ...base, date_of_birth: "1990-01-15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("date_of_birth");
    expect(result.value.dob).toBe("1990-01-15");
  });

  // Defence in depth for Excel's "CSV UTF-8" BOM. parseCsv strips it already;
  // this pins the key normaliser so a BOM that reaches it cannot silently
  // rename the first column and fail every row as "Missing full name".
  it("matches a header that still carries a UTF-8 BOM", () => {
    const result = mapPatientRow({ "﻿full_name": "BOM Patient", mrn: "MRN-9" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.full_name).toBe("BOM Patient");
  });
});

describe("dedupeKeyFor", () => {
  it("is stable across key order and surrounding whitespace", () => {
    expect(dedupeKeyFor({ name: " Amina ", mrn: "MRN-1" })).toBe(
      dedupeKeyFor({ mrn: "MRN-1", name: "Amina" }),
    );
  });

  it("differs when a value differs", () => {
    expect(dedupeKeyFor({ name: "Amina", mrn: "MRN-1" })).not.toBe(
      dedupeKeyFor({ name: "Amina", mrn: "MRN-2" }),
    );
  });
});
