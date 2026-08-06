import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("parses a simple header + rows into objects", () => {
    const text = "fullName,phone,email\nAsha Rao,+919812345678,asha@example.com\n";
    expect(parseCsv(text)).toEqual([
      { fullName: "Asha Rao", phone: "+919812345678", email: "asha@example.com" },
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const text = 'fullName,city\n"Rao, Asha",Bengaluru\n';
    expect(parseCsv(text)).toEqual([{ fullName: "Rao, Asha", city: "Bengaluru" }]);
  });

  it("handles escaped double-quotes inside a quoted field", () => {
    const text = 'fullName,note\n"Asha ""AR"" Rao",VIP\n';
    expect(parseCsv(text)).toEqual([{ fullName: 'Asha "AR" Rao', note: "VIP" }]);
  });

  it("handles a quoted field containing a newline", () => {
    const text = 'fullName,note\n"Asha Rao","Line1\nLine2"\n';
    expect(parseCsv(text)).toEqual([{ fullName: "Asha Rao", note: "Line1\nLine2" }]);
  });

  it("skips blank rows", () => {
    const text = "fullName,phone\nAsha Rao,+919812345678\n\n\nVikram Singh,+919812345679\n";
    expect(parseCsv(text)).toHaveLength(2);
  });

  it("fills missing trailing columns with empty strings", () => {
    const text = "fullName,phone,email\nAsha Rao,+919812345678\n";
    expect(parseCsv(text)).toEqual([
      { fullName: "Asha Rao", phone: "+919812345678", email: "" },
    ]);
  });

  it("returns an empty array for an empty or header-only input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("fullName,phone\n")).toEqual([]);
  });

  it("works without a trailing newline on the last row", () => {
    const text = "fullName,phone\nAsha Rao,+919812345678";
    expect(parseCsv(text)).toEqual([{ fullName: "Asha Rao", phone: "+919812345678" }]);
  });
});
