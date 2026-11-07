/**
 * Produces the case-insensitive lookup key stored in identity_users.normalized_email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}
