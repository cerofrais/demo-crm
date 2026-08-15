import { describe, expect, it } from "vitest";
import {
  TOPICS,
  classifyMessage,
  isFormSubmission,
  isInternalChatter,
  isNoise,
  primaryTopic,
} from "./inbound-analysis";

describe("isNoise", () => {
  it("drops our own system-generated message labels", () => {
    // These are written by describeNonMediaMessage() in lib/whatsapp.ts, not
    // by a guest — counting them would inflate every topic.
    for (const s of [
      "🛒 Order (3 items)",
      "📍 Location: Trē Wellness",
      "👤 Shared contact: Dr Saurav",
      "[Encrypted message — not readable]",
      "[Unsupported message type]",
      "Reacted 👍",
    ]) {
      expect(isNoise(s)).toBe(true);
    }
  });

  it("drops bare acknowledgements", () => {
    for (const s of ["ok", "Okay.", "thanks", "Thank you", "yes", "Hi", "Good morning", "hmmm"]) {
      expect(isNoise(s)).toBe(true);
    }
  });

  it("drops a bare phone number or email", () => {
    expect(isNoise("+44 7969 816890")).toBe(true);
    expect(isNoise("someone@example.com")).toBe(true);
  });

  it("keeps a real question, including a short one", () => {
    expect(isNoise("Can you share pricing too")).toBe(false);
    expect(isNoise("Single occupancy")).toBe(false);
  });

  it("keeps a greeting that carries an actual question", () => {
    // "Hi" alone is noise; "Hi, can you send details" is the whole point.
    expect(isNoise("Hi can u send me the details pls")).toBe(false);
  });
});

describe("classifyMessage — against real guest messages", () => {
  // Every string here is a verbatim inbound message from production.
  const CASES: [string, string][] = [
    ["Can you share pricing too", "pricing"],
    ["So for 30 days it’s 253500 ??", "duration"],
    ["13500 + gst = Rs.15930 per day.", "pricing"],
    ["Hi can u send me the details pls", "programme"],
    ["Hi, could you please share program highlights", "programme"],
    ["What isthe validity for membership", "membership"],
    ["Call me tomorrow 11am", "callback"],
    ["Can you call me? I have a few questions.", "callback"],
    ["Single occupancy", "accommodation"],
    ["I already paid 1.96 lakhs", "booking_payment"],
  ];

  it.each(CASES)("classifies %j under %s", (body, expected) => {
    expect(classifyMessage(body)).toContain(expected);
  });

  it("puts a two-part question in both topics", () => {
    // Guests routinely ask two things in one line.
    const hits = classifyMessage("What is the price and where are you located?");
    expect(hits).toContain("pricing");
    expect(hits).toContain("location");
  });

  it("returns nothing for a message with no recognisable topic", () => {
    // Must stay empty rather than defaulting into a bucket — unmatched
    // messages are surfaced so the taxonomy's blind spots stay visible.
    expect(classifyMessage("Please check with your management")).toEqual([]);
  });

  it("recognises a rupee amount as a pricing question without any keyword", () => {
    expect(classifyMessage("₹45000 for the week?")).toContain("pricing");
  });

  it("matches plural forms — 'prices' as well as 'price'", () => {
    // \bprice\b does not match "prices". 31 messages in the real corpus say
    // "prices" and were all landing in unrecognised because of it.
    expect(classifyMessage("May I know the details of prices for packages you have ?")).toContain("pricing");
    expect(classifyMessage("what are your rates and fees")).toContain("pricing");
  });

  it("does NOT treat a bare number as a price", () => {
    // A bare 5-7 digit rule was tried and removed: on the real corpus it
    // matched 153 messages, overwhelmingly postcodes and phone fragments
    // rather than quoted amounts. One missed edge case beats 153 wrong ones.
    expect(classifyMessage("Plot no 566 Road no 12 Banjara Hills Hyderabad 500034")).not.toContain("pricing");
    expect(classifyMessage("Name:veer Mobile :87122 21534")).not.toContain("pricing");
  });
});

describe("topic taxonomy", () => {
  it("has unique keys", () => {
    const keys = TOPICS.map((t) => t.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("gives every topic at least one pattern and a template hint", () => {
    for (const t of TOPICS) {
      expect(t.patterns.length).toBeGreaterThan(0);
      expect(t.templateHints.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("uses case-insensitive patterns for anything with letters", () => {
    // A guest typing in caps must not fall out of the analysis. Purely
    // numeric patterns (a quoted amount) have no case to be sensitive to.
    for (const t of TOPICS) {
      for (const p of t.patterns) {
        if (/[a-z]/i.test(p.source.replace(/\\d|\\b|\\s/g, ""))) {
          expect(p.flags).toContain("i");
        }
      }
    }
  });
});

describe("corpus pollution filters", () => {
  it("excludes website enquiry form submissions", () => {
    // 763 of the 2,727 real inbound messages are these. Left in, a single
    // submission matched half the taxonomy and made Therapies look like the
    // most-asked topic in the business.
    const form = [
      "Name: Ms Raya Silver",
      "Age : 50",
      "Phone: 07075162573",
      "Email : silverraya1773@gmail.com",
      "City : HYDERABAD",
      "Preferred Check in Date : 2026-01-21",
      "Package Preference: Wellness Experience",
    ].join("\n");
    expect(isFormSubmission(form)).toBe(true);
  });

  it("excludes the colon-less health intake form", () => {
    expect(
      isFormSubmission(
        "First Name Shanthi Last Name Krishna Age 52 Date of Birth 6th june 1974 Blood group B positive",
      ),
    ).toBe(true);
  });

  it("does not mistake an ordinary question for a form", () => {
    expect(isFormSubmission("Hi, could you please share program highlights")).toBe(false);
    expect(isFormSubmission("Price: is it 21000 per day?")).toBe(false);
  });

  it("excludes staff ops chatter on the business number", () => {
    expect(isInternalChatter("Dear Sir, This Crm is not opening.")).toBe(true);
    expect(isInternalChatter("we are not added anything lead today in Crm Sir")).toBe(true);
    expect(isInternalChatter("Hi, what is the price per day?")).toBe(false);
  });

  it("excludes automated mail that reaches a shared inbox", () => {
    expect(isNoise("A new sign-in on Windows — we noticed a new sign-in to your account")).toBe(true);
    expect(isNoise("Automatic reply: I am out of office until Monday")).toBe(true);
  });
});

describe("primaryTopic", () => {
  it("picks one topic so shares can sum to 100", () => {
    // Raw match counts sum well past the message count, which made the shares
    // uninterpretable ("70% programme, 67% therapies").
    const both = "What is the price and where are you located?";
    expect(classifyMessage(both).length).toBeGreaterThan(1);
    expect(primaryTopic(both)).toBe("pricing");
  });

  it("is null when nothing matches", () => {
    expect(primaryTopic("Please check with your management")).toBeNull();
  });
});
