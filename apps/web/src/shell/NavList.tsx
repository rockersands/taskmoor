import type { ComponentType, SVGProps } from 'react';

export interface NavItem {
  id: string;
  label: string;
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
  return (
    <nav aria-label="Main" className="nav">
      <ul className="nav-list">
        {items.map(({ id, label, href, icon: ItemIcon }) => (
          <li key={id}>
            <a
              className="nav-link"
              href={href}
              aria-current={id === activeId ? 'page' : undefined}
              aria-label={showLabels ? undefined : label}
              title={showLabels ? undefined : label}
              onClick={onNavigate}
            >
              <ItemIcon />
              {showLabels && <span className="nav-label">{label}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
