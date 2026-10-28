import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../config';

/** One email as the notification mailer hands it to a transport (M1-057). */
export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface MailTransport {
  send(email: OutgoingEmail): Promise<{ messageId: string | null }>;
}

/**
 * SMTP through nodemailer: smtps:// speaks TLS from the start (port 465 unless given),
 * smtp:// upgrades with STARTTLS when the server offers it (port 587 unless given). The
 * password comes from the environment only and is never logged.
 */
export function smtpTransport(config: SmtpConfig): MailTransport {
  const url = new URL(config.url);
  const secure = url.protocol === 'smtps:';
  const transporter = nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    ...(config.user && config.password
      ? { auth: { user: config.user, pass: config.password } }
      : {}),
  });
  return {
    async send(email) {
      const info = await transporter.sendMail({
        from: email.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
      });
      return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
    },
  };
}
