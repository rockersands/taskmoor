import { type ComponentType, type SVGProps, useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';

/** The sections of the navigation, in order (ADR-114). */
export const NAV_GROUPS = [
  { id: 'you', labelId: 'nav.group.you' },
  { id: 'work', labelId: 'nav.group.work' },
  { id: 'manage', labelId: 'nav.group.manage' },
] as const satisfies readonly { id: string; labelId: MessageId }[];

export type NavGroupId = (typeof NAV_GROUPS)[number]['id'];

export interface NavItem {
  id: string;
  labelId: MessageId;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** The section it is listed under; items without one come first, without a heading. */
  group?: NavGroupId;
}

interface NavListProps {
  items: readonly NavItem[];
  activeId: string;
  /** False in the collapsed desktop rail: icons only, with the label as the accessible name. */
  showLabels: boolean;
  onNavigate?: () => void;
}

export function NavList({ items, activeId, showLabels, onNavigate }: NavListProps) {
  const t = useT();
  const baseId = useId();
  const link = ({ id, labelId, href, icon: ItemIcon }: NavItem) => {
    const label = t(labelId);
    return (
      <li key={id}>
        <a
          className="nav-link"
          href={routeHref(href)}
          aria-current={id === activeId ? 'page' : undefined}
          aria-label={showLabels ? undefined : label}
          title={showLabels ? undefined : label}
          onClick={onNavigate}
        >
          <ItemIcon />
          {showLabels && <span className="nav-label">{label}</span>}
        </a>
      </li>
    );
  };
  const loose = items.filter((item) => !item.group);
  return (
    <nav aria-label={t('shell.mainNavigation')} className="nav nav-groups">
      {loose.length > 0 && <ul className="nav-list">{loose.map(link)}</ul>}
      {NAV_GROUPS.map((group) => {
        const members = items.filter((item) => item.group === group.id);
        if (members.length === 0) return null;
        const headingId = `${baseId}-${group.id}`;
        return (
          <div key={group.id} className="nav-group">
            <p id={headingId} className="nav-group-title">
              {t(group.labelId)}
            </p>
            <ul className="nav-list" aria-labelledby={headingId}>
              {members.map(link)}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
