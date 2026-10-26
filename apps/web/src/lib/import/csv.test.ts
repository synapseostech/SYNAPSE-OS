import { describe, expect, it } from "vitest";
import { CsvError, parseCsv, toRecord } from "./csv";

describe("parseCsv", () => {
  it("parses a simple header and rows", () => {
    const result = parseCsv("name,mrn\nAmina,MRN-1\nBosco,MRN-2\n");
    expect(result.header).toEqual(["name", "mrn"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].values).toEqual(["Amina", "MRN-1"]);
    expect(result.rows[0].line).toBe(2);
    expect(result.malformed).toHaveLength(0);
  });

  it("keeps commas inside quoted fields", () => {
    const result = parseCsv('name,village\n"Kato, Jr.",Kampala\n');
    expect(result.rows[0].values).toEqual(["Kato, Jr.", "Kampala"]);
  });

  it("keeps newlines inside quoted fields and tracks the physical line", () => {
    const result = parseCsv('name,notes\n"Line one\nLine two",ok\n');
    expect(result.rows[0].values).toEqual(["Line one\nLine two", "ok"]);
  });

  it("unescapes doubled quotes", () => {
    const result = parseCsv('name\n"Say ""hello"""\n');
    expect(result.rows[0].values).toEqual(['Say "hello"']);
  });

  it("handles CRLF line endings", () => {
    const result = parseCsv("name,mrn\r\nAmina,MRN-1\r\n");
    expect(result.header).toEqual(["name", "mrn"]);
    expect(result.rows[0].values).toEqual(["Amina", "MRN-1"]);
  });

  it("reports rows whose field count differs from the header instead of dropping them", () => {
    const result = parseCsv("name,mrn,dob\nAmina,MRN-1\nBosco,MRN-2,1990-01-01\n");
    expect(result.rows).toHaveLength(1);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].values).toEqual(["Amina", "MRN-1"]);
  });

  it("skips blank lines", () => {
    const result = parseCsv("name,mrn\n\nAmina,MRN-1\n\n");
    expect(result.rows).toHaveLength(1);
    expect(result.malformed).toHaveLength(0);
  });

  it("parses a final row without a trailing newline", () => {
    const result = parseCsv("name,mrn\nAmina,MRN-1");
    expect(result.rows).toHaveLength(1);
  });

  it("throws on empty input", () => {
    expect(() => parseCsv("")).toThrow(CsvError);
  });

  it("throws when there is no header row", () => {
    expect(() => parseCsv("\n\n")).toThrow(/no header/i);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsv('name\n"unterminated\n')).toThrow(/unterminated/i);
  });

  it("enforces the row ceiling", () => {
    const text = `name\n${Array.from({ length: 10 }, (_, i) => `p${i}`).join("\n")}\n`;
    expect(() => parseCsv(text, 5)).toThrow(/row import limit/i);
  });

  // Excel's "CSV UTF-8" writes a BOM. If it survived into the header the first
  // column would be named "﻿name", no alias would match it and every row
  // would be rejected as "Missing full name".
  it("strips a UTF-8 BOM before the header", () => {
    const result = parseCsv("﻿name,mrn\nAmina,MRN-1\n");
    expect(result.header).toEqual(["name", "mrn"]);
    expect(toRecord(result.header, result.rows[0].values)).toEqual({
      name: "Amina",
      mrn: "MRN-1",
    });
  });
});

describe("toRecord", () => {
  it("keys values by header and trims them", () => {
    expect(toRecord(["name", "mrn"], ["  Amina ", " MRN-1"])).toEqual({
      name: "Amina",
      mrn: "MRN-1",
    });
  });

  it("ignores unnamed header columns and missing values", () => {
    expect(toRecord(["name", "", "dob"], ["Amina", "x"])).toEqual({
      name: "Amina",
      dob: "",
    });
  });
});
