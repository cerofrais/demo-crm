/**
 * Age maths, split out of utils.ts so lib/lead-tags.ts can use it.
 *
 * lead-tags is deliberately dependency-free — it runs on the client, on the
 * server, and in one-off scripts run against the standalone build, where the
 * app's UI dependencies simply are not installed. Importing ageFromDob from
 * utils.ts dragged clsx and tailwind-merge in behind it (utils also holds
 * `cn`), which broke exactly that third case. utils.ts re-exports everything
 * here, so every existing import site is unchanged.
 */
export function ageFromDob(dob?: string | Date | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

export function ageGroup(age: number | null): string {
  if (age == null) return "—";
  if (age < 35) return "Under 35";
  if (age < 50) return "35–49";
  return "50+";
}

/**
 * Inverse of ageFromDob — a self-reported age (from a form's "Age" field,
 * not a real birth date) turned into an approximate dateOfBirth so the
 * existing ageGroup() bucketing works off it. Uses the same 365.25-day-year
 * math as ageFromDob so round-tripping this back through ageFromDob lands
 * on the same age.
 */
export function ageToDateOfBirth(age: number): Date {
  return new Date(Date.now() - age * 365.25 * 24 * 3600 * 1000);
}
