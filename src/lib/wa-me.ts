/** wa.me requires digits only — no leading +, spaces, or dashes. */
export function toWaMeDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}
