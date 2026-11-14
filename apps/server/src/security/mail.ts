import type { Database, JsonValue, SecurityEmailKind } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { MailTransport } from '../email/transport';

/**
 * Security emails (ADR-109): the notices of `notices.ts` to the person whose credentials
 * changed, and alerts to site administrators, in English or Spanish by the reader's locale.
 *
 * - One email per notice, sent at the next run (every 15 seconds on a worker): no batching,
 *   no digest, no quiet hours, and no notification preference or unsubscribe link applies
 *   (ASVS 2.2.3: people must hear of it).
 * - A notice says what changed, when (in the reader's time zone), from which address and
 *   User-Agent, and who made the change, then how to get help. It carries no link that signs
 *   anyone in: the only address in it is the instance's own sign-in page.
 * - A failed send is retried at later runs, up to 10 attempts; the last error is kept.
 */
export interface SecurityMailerOptions {
  transport: MailTransport;
  from: string;
  publicUrl: string;
  now?: Date;
}

export const MAX_ATTEMPTS = 10;

const EN = {
  'subject.password_changed': 'Your Taskmoor password was changed',
  'subject.two_factor_enabled': 'A second factor was added to your Taskmoor account',
  'subject.two_factor_disabled': 'A second factor was removed from your Taskmoor account',
  'subject.recovery_codes_regenerated': 'New recovery codes were made for your Taskmoor account',
  'subject.two_factor_reset': 'The second factors of your Taskmoor account were reset',
  'subject.email_changed': 'The email address of your Taskmoor account was changed',
  'subject.alert': 'Taskmoor security alert: {rule}',
  'what.password_changed': 'The password of your account was changed.',
  'what.password_changed.link': 'The password of your account was changed with a reset link.',
  'what.two_factor_enabled.totp': 'An authenticator app was added as a second factor.',
  'what.two_factor_enabled.webauthn': 'A security key was added as a second factor.',
  'what.two_factor_disabled.totp': 'The authenticator app was removed as a second factor.',
  'what.two_factor_disabled.webauthn': 'A security key was removed as a second factor.',
  'what.recovery_codes_regenerated':
    'New recovery codes were made for your account. The old ones no longer work.',
  'what.two_factor_reset':
    'An administrator removed every second factor of your account. You will set one up again at your next sign-in if the site requires it.',
  'what.email_changed':
    'The email address of your account was changed to {address}. Taskmoor writes to the new address from now on; this is the last email sent here.',
  'by.self': 'Made by: you, while signed in.',
  'by.administrator': 'Made by: a site administrator.',
  'by.system': 'Made by: your organisation’s identity service.',
  when: 'When: {time}',
  from: 'From: {ip}',
  agent: 'Browser or program: {agent}',
  unknown: 'not recorded',
  help: 'If this was you, there is nothing to do. If it was not, contact your Taskmoor administrator straight away, and change your password from the sign-in page: {url}',
  noLink: 'This email contains no link that signs you in. Never share your password or codes.',
  'alert.intro': 'A security alert rule of your Taskmoor site was triggered.',
  'rule.sign_in_failures_account': 'failed sign-ins for one account',
  'rule.sign_in_failures_address': 'failed sign-ins from one address',
  'rule.access_refusals': 'repeated refused requests',
  'rule.bulk_exports': 'bulk exports',
  'rule.ai_spend': 'AI spend limit',
  'alert.count': '{count} in {minutes} minutes (the threshold is {threshold}).',
  'alert.ai': '{percent}% of an AI spend limit is used ({used} of {amount}, {metric}).',
  'alert.account': 'Account: {who}',
  'alert.email': 'Email typed: {email}',
  'alert.address': 'Address: {ip}',
  'alert.token': 'API token: {id}',
  'alert.review': 'Review it in the audit log: {url}',
  'alert.footer': 'You get this email because you are a site administrator.',
} as const;
type MessageId = keyof typeof EN;

