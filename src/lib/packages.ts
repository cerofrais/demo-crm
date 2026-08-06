import { formatINR } from "./utils";

export interface PackageDetails {
  name: string;
  category: string;
  durationDays: number;
  basePriceINR: number;
  therapies: string[];
}

/**
 * Renders a package as a plain-text block for bulk emails. Pure and
 * dependency-free (no prisma) so it's safe to import from both server
 * routes and client components — keeps the preview shown to a rep before
 * sending identical to what's actually appended server-side.
 */
export function formatPackageForEmail(p: PackageDetails): string {
  const lines = [
    p.name,
    `${formatINR(p.basePriceINR)} · ${p.durationDays} day${p.durationDays === 1 ? "" : "s"} · ${p.category}`,
  ];
  if (p.therapies.length > 0) {
    lines.push(`Therapies included: ${p.therapies.join(", ")}`);
  }
  return lines.join("\n");
}
