import { describe, expect, it } from "vitest";
import { ACTION_TYPE_OPTIONS, formatActionLabel, parseActionTypeFilter } from "./activity-log";

describe("formatActionLabel", () => {
  it("names the channel on message actions", () => {
    expect(formatActionLabel("message_sent", { channel: "whatsapp" })).toBe("WhatsApp message sent");
    expect(formatActionLabel("message_received", { channel: "whatsapp" })).toBe(
      "WhatsApp message received",
    );
    expect(formatActionLabel("message_sent", { channel: "email" })).toBe("Email sent");
    expect(formatActionLabel("message_received", { channel: "email" })).toBe("Email received");
  });

  it("spells each channel's own phrasing rather than prefixing a shared noun", () => {
    // "Email message sent" would be the mechanical result and reads badly.
    expect(formatActionLabel("message_sent", { channel: "email" })).not.toContain("message");
    expect(formatActionLabel("message_sent", { channel: "whatsapp" })).toContain("message");
  });

  it("covers edits and deletes, which only started carrying a channel in Sep 2026", () => {
    expect(formatActionLabel("message_edited", { channel: "whatsapp" })).toBe(
      "WhatsApp message edited",
    );
    expect(formatActionLabel("message_deleted", { channel: "email" })).toBe("Email deleted");
  });

  it("falls back to the generic label for rows with no channel", () => {
    // Every Activity written before this change, and any future one whose
    // metadata is missing — never guess a channel.
    expect(formatActionLabel("message_sent")).toBe("Message sent");
    expect(formatActionLabel("message_sent", null)).toBe("Message sent");
    expect(formatActionLabel("message_sent", {})).toBe("Message sent");
    expect(formatActionLabel("message_edited", { messageId: "abc" })).toBe("Message edited");
  });

  it("ignores a channel it doesn't recognise instead of mangling the label", () => {
    expect(formatActionLabel("message_sent", { channel: "sms" })).toBe("Message sent");
    expect(formatActionLabel("message_sent", { channel: 42 })).toBe("Message sent");
  });

  it("leaves non-message actions alone even when a channel is present", () => {
    // auto_tagged carries channel: "whatsapp" but is not a message action.
    expect(formatActionLabel("auto_tagged", { channel: "whatsapp" })).toBe(
      "Tagged from an inbound message",
    );
    expect(formatActionLabel("stage_change", { channel: "email" })).toBe("Stage changed");
  });

  it("de-slugifies an unknown action rather than rendering blank", () => {
    expect(formatActionLabel("some_new_thing")).toBe("some new thing");
  });
});

describe("ACTION_TYPE_OPTIONS", () => {
  const values = ACTION_TYPE_OPTIONS.map(([v]) => v);
  const labels = ACTION_TYPE_OPTIONS.map(([, l]) => l);

  it("offers sent messages per channel instead of one lumped option", () => {
    expect(values).toContain("message_sent:whatsapp");
    expect(values).toContain("message_sent:email");
    expect(values).not.toContain("message_sent");
    expect(labels).toContain("WhatsApp message sent");
    expect(labels).toContain("Email sent");
  });

  it("leaves edits and deletes unsplit — no historical row has a channel", () => {
    // Splitting these would offer two filters that both return nothing for
    // the 154 rows already in the log.
    expect(values).toContain("message_edited");
    expect(values).toContain("message_deleted");
    expect(values).not.toContain("message_edited:whatsapp");
  });

  it("leaves non-message actions exactly as they were", () => {
    expect(values).toContain("stage_change");
    expect(values).toContain("call_made");
  });
});

describe("parseActionTypeFilter", () => {
  it("splits a channel-qualified value", () => {
    expect(parseActionTypeFilter("message_sent:email")).toEqual({
      actionType: "message_sent",
      channel: "email",
    });
  });

  it("passes a plain actionType through unchanged", () => {
    // Bookmarked URLs from before the split must keep working.
    expect(parseActionTypeFilter("stage_change")).toEqual({ actionType: "stage_change" });
  });

  it("returns nothing to filter on for an absent value", () => {
    expect(parseActionTypeFilter(undefined)).toEqual({});
    expect(parseActionTypeFilter(null)).toEqual({});
    expect(parseActionTypeFilter("")).toEqual({});
  });
});

describe("task_deleted", () => {
  it("has a label, so an erased task still reads properly on the timeline", () => {
    // The Activity row outlives the Task it describes — it is the only record
    // that a doctor review was removed.
    expect(formatActionLabel("task_deleted")).toBe("Task deleted");
  });
});