const ES: Record<MessageId, string> = {
  'subject.password_changed': 'Se cambió tu contraseña de Taskmoor',
  'subject.two_factor_enabled': 'Se añadió un segundo factor a tu cuenta de Taskmoor',
  'subject.two_factor_disabled': 'Se quitó un segundo factor de tu cuenta de Taskmoor',
  'subject.recovery_codes_regenerated':
    'Se crearon códigos de recuperación nuevos para tu cuenta de Taskmoor',
  'subject.two_factor_reset': 'Se restablecieron los segundos factores de tu cuenta de Taskmoor',
  'subject.email_changed': 'Se cambió la dirección de correo de tu cuenta de Taskmoor',
  'subject.alert': 'Alerta de seguridad de Taskmoor: {rule}',
  'what.password_changed': 'Se cambió la contraseña de tu cuenta.',
  'what.password_changed.link':
    'Se cambió la contraseña de tu cuenta con un enlace de restablecimiento.',
  'what.two_factor_enabled.totp': 'Se añadió una aplicación de autenticación como segundo factor.',
  'what.two_factor_enabled.webauthn': 'Se añadió una llave de seguridad como segundo factor.',
  'what.two_factor_disabled.totp': 'Se quitó la aplicación de autenticación como segundo factor.',
  'what.two_factor_disabled.webauthn': 'Se quitó una llave de seguridad como segundo factor.',
  'what.recovery_codes_regenerated':
    'Se crearon códigos de recuperación nuevos para tu cuenta. Los anteriores ya no sirven.',
  'what.two_factor_reset':
    'Un administrador quitó todos los segundos factores de tu cuenta. Configurarás uno de nuevo al iniciar sesión si el sitio lo exige.',
  'what.email_changed':
    'La dirección de correo de tu cuenta cambió a {address}. Desde ahora Taskmoor escribe a la nueva dirección; este es el último correo que se envía aquí.',
  'by.self': 'Lo hiciste tú, con la sesión iniciada.',
  'by.administrator': 'Lo hizo un administrador del sitio.',
  'by.system': 'Lo hizo el servicio de identidad de tu organización.',
  when: 'Cuándo: {time}',
  from: 'Desde: {ip}',
  agent: 'Navegador o programa: {agent}',
  unknown: 'no registrado',
  help: 'Si fuiste tú, no tienes que hacer nada. Si no, avisa enseguida a tu administrador de Taskmoor y cambia tu contraseña desde la página de inicio de sesión: {url}',
  noLink:
    'Este correo no contiene ningún enlace que inicie tu sesión. Nunca compartas tu contraseña ni tus códigos.',
  'alert.intro': 'Se activó una regla de alerta de seguridad de tu sitio de Taskmoor.',
  'rule.sign_in_failures_account': 'inicios de sesión fallidos de una cuenta',
  'rule.sign_in_failures_address': 'inicios de sesión fallidos desde una dirección',
  'rule.access_refusals': 'solicitudes rechazadas repetidas',
  'rule.bulk_exports': 'exportaciones masivas',
  'rule.ai_spend': 'límite de gasto de IA',
  'alert.count': '{count} en {minutes} minutos (el umbral es {threshold}).',
  'alert.ai': 'Se usa el {percent} % de un límite de gasto de IA ({used} de {amount}, {metric}).',
  'alert.account': 'Cuenta: {who}',
  'alert.email': 'Correo escrito: {email}',
  'alert.address': 'Dirección: {ip}',
  'alert.token': 'Token de API: {id}',
  'alert.review': 'Revísala en el registro de auditoría: {url}',
  'alert.footer': 'Recibes este correo porque eres administrador del sitio.',
};

export const SECURITY_EMAIL_MESSAGES: Record<string, Record<MessageId, string>> = {
  en: EN,
  es: ES,
};

function translator(locale: string | null) {
  const table =
    SECURITY_EMAIL_MESSAGES[(locale ?? 'en').split('-')[0]?.toLowerCase() ?? 'en'] ?? EN;
  return (id: MessageId, values: Record<string, string | number> = {}) =>
    (table[id] ?? EN[id]).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function formatTime(iso: unknown, locale: string | null, timeZone: string | null): string {
  const at = new Date(typeof iso === 'string' ? iso : Date.now());
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'long',
    timeStyle: 'long',
    timeZone: timeZone ?? 'UTC',
  };
  try {
    return new Intl.DateTimeFormat(locale ?? 'en', options).format(at);
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format(at);
  }
}

