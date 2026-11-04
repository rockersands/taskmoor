import type { ComponentType, ReactNode, Ref, SVGProps } from 'react';

interface EmptyStateProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** What is missing, in a few words. */
  title: ReactNode;
  /** What would show here and how it gets here. */
  children?: ReactNode;
  /** The next step: usually one link or button. */
  action?: ReactNode;
  /**
   * Lets the page move focus to the title, for a list that empties under the person's hands:
   * what they were on is gone, and the title says what is there now.
   */
  titleRef?: Ref<HTMLParagraphElement>;
}

/**
 * An empty list or page that explains itself (ADR-114): what would be here, how it gets here and
 * the step that puts it there.
 */
export function EmptyState({ icon: Icon, title, children, action, titleRef }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {Icon && (
        <span className="empty-state-icon">
          <Icon />
        </span>
      )}
      <p className="empty-state-title" {...(titleRef ? { ref: titleRef, tabIndex: -1 } : {})}>
        {title}
      </p>
      {children && <p className="empty-state-body">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
