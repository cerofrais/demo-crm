/**
 * The optional booking detail a rep fills in on the lead drawer once a stay
 * is firming up: occupancy, who the guest is sharing with, length of stay,
 * how many rooms, nightly rate and room category.
 *
 * Kept out of the PATCH route so the "what changed" wording is testable on
 * its own. That wording is not cosmetic — it IS the audit record. The route
 * stores these strings verbatim in the Activity row's metadata, so changing
 * a label here changes what already-written history reads like the next time
 * somebody opens the timeline.
 */
import { formatINR } from "./utils";

export type Occupancy = "single" | "double";
export type RoomCategory = "premium" | "executive";

export interface BookingDetails {
  occupancy: Occupancy | null;
  companionName: string | null;
  stayDays: number | null;
  roomCount: number | null;
  pricePerDayINR: number | null;
  roomCategory: RoomCategory | null;
}

/** A PATCH body's view of the same fields: absent key = "don't touch". */
export type BookingDetailsPatch = {
  [K in keyof BookingDetails]?: BookingDetails[K] | undefined;
};

export const OCCUPANCY_LABELS: Record<Occupancy, string> = {
  single: "Single",
  double: "Double",
};

export const ROOM_CATEGORY_LABELS: Record<RoomCategory, string> = {
  premium: "Premium",
  executive: "Executive",
};

/** The field labels, shared by the drawer and the activity wording. */
const FIELD_LABELS: Record<keyof BookingDetails, string> = {
  occupancy: "Occupancy",
  companionName: "Staying with",
  stayDays: "Days",
  roomCount: "Rooms",
  pricePerDayINR: "Price/day",
  roomCategory: "Room",
};

/**
 * Total for the stay, or null when either half is missing.
 *
 * Deliberately derived rather than stored: a rep who corrects the rate would
 * otherwise leave a stale total behind, and there is no case where the total
 * should disagree with days × rate.
 */
export function bookingTotalINR(
  stayDays: number | null | undefined,
  pricePerDayINR: number | null | undefined,
): number | null {
  if (stayDays == null || pricePerDayINR == null) return null;
  return stayDays * pricePerDayINR;
}

function display(field: keyof BookingDetails, value: BookingDetails[keyof BookingDetails]): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (field) {
    case "occupancy":
      return OCCUPANCY_LABELS[value as Occupancy] ?? String(value);
    case "roomCategory":
      return ROOM_CATEGORY_LABELS[value as RoomCategory] ?? String(value);
    case "pricePerDayINR":
      return formatINR(value as number);
    default:
      return String(value);
  }
}

/**
 * One "Label: old -> new" line per field the request actually changed.
 *
 * A key the request never sent is skipped, and so is one sent with the value
 * it already had — otherwise saving the drawer would log a booking change
 * every time a rep edited an unrelated field like the phone number, which is
 * how an audit trail stops being worth reading.
 */
export function formatBookingChanges(
  before: BookingDetails,
  after: BookingDetailsPatch,
): string[] {
  const fields = Object.keys(FIELD_LABELS) as (keyof BookingDetails)[];
  const changes: string[] = [];
  for (const field of fields) {
    const next = after[field];
    if (next === undefined) continue;
    if (next === before[field]) continue;
    changes.push(`${FIELD_LABELS[field]}: ${display(field, before[field])} -> ${display(field, next)}`);
  }
  return changes;
}

/**
 * The one-line summary shown on the timeline, e.g.
 * "Double occupancy with Priya Sharma · 7 days · ₹12,000/day · ₹84,000 total · Premium".
 *
 * Built from the state AFTER the save rather than from the diff, so the line
 * reads as the booking as it now stands instead of as a list of edits.
 * Returns null when nothing at all is set.
 */
export function summarizeBooking(d: BookingDetails): string | null {
  const parts: string[] = [];
  if (d.occupancy) {
    const base = `${OCCUPANCY_LABELS[d.occupancy]} occupancy`;
    // The companion only means anything on a double; a name left over from a
    // single booking (older rows were never validated) is not worth showing.
    parts.push(
      d.occupancy === "double" && d.companionName ? `${base} with ${d.companionName}` : base,
    );
  } else if (d.companionName) {
    parts.push(`Staying with ${d.companionName}`);
  }
  if (d.stayDays != null) parts.push(`${d.stayDays} day${d.stayDays === 1 ? "" : "s"}`);
  if (d.roomCount != null) parts.push(`${d.roomCount} room${d.roomCount === 1 ? "" : "s"}`);
  if (d.pricePerDayINR != null) parts.push(`${formatINR(d.pricePerDayINR)}/day`);
  const total = bookingTotalINR(d.stayDays, d.pricePerDayINR);
  if (total != null) parts.push(`${formatINR(total)} total`);
  if (d.roomCategory) parts.push(ROOM_CATEGORY_LABELS[d.roomCategory]);
  return parts.length ? parts.join(" · ") : null;
}
