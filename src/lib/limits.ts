/**
 * Batch ceilings shared by the Guests page and the APIs it calls.
 *
 * These were four separate `5000` literals in four files, which is how they
 * quietly stopped meaning the same thing — raising one did nothing, because a
 * different one bound first. They are named here so the coupling is visible
 * and a change lands everywhere at once.
 */

/**
 * Most guests one action can touch: "select all matching", and the bulk tag
 * removal that runs off that selection.
 *
 * The ceiling is about request size and write time, not safety — cleanup work
 * gets no worse per guest as the batch grows.
 */
export const MAX_BULK_GUESTS = 7000;

/**
 * Most recipients a single broadcast may target.
 *
 * Deliberately its own number rather than reusing MAX_BULK_GUESTS: this one
 * is a judgement about deliverability, not a technical limit. Meta throttles
 * marketing per recipient (error 131049 — 62% of a 2,001-message send on
 * 2026-08-21), and one very large send fares worse per message than the same
 * audience split across smaller ones. Raise it knowing that.
 */
export const MAX_BROADCAST_RECIPIENTS = 7000;