const text = (value: JsonValue | undefined) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** A notice or alert as text and HTML; everything taken from data is escaped in HTML. */
export function renderSecurityEmail(
  kind: SecurityEmailKind,
  details: Record<string, JsonValue>,
  reader: { locale: string | null; timeZone: string | null },
  publicUrl: string,
): RenderedEmail {
  const t = translator(reader.locale);
  const base = publicUrl.replace(/\/$/, '');
  const lines: string[] = [];
  let subject: string;
  if (kind === 'alert') {
    const rule = text(details.rule) || 'access_refusals';
    const ruleName = t(`rule.${rule}` as MessageId) || rule;
    subject = t('subject.alert', { rule: ruleName });
    lines.push(t('alert.intro'), '');
    if (rule === 'ai_spend') {
      lines.push(
        t('alert.ai', {
          percent: text(details.percent),
          used: text(details.used),
          amount: text(details.amount),
          metric: text(details.metric),
        }),
      );
    } else {
      lines.push(
        t('alert.count', {
          count: text(details.count),
          minutes: text(details.windowMinutes),
          threshold: text(details.threshold),
        }),
      );
    }
    if (details.userName || details.userEmail) {
      const who = [
        text(details.userName),
        text(details.userEmail) && `<${text(details.userEmail)}>`,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(t('alert.account', { who }));
    }
    if (details.email) lines.push(t('alert.email', { email: text(details.email) }));
    if (details.address) lines.push(t('alert.address', { ip: text(details.address) }));
    if (details.tokenId) lines.push(t('alert.token', { id: text(details.tokenId) }));
    lines.push(t('when', { time: formatTime(details.at, reader.locale, reader.timeZone) }), '');
    lines.push(t('alert.review', { url: `${base}/#/admin/audit` }), '', '--', t('alert.footer'));
  } else {
    subject = t(`subject.${kind}` as MessageId);
    const method = text(details.method) === 'webauthn' ? 'webauthn' : 'totp';
    const what =
      kind === 'password_changed'
        ? t(details.via === 'link' ? 'what.password_changed.link' : 'what.password_changed')
        : kind === 'two_factor_enabled' || kind === 'two_factor_disabled'
          ? t(`what.${kind}.${method}` as MessageId)
          : kind === 'email_changed'
            ? t('what.email_changed', { address: text(details.newAddress) })
            : t(`what.${kind}` as MessageId);
    const by = text(details.by);
    lines.push(
      what,
      '',
      t('when', { time: formatTime(details.at, reader.locale, reader.timeZone) }),
      t('from', { ip: text(details.ip) || t('unknown') }),
      t('agent', { agent: text(details.userAgent) || t('unknown') }),
      t(by === 'administrator' ? 'by.administrator' : by === 'system' ? 'by.system' : 'by.self'),
      '',
      t('help', { url: `${base}/` }),
      '',
      '--',
      t('noLink'),
    );
  }
  const html = lines
    .map((line) => (line === '' ? '' : line === '--' ? '<hr>' : `<p>${escapeHtml(line)}</p>`))
    .join('');
  return {
    subject,
    text: lines.join('\n'),
    html: `<!doctype html><html><body style="font-family:sans-serif">${html}</body></html>`,
  };
}

export interface SecurityMailerRun {
  sent: number;
  failed: number;
  dropped: number;
}

/**
 * Sends the security emails not yet sent, oldest first, 100 per run. Each row is locked while
 * it goes out (SKIP LOCKED), so several workers never send one twice.
 */
export async function deliverSecurityEmail(
  db: Kysely<Database>,
  options: SecurityMailerOptions,
): Promise<SecurityMailerRun> {
  const run: SecurityMailerRun = { sent: 0, failed: 0, dropped: 0 };
  const now = options.now ?? new Date();
  // A failed send waits for the next run rather than being tried again at once.
  const tried: string[] = [];
  for (let i = 0; i < 100; i++) {
    const done = await db.transaction().execute(async (trx) => {
      let query = trx
        .selectFrom('security_email as e')
        .innerJoin('app_user as u', 'u.id', 'e.user_id')
        .select([
          'e.id',
          'e.kind',
          'e.to_address',
          'e.details',
          'e.attempts',
          'u.locale',
          'u.time_zone',
          'u.deactivated_at',
        ])
        .where('e.sent_at', 'is', null)
        .where('e.attempts', '<', MAX_ATTEMPTS);
      if (tried.length > 0) query = query.where('e.id', 'not in', tried);
      const row = await query
        .orderBy('e.id')
        .limit(1)
        .forUpdate('e')
        .skipLocked()
        .executeTakeFirst();
      if (!row) return false;
      tried.push(row.id);
      // An alert for an administrator deactivated meanwhile is not sent; a notice still is:
      // the account may have been taken over and then deactivated.
      if (row.kind === 'alert' && row.deactivated_at) {
        await trx
          .updateTable('security_email')
          .set({ sent_at: now, last_error: 'recipient deactivated' })
          .where('id', '=', row.id)
          .execute();
        run.dropped += 1;
        return true;
      }
      const email = renderSecurityEmail(
        row.kind,
        row.details,
        { locale: row.locale, timeZone: row.time_zone },
        options.publicUrl,
      );
      try {
        const { messageId } = await options.transport.send({
          from: options.from,
          to: row.to_address,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
        await trx
          .updateTable('security_email')
          .set({
            sent_at: now,
            message_id: messageId,
            attempts: row.attempts + 1,
            last_error: null,
          })
          .where('id', '=', row.id)
          .execute();
        run.sent += 1;
      } catch (error) {
        await trx
          .updateTable('security_email')
          .set({
            attempts: row.attempts + 1,
            last_error: error instanceof Error ? error.message.slice(0, 500) : 'send failed',
          })
          .where('id', '=', row.id)
          .execute();
        run.failed += 1;
      }
      return true;
    });
    if (!done) break;
  }
  return run;
}
