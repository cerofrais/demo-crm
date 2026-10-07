import { describe, expect, it } from "vitest";
import { matchByTime, messageIdFromMetadata, type CandidateMessage } from "./activity-media";

const at = (iso: string) => new Date(iso);

const activity = (id: string, iso: string, actionType: string, guestId: string | null = "g1") => ({
  id,
  guestId,
  createdAt: at(iso),
  actionType,
  metadata: {},
});

const message = (id: string, iso: string, direction: string, guestId: string | null = "g1"): CandidateMessage => ({
  id,
  guestId,
  direction,
  createdAt: at(iso),
  attachment: { id: `doc-${id}`, filename: `${id}.jpg`, mimeType: "image/jpeg", sizeBytes: 1000 },
});

describe("messageIdFromMetadata", () => {
  it("reads the id a newer row records outright", () => {
    expect(messageIdFromMetadata({ voiceNote: true, messageId: "m1" })).toBe("m1");
  });

  it("is null for the older rows that never recorded one", () => {
    expect(messageIdFromMetadata({ channel: "whatsapp" })).toBeNull();
    expect(messageIdFromMetadata(null)).toBeNull();
    expect(messageIdFromMetadata({ messageId: 42 })).toBeNull();
  });
});

describe("matchByTime", () => {
  it("pairs an activity with the message written alongside it", () => {
    const matched = matchByTime(
      [activity("a1", "2026-09-30T10:00:00.100Z", "message_received")],
      [message("m1", "2026-09-30T10:00:00.000Z", "inbound")],
    );
    expect(matched.get("a1")?.id).toBe("m1");
  });

  it("never gives the same message to two activities", () => {
    // Three photos seconds apart: without this, the first one is shown three
    // times and the other two never appear at all.
    const matched = matchByTime(
      [
        activity("a1", "2026-09-30T10:00:01.000Z", "message_received"),
        activity("a2", "2026-09-30T10:00:03.000Z", "message_received"),
        activity("a3", "2026-09-30T10:00:05.000Z", "message_received"),
      ],
      [
        message("m1", "2026-09-30T10:00:01.000Z", "inbound"),
        message("m2", "2026-09-30T10:00:03.000Z", "inbound"),
        message("m3", "2026-09-30T10:00:05.000Z", "inbound"),
      ],
    );
    expect([matched.get("a1")?.id, matched.get("a2")?.id, matched.get("a3")?.id]).toEqual(["m1", "m2", "m3"]);
  });

  it("will not pair across direction, guest, or a long gap", () => {
    const sent = activity("a1", "2026-09-30T10:00:00.000Z", "message_sent");
    expect(matchByTime([sent], [message("m1", "2026-09-30T10:00:00.000Z", "inbound")]).size).toBe(0);
    expect(matchByTime([sent], [message("m1", "2026-09-30T10:00:00.000Z", "outbound", "g2")]).size).toBe(0);
    // A minute apart is a different message, not a slow write.
    expect(matchByTime([sent], [message("m1", "2026-09-30T10:01:00.000Z", "outbound")]).size).toBe(0);
  });

  it("ignores activities that are not about a message at all", () => {
    const matched = matchByTime(
      [activity("a1", "2026-09-30T10:00:00.000Z", "stage_change")],
      [message("m1", "2026-09-30T10:00:00.000Z", "inbound")],
    );
    expect(matched.size).toBe(0);
  });

  it("takes the closest message when several are in the window", () => {
    const matched = matchByTime(
      [activity("a1", "2026-09-30T10:00:08.000Z", "message_received")],
      [message("m1", "2026-09-30T10:00:01.000Z", "inbound"), message("m2", "2026-09-30T10:00:07.500Z", "inbound")],
    );
    expect(matched.get("a1")?.id).toBe("m2");
  });
});
