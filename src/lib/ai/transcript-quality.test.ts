import { describe, expect, it } from "vitest";
import {
  collapseRepetitions,
  isPredominantlyLatin,
  isUsableTranscript,
} from "./transcript-quality";

describe("isPredominantlyLatin", () => {
  it("recognises an English transcript, digits and symbols aside", () => {
    expect(
      isPredominantlyLatin("Single occupancy is 28,000 with 18% GST after a 25% discount."),
    ).toBe(true);
  });

  it("rejects Telugu and Devanagari transcripts", () => {
    expect(isPredominantlyLatin("నమస్కారం, మా పేరు రవి. మీరు ఎలా ఉన్నారు?")).toBe(false);
    expect(isPredominantlyLatin("गुड मॉर्निंग मैम। प्रशांत बोल रहा हूँ।")).toBe(false);
  });

  it("rejects code-mixed text that still carries substantial Indic script", () => {
    expect(isPredominantlyLatin("మీరు ఏ ప్రాంతం నుండి? GST included ma'am.")).toBe(false);
  });

  it("is false for text with no letters at all", () => {
    expect(isPredominantlyLatin("12345 ... !!")).toBe(false);
  });
});

describe("isUsableTranscript", () => {
  it("rejects empty and whitespace-only output", () => {
    expect(isUsableTranscript("")).toBe(false);
    expect(isUsableTranscript("   \n ")).toBe(false);
    expect(isUsableTranscript(null)).toBe(false);
    expect(isUsableTranscript(undefined)).toBe(false);
  });

  it("rejects the stray-syllable output a dead decode actually produced", () => {
    // Real values observed on production calls whose transcript was then
    // fabricated by the LLM: 3, 7 and 8 characters for multi-minute audio.
    expect(isUsableTranscript("హలో")).toBe(false);
    expect(isUsableTranscript("Namaste")).toBe(false);
  });

  it("rejects long-but-degenerate output that is one token on repeat", () => {
    expect(isUsableTranscript("కోన్న్ను ".repeat(200))).toBe(false);
  });

  it("accepts a genuine short exchange", () => {
    expect(
      isUsableTranscript("Hello ma'am, good afternoon. Yes, tell me about the package please."),
    ).toBe(true);
  });
});

describe("collapseRepetitions", () => {
  it("collapses a decoder loop, keeping at most one natural repeat", () => {
    const looped = "Hello. " + "This is Madhu. ".repeat(10) + "Before I explain the program.";
    const out = collapseRepetitions(looped);
    // maxRun=2 keeps a plausible spoken doubling and discards the other 8.
    expect(out.match(/This is Madhu/g)?.length).toBe(2);
    expect(out).toContain("Hello.");
    expect(out).toContain("Before I explain the program.");
  });

  it("ignores punctuation and case when matching repeats", () => {
    const out = collapseRepetitions("Okay. okay! OKAY? OKAY. Next topic.");
    expect(out.match(/okay/gi)?.length).toBe(2);
    expect(out).toContain("Next topic.");
  });

  it("collapses hard, all the way to one, when asked", () => {
    const out = collapseRepetitions("Yes. Yes. Yes. Yes. Done.", 1);
    expect(out.match(/Yes/g)?.length).toBe(1);
    expect(out).toContain("Done.");
  });

  it("preserves a phrase that genuinely recurs later in the call", () => {
    const text = "The price is 21000. We include therapies. The price is 21000.";
    // Non-consecutive: normal speech, must survive intact.
    expect(collapseRepetitions(text).match(/The price is 21000/g)?.length).toBe(2);
  });

  it("leaves clean transcripts untouched", () => {
    const clean = "Good afternoon. How many days are you looking for? We have a detox package.";
    expect(collapseRepetitions(clean)).toBe(clean);
  });
});
