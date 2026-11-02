/**
 * The identity an erased person's account takes (ASVS 8.3.2, IAM-008 (2); ADR-111): stable,
 * derived from the account's id alone, so every record that points at the account shows the
 * same placeholder and nothing about who it was.
 */
export const ERASED_DOMAIN = 'erased.invalid';
export const erasedName = (id: number) => `Former user ${id}`;
export const erasedEmail = (id: number) => `erased-${id}@${ERASED_DOMAIN}`;
