/**
 * Invitation emails (IAM-027; ADR-118), in English or Spanish by the reader's locale. The text
 * is ours, with only the inviter's name and the track's and role's names from data: there is no
 * free-text message, so an invitation cannot carry someone's advert. The link's token is in this
 * email and nowhere else; it is never stored or logged.
 */
export type InvitationEmailKind = 'invited' | 'added';

export interface InvitationEmail {
  inviterName: string;
  trackKey: string;
  trackName: string;
  roleName: string;
  url: string;
  /** When the link stops working; none for a plain notice. */
  expiresAt: Date | null;
}

const EN = {
  'subject.invited': '{inviter} invited you to {key} on Taskmoor',
  'subject.added': '{inviter} added you to {key} on Taskmoor',
  invited: '{inviter} invited you to the track {key} ({track}) as {role}.',
  added: '{inviter} added you to the track {key} ({track}) as {role}. You can use it right away.',
  'open.invited': 'Accept the invitation',
  'open.added': 'Open the track',
  expires: 'This link works once and stops working on {date}.',
  ignore: 'If you did not expect this, you can ignore this email or tell your administrator.',
} as const;
type MessageId = keyof typeof EN;

const ES: Record<MessageId, string> = {
  'subject.invited': '{inviter} te invitó a {key} en Taskmoor',
  'subject.added': '{inviter} te añadió a {key} en Taskmoor',
  invited: '{inviter} te invitó al track {key} ({track}) como {role}.',
  added: '{inviter} te añadió al track {key} ({track}) como {role}. Ya puedes usarlo.',
  'open.invited': 'Aceptar la invitación',
  'open.added': 'Abrir el track',
  expires: 'Este enlace funciona una vez y deja de funcionar el {date}.',
  ignore: 'Si no lo esperabas, ignora este correo o avisa a tu administrador.',
};

export const INVITATION_EMAIL_MESSAGES: Record<string, Record<MessageId, string>> = {
  en: EN,
  es: ES,
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** The email as text and HTML; everything taken from data is escaped in HTML. */
export function renderInvitationEmail(
  kind: InvitationEmailKind,
  invitation: InvitationEmail,
  locale: string | null,
): { subject: string; text: string; html: string } {
  const language = (locale ?? 'en').split('-')[0]?.toLowerCase() ?? 'en';
  const table = INVITATION_EMAIL_MESSAGES[language] ?? EN;
  const values: Record<string, string> = {
    inviter: invitation.inviterName,
    key: invitation.trackKey,
    track: invitation.trackName,
    role: invitation.roleName,
    date: invitation.expiresAt
      ? new Intl.DateTimeFormat(language === 'es' ? 'es' : 'en', {
          dateStyle: 'long',
          timeZone: 'UTC',
        }).format(invitation.expiresAt)
      : '',
  };
  const t = (id: MessageId, mask: (text: string) => string = (text) => text) =>
    table[id].replace(/\{(\w+)\}/g, (_, name: string) => mask(values[name] ?? ''));
  // A line break in a name must not start another header line.
  const subject = t(`subject.${kind}`).replace(/[\r\n]+/g, ' ');
  const open = t(`open.${kind}`);
  const notes = [...(invitation.expiresAt ? [t('expires')] : []), t('ignore')];
  return {
    subject,
    text: [t(kind), '', `${open}: ${invitation.url}`, '', ...notes].join('\n'),
    html: `<!doctype html><html><body style="font-family:sans-serif"><p>${t(kind, escapeHtml)}</p><p><a href="${escapeHtml(
      invitation.url,
    )}">${escapeHtml(open)}</a></p>${notes
      .map((n) => `<p style="color:#555;font-size:12px">${escapeHtml(n)}</p>`)
      .join('')}</body></html>`,
  };
}
