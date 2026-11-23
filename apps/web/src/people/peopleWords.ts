import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import type { AdminRole, RoleFilter, User } from './client';

/** Each administrator role's name on a person's row and page (T-331; IAM-009). */
export const ROLE_LABEL: Record<AdminRole, MessageId> = {
  site_admin: 'admin.users.siteAdmin',
  configuration_admin: 'admin.users.role.configuration_admin',
  automation_admin: 'admin.users.role.automation_admin',
  ai_admin: 'admin.users.role.ai_admin',
  extension_admin: 'admin.users.role.extension_admin',
};

/** The role filter's choices, in order, with their words (T-331). */
export const ROLE_FILTER_LABEL: Record<RoleFilter, MessageId> = {
  any: 'admin.users.filter.any',
  site_admin: 'admin.users.filter.site_admin',
  configuration_admin: 'admin.users.filter.configuration_admin',
  automation_admin: 'admin.users.filter.automation_admin',
  ai_admin: 'admin.users.filter.ai_admin',
  extension_admin: 'admin.users.filter.extension_admin',
  runs_tracks: 'admin.users.filter.runs_tracks',
  member: 'admin.users.filter.member',
};

/**
 * What a person's row says about their roles (T-331): each administrator role they hold, "Runs
 * N tracks" when they run any, and "Member" when neither.
 */
export function roleWords(t: Translate, user: User): string[] {
  const words = (user.roles ?? []).map((role) => t(ROLE_LABEL[role]));
  const runs = user.tracksRun ?? 0;
  if (runs > 0) words.push(t('admin.users.runsTracks', { count: runs }));
  return words.length > 0 ? words : [t('admin.users.member')];
}

/** Why the server refused a change to a person, in words (IAM-008). */
export function peopleRefusal(t: Translate, error: unknown): string {
  const code =
    error instanceof ApiError ? (error.body as { error?: string } | null)?.error : undefined;
  if (code === 'email_taken') return t('admin.users.problem.emailTaken');
  if (code === 'last_admin') return t('admin.users.problem.lastAdmin');
  if (code === 'cannot_deactivate_self') return t('admin.users.problem.self');
  if (code === 'confirmation_mismatch') return t('admin.users.problem.mismatch');
  if (code === 'cannot_erase_self') return t('admin.users.problem.eraseSelf');
  if (code === 'managed_by_directory' || code === 'managed_by_scim') {
    return t('admin.users.problem.managed');
  }
  if (code === 'already_erased' || code === 'erased') return t('admin.users.problem.erased');
  // Their shared track groups gave the only other person who runs a track its role (ADR-121).
  if (code === 'last_track_admin') return t('admin.users.problem.lastTrackAdmin');
  if (code === 'directory_managed' || code === 'read_only') {
    return t('admin.users.problem.directory');
  }
  if (code === 'invalid_time_zone') return t('account.invalidTimeZone');
  if (code === 'invalid_locale') return t('account.invalidLocale');
  if (code === 'user_deactivated') return t('admin.person.problem.deactivated');
  if (code === 'invalid_request') return t('admin.users.problem.invalid');
  return t('admin.users.problem.other');
}
