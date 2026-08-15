import { describe, expect, it } from "vitest";
import { cleanMessageBody, isLongMessage } from "./message-display";

// The exact pixel found in this deployment's inbox.
const BREVO_PIXEL =
  "https://baggchdb.r.bh.d.sendibt3.com/tr/op/vJ6QoDFPGKHS7GDMDKsSURXdOSBNmFuIPED9PWoz2uisna--LSmESXhbq1VrVWe46vWh6Tt4XlxPIcMgLR46NSQ2jzuNU8CZ-drDAUMVLD8xcCeXNfnOjxySTup3NuzSPFLl7IIMh3eSPRnoJKCZy5caxPS1gGKvE_s5jOlTFv3sltdeZwerBvNrKPm2r--SXd3KPeYUAIV-W2MG85Uoivrn-FHcXg";

describe("cleanMessageBody — tracking pixels", () => {
  it("removes the Brevo pixel entirely", () => {
    const out = cleanMessageBody(`${BREVO_PIXEL} is your inquiry detail submitted.`);
    expect(out.clean).toBe("is your inquiry detail submitted.");
    expect(out.trackersRemoved).toBe(1);
    expect(out.changed).toBe(true);
  });

  it("removes the sendibt2 variant too", () => {
    const out = cleanMessageBody("https://baggchdb.r.af.d.sendibt2.com/tr/op/abc123 Hello");
    expect(out.clean).toBe("Hello");
    expect(out.trackersRemoved).toBe(1);
  });

  it("removes a generic open-tracking path on any host", () => {
    const out = cleanMessageBody("Hi https://mail.example.com/tr/op/xyz there");
    expect(out.clean).toBe("Hi there");
  });

  it("keeps the original untouched", () => {
    const body = `${BREVO_PIXEL} text`;
    expect(cleanMessageBody(body).original).toBe(body);
  });

  it("preserves the real content of a website inquiry email", () => {
    // Verbatim shape of the 122 notification emails in this inbox.
    const body = [
      `${BREVO_PIXEL} is your inquiry detail submitted for the Weight Loss Management Program at TRE Wellness.`,
      "",
      "Your Name : test",
      "Contact No : 90000 00009",
    ].join("\n");
    const out = cleanMessageBody(body);
    expect(out.clean).toContain("Your Name : test");
    expect(out.clean).toContain("Weight Loss Management Program");
    expect(out.clean).not.toContain("sendibt3");
  });
});

describe("cleanMessageBody — bracket-wrapped URLs (real email shape)", () => {
  // These bodies are HTML mail flattened to text, so the pixel arrives wrapped
  // as [url] with NO space before the next word. An earlier version matched
  // past the "]" and deleted "Dear" — silent data loss in the display.
  const WRAPPED = `[${BREVO_PIXEL}]Dear Sambasivarao Bobbala Following is your inquiry`;

  it("does not swallow the word after the closing bracket", () => {
    const out = cleanMessageBody(WRAPPED);
    expect(out.clean).toBe("Dear Sambasivarao Bobbala Following is your inquiry");
  });

  it("removes the now-empty bracket wrapper", () => {
    expect(cleanMessageBody(WRAPPED).clean).not.toMatch(/^\[/);
  });

  it("keeps bracketed text that isn't an empty wrapper", () => {
    expect(cleanMessageBody("Please read [the terms] first").clean).toBe(
      "Please read [the terms] first",
    );
  });

  it("shortens — not deletes — a bracket-wrapped real link", () => {
    const out = cleanMessageBody("[https://trewellness.in/packages]See our packages");
    expect(out.clean).toBe("[trewellness.in]See our packages");
  });
});

describe("cleanMessageBody — ordinary links", () => {
  it("shortens a real link to its domain instead of deleting it", () => {
    // A guest sharing a page is telling us something; dropping it would hide
    // content from whoever reads the thread.
    const out = cleanMessageBody("See https://www.trewellness.in/packages?utm_source=x for details");
    expect(out.clean).toBe("See [trewellness.in] for details");
    expect(out.linksShortened).toBe(1);
    expect(out.trackersRemoved).toBe(0);
  });

  it("strips www. but keeps the rest of the host", () => {
    expect(cleanMessageBody("https://www.example.co.uk/a").clean).toBe("[example.co.uk]");
  });

  it("handles several links in one message", () => {
    const out = cleanMessageBody("a https://one.com/x b https://two.com/y c");
    expect(out.clean).toBe("a [one.com] b [two.com] c");
    expect(out.linksShortened).toBe(2);
  });
});

describe("cleanMessageBody — leaves ordinary text alone", () => {
  it("reports no change for a plain message", () => {
    const body = "Hi, could you please share program highlights";
    const out = cleanMessageBody(body);
    expect(out.clean).toBe(body);
    expect(out.changed).toBe(false);
    expect(out.trackersRemoved + out.linksShortened).toBe(0);
  });

  it("keeps paragraph breaks", () => {
    const out = cleanMessageBody("Line one\n\nLine two");
    expect(out.clean).toBe("Line one\n\nLine two");
  });

  it("is safe on empty and missing input", () => {
    for (const v of ["", "   ", null, undefined]) {
      const out = cleanMessageBody(v);
      expect(out.changed).toBe(false);
      expect(out.trackersRemoved).toBe(0);
    }
  });

  it("does not mangle an email address or a phone number", () => {
    const body = "Reach me at guest@example.com or +91 98480 52531";
    expect(cleanMessageBody(body).clean).toBe(body);
  });
});

describe("isLongMessage", () => {
  it("flags a body past the toggle threshold", () => {
    expect(isLongMessage("x".repeat(701))).toBe(true);
    expect(isLongMessage("x".repeat(699))).toBe(false);
  });
});
