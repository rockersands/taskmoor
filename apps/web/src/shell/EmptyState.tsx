import type { ComponentType, ReactNode, SVGProps } from 'react';

interface EmptyStateProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** What is missing, in a few words. */
  title: ReactNode;
  /** What would show here and how it gets here. */
  children?: ReactNode;
  /** The next step: usually one link or button. */
  action?: ReactNode;
}

/**
 * An empty list or page that explains itself (ADR-112): what would be here, how it gets here and
 * the step that puts it there.
 */
export function EmptyState({ icon: Icon, title, children, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon && (
        <span className="empty-state-icon">
          <Icon />
        </span>
      )}
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-body">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
