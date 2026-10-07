import { describe, expect, it } from "vitest";
import { isAwaitingOurReply, hasEngaged, stillUnsent, type GuestTimeline } from "./broadcast-followup";

const now = new Date("2026-08-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);
const empty: GuestTimeline = { fromGuest: [], fromUs: [] };

/** Tapped the button, we sent the pricing, silence since. The whole point. */
const clickedThenIgnored: GuestTimeline = {
  fromGuest: [{ at: hoursAgo(50), text: "Enquire Now" }],
  fromUs: [{ at: hoursAgo(49) }],
};

describe("isAwaitingOurReply", () => {
  it("includes someone who tapped the button, got Stage 2, and went quiet", () => {
    expect(isAwaitingOurReply(clickedThenIgnored, { now })).toBe(true);
  });

  it("excludes someone who never engaged at all", () => {
    // The Stage 3 copy ("time to buy your vouchers?") would be nonsense to
    // someone who never saw the vouchers.
    expect(isAwaitingOurReply(empty, { now })).toBe(false);
    expect(isAwaitingOurReply({ fromGuest: [], fromUs: [{ at: hoursAgo(50) }] }, { now })).toBe(false);
  });

  it("excludes someone whose message we haven't answered yet", () => {
    // They spoke last: the ball is in our court, so this is a rep's job and
    // an automated nudge would talk over them.
    expect(isAwaitingOurReply({
      fromGuest: [{ at: hoursAgo(2), text: "what's the price?" }],
      fromUs: [{ at: hoursAgo(50) }],
    }, { now })).toBe(false);
  });

  it("excludes a live conversation — we replied within the quiet window", () => {
    expect(isAwaitingOurReply({
      fromGuest: [{ at: hoursAgo(5), text: "Enquire Now" }],
      fromUs: [{ at: hoursAgo(1) }],
    }, { now, quietHours: 24 })).toBe(false);
  });

  it("honours a shorter quiet window", () => {
    expect(isAwaitingOurReply({
      fromGuest: [{ at: hoursAgo(5), text: "Enquire Now" }],
      fromUs: [{ at: hoursAgo(3) }],
    }, { now, quietHours: 2 })).toBe(true);
  });

  describe("trigger filter — only the guests who tapped that button", () => {
    it("matches the button label case-insensitively, anywhere in the text", () => {
      expect(isAwaitingOurReply(clickedThenIgnored, { now, trigger: "enquire now" })).toBe(true);
    });

    it("excludes someone who engaged some other way", () => {
      // They chatted rather than tapping the button — Response 3, whom sales
      // is handling by hand.
      expect(isAwaitingOurReply({
        fromGuest: [{ at: hoursAgo(50), text: "hi, tell me more" }],
        fromUs: [{ at: hoursAgo(49) }],
      }, { now, trigger: "Enquire Now" })).toBe(false);
    });

    it("still measures silence against ALL their contact, not just the click", () => {
      // Tapped the button two days ago but messaged again an hour ago: the
      // trigger matched, yet they're mid-conversation and must be left alone.
      expect(isAwaitingOurReply({
        fromGuest: [
          { at: hoursAgo(50), text: "Enquire Now" },
          { at: hoursAgo(1), text: "still thinking" },
        ],
        fromUs: [{ at: hoursAgo(49) }],
      }, { now, trigger: "Enquire Now" })).toBe(false);
    });
  });

  it("counts a phone call as us having spoken to them", () => {
    // A rep rang them back after the click; that IS Stage 2 being delivered.
    expect(isAwaitingOurReply({
      fromGuest: [{ at: hoursAgo(50), text: "Enquire Now" }],
      fromUs: [{ at: hoursAgo(48) }],
    }, { now })).toBe(true);
  });

  it("excludes someone who called us back after we messaged", () => {
    expect(isAwaitingOurReply({
      fromGuest: [
        { at: hoursAgo(50), text: "Enquire Now" },
        { at: hoursAgo(10), text: "[called us]" },
      ],
      fromUs: [{ at: hoursAgo(49) }],
    }, { now })).toBe(false);
  });
});

describe("hasEngaged", () => {
  it("counts any contact when no button is named", () => {
    expect(hasEngaged({ fromGuest: [{ at: new Date(), text: "hi" }], fromUs: [] })).toBe(true);
    expect(hasEngaged({ fromGuest: [], fromUs: [] })).toBe(false);
  });

  it("counts only the matching tap when a button is named", () => {
    // Keeps the dialog's "Tapped X" count honest: it must not include people
    // the send itself would skip.
    const chatted = { fromGuest: [{ at: new Date(), text: "hi there" }], fromUs: [] };
    expect(hasEngaged(chatted, "Enquire Now")).toBe(false);
    expect(hasEngaged({ fromGuest: [{ at: new Date(), text: "Enquire Now" }], fromUs: [] }, "enquire now")).toBe(true);
  });
});

describe("stillUnsent — a rolling follow-up reaches each person once", () => {
  it("drops anyone this follow-up has already messaged", () => {
    expect(stillUnsent(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  it("keeps everyone when the follow-up hasn't sent anything yet", () => {
    expect(stillUnsent(["a", "b"], [])).toEqual(["a", "b"]);
  });

  it("closes the loop that eligibility alone would leave open", () => {
    // The trap this exists for: we reminded them 50 hours ago and they still
    // haven't replied. That is textbook `isAwaitingOurReply` — we spoke last,
    // and the quiet window has long since passed — so the audience hands them
    // straight back, and without this they'd be reminded again every 48 hours
    // for as long as the chase window stayed open.
    const remindedAndStillSilent: GuestTimeline = {
      fromGuest: [{ at: hoursAgo(100), text: "See Details" }],
      fromUs: [{ at: hoursAgo(99) }, { at: hoursAgo(50) }],
    };
    expect(isAwaitingOurReply(remindedAndStillSilent, { quietHours: 48, now })).toBe(true);
    expect(stillUnsent(["guest-1"], ["guest-1"])).toEqual([]);
  });
});
