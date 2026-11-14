import { type ReactNode, useEffect, useRef } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { ApiToken } from './client';
import { daysUntil, dueForRotation, useTokenText } from './format';

export interface TokenItemProps {
  token: ApiToken;
  /** Tokens expiring within this many days are flagged as due for rotation. */
  reminderDays: number;
  /** The reader's time zone for dates; null follows the device. */
  timeZone?: string | null;
  /** Shows whose token it is (the administrator's inventory). */
  showOwner?: boolean;
  /** Buttons for this token, such as Revoke. */
  actions?: ReactNode;
  /** Takes the focus (the first token a list's last page brought, as its Show more goes). */
  focused?: boolean;
}

/** One API token in a list: name, status, owner, scopes, dates and the actions offered. */
export function TokenItem({
  token,
  reminderDays,
  timeZone = null,
  showOwner = false,
  actions,
  focused = false,
}: TokenItemProps) {
  const t = useT();
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) item.current?.focus();
  }, [focused]);
  const text = useTokenText(timeZone);
  const replaced = token.status === 'active' && token.replacedBy !== null;
  const status = replaced ? 'replaced' : token.status;
  const soon = dueForRotation(token, reminderDays);

  let expiry: string;
  if (token.status === 'revoked' && token.revokedAt) {
    expiry = t('tokenInfo.revokedAt', { when: text.when(token.revokedAt) });
  } else if (token.status === 'expired') {
    expiry = t('tokenInfo.expired', { when: text.when(token.expiresAt) });
  } else if (soon) {
    expiry = t('tokenInfo.expiresSoon', { days: daysUntil(token.expiresAt) });
  } else {
    expiry = t('tokenInfo.expires', { when: text.day(token.expiresAt) });
  }

  return (
    <li ref={item} className="token-item" data-status={status} tabIndex={focused ? -1 : undefined}>
      <div className="token-main">
        <p className="token-name">
          <span>{text.value(token.name)}</span>
          <span className={`token-badge token-badge-${status}`}>
            {t(`tokenInfo.status.${status}`)}
          </span>
        </p>
        {showOwner && (
          <p className="token-owner">
            <span>
              {t('tokenInfo.owner', { name: token.owner.name, email: token.owner.email })}
            </span>
            {token.owner.kind === 'service' && (
              <span className="token-badge">{t('tokenInfo.serviceAccount')}</span>
            )}
            {!token.owner.active && (
              <span className="token-badge token-badge-revoked">
                {t('tokenInfo.ownerDeactivated')}
              </span>
            )}
          </p>
        )}
        <p className="token-meta">
          <span>{text.scopes(token.scopes)}</span>
          <span>{t('tokenInfo.created', { when: text.day(token.createdAt) })}</span>
          <span>
            {token.lastUsedAt
              ? token.lastUsedIp && showOwner
                ? t('tokenInfo.lastUsedFrom', {
                    when: text.when(token.lastUsedAt),
                    address: token.lastUsedIp,
                  })
                : t('tokenInfo.lastUsed', { when: text.when(token.lastUsedAt) })
              : t('tokenInfo.neverUsed')}
          </span>
          <span className={soon ? 'status-warn' : undefined}>{expiry}</span>
        </p>
      </div>
      {actions && <div className="token-actions">{actions}</div>}
    </li>
  );
}
