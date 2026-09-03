/**
 * The six Permissions of Requirement 14.6 — the single declaration (task 26.2).
 *
 * Ownership moved here from `@/tools/tool`, which held the labels as a transcription
 * and said so in its own comment: "If `src/authz` takes ownership, this becomes a
 * re-export rather than a second declaration." It now is one. `src/policy/checks.ts`
 * (its FINDING 7) and `src/action/action-service.ts` imported the type from there
 * for the same stated reason and now import it from here.
 *
 * This module deliberately has **no imports**. It is the leaf every other module in
 * the Permission story depends on — the tool layer, the API, the Policy_Engine and
 * the Action_Service — so a cycle through it is impossible by construction.
 *
 * The labels and their order are the `permission` enum of
 * `supabase/migrations/20260101000001_money_domains_tenancy_configuration.sql`,
 * which is design.md's "Tenancy, users, permissions" section verbatim. The order is
 * load-bearing in one place only: {@link canonicalisePermissions} reports a granted
 * set in it, so two reads of the same grants compare equal regardless of the row
 * order the database happened to return.
 */

/** The 6 Permissions of Requirement 14.6, in `permission` enum order. */
export const PERMISSIONS = [
  'view_financial_data',
  'run_agents',
  'approve_sensitive_actions',
  'configure_policy',
  'manage_credentials',
  'manage_users',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Exactly 6, asserted by a test rather than by a comment. */
export const PERMISSION_COUNT = 6;

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Is this one of the six?
 *
 * Used on every value that arrives from outside the type system — a JWT claim, a
 * `user_permissions` row, a request body. A label the enum does not name is not a
 * Permission, and treating an unrecognised label as a grant is the one failure
 * direction that must be impossible (Requirement 14.6).
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/**
 * The recognised members of `values`, deduplicated and in {@link PERMISSIONS} order.
 *
 * Unrecognised labels are **dropped, not rejected**: this is the read path for a
 * granted set, and an unknown label there means the database enum gained a member
 * this build does not know about. Dropping it grants nothing; throwing would deny a
 * User the six Permissions they do hold. The write path — `require` — is the one
 * that refuses an unknown label, because a *required* Permission nobody can hold
 * must never read as satisfied.
 */
export function canonicalisePermissions(values: readonly unknown[]): readonly Permission[] {
  const held = new Set<Permission>();
  for (const value of values) {
    if (isPermission(value)) held.add(value);
  }
  return PERMISSIONS.filter((permission) => held.has(permission));
}
