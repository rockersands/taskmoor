import type { ComponentType, SVGProps } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';

export interface NavItem {
  id: string;
  labelId: MessageId;
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
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
  return (
    <nav aria-label={t('shell.mainNavigation')} className="nav">
      <ul className="nav-list">
        {items.map(({ id, labelId, href, icon: ItemIcon }) => {
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
        })}
      </ul>
    </nav>
  );
}
