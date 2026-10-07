import { describe, expect, it } from "vitest";
import { formatLineNumber, instancesForNumber, lineForMetadata } from "./whatsapp-lines";

// Real shapes from production: the 60 line under several instances, the 52
// line once running as "sales-phone", and the 60 line re-paired on 21 Sep as
// "9712623060" — a typo; it is still +918712623060.
const byInstance = new Map([
  ["tre-8712623060-mrnisutf", "+918712623060"],
  ["tre-8712623060-mu8cakgi", "+918712623060"],
  ["tre-9712623060-mub4j9u1", "+918712623060"],
  ["tre-sales-phone-mt40qvow", "+918977766852"],
  ["tre-8977766852-mtl7skqx", "+918977766852"],
  ["tre-wellness-cloud-api", "+918712623061"],
]);

describe("formatLineNumber", () => {
  it("groups an Indian number the way people read it", () => {
    expect(formatLineNumber("+918712623060")).toBe("+91 87126 23060");
  });

  it("leaves anything else alone", () => {
    expect(formatLineNumber("+14155550100")).toBe("+14155550100");
    expect(formatLineNumber(null)).toBe("");
  });
});

describe("lineForMetadata", () => {
  it("takes the number recorded on the row when there is one", () => {
    expect(lineForMetadata({ line: "+918712623061", instance: "tre-8712623060-mrnisutf" }, byInstance)).toBe(
      "+918712623061",
    );
  });

  it("resolves an instance through the map, not its name", () => {
    // Parsing the name would say +919712623060 — a number that doesn't exist.
    expect(lineForMetadata({ instance: "tre-9712623060-mub4j9u1" }, byInstance)).toBe("+918712623060");
    // …and would find no number in this one at all.
    expect(lineForMetadata({ instance: "tre-sales-phone-mt40qvow" }, byInstance)).toBe("+918977766852");
  });

  it("is null when nothing identifies the line", () => {
    expect(lineForMetadata({ instance: "tre-unknown" }, byInstance)).toBeNull();
    expect(lineForMetadata({ channel: "whatsapp" }, byInstance)).toBeNull();
    expect(lineForMetadata(null, byInstance)).toBeNull();
  });
});

describe("instancesForNumber", () => {
  it("gathers every instance a line has ever had", () => {
    expect(instancesForNumber("+918712623060", byInstance).sort()).toEqual([
      "tre-8712623060-mrnisutf",
      "tre-8712623060-mu8cakgi",
      "tre-9712623060-mub4j9u1",
    ]);
  });

  it("includes an instance whose name carries no number", () => {
    expect(instancesForNumber("+918977766852", byInstance)).toContain("tre-sales-phone-mt40qvow");
  });

  it("is empty for a number that never sent anything", () => {
    expect(instancesForNumber("+910000000000", byInstance)).toEqual([]);
  });
});
