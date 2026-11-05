import type { ReactNode, Ref } from 'react';

interface EmptyStateProps {
  /** What is missing, in a few words. */
  title: ReactNode;
  /** What would show here and how it gets here. */
  children?: ReactNode;
  /** The next step: usually one link or button. */
  action?: ReactNode;
  /** A short list inside a card: the words alone, with no picture. */
  compact?: boolean;
  /**
   * Lets the page move focus to the title, for a list that empties under the person's hands:
   * what they were on is gone, and the title says what is there now.
   */
  titleRef?: Ref<HTMLParagraphElement>;
}

/**
 * An empty list or page that explains itself (ADR-114): the illustration, what would be here, how
 * it gets here and the step that puts it there.
 */
export function EmptyState({
  title,
  children,
  action,
  compact = false,
  titleRef,
}: EmptyStateProps) {
  return (
    <div className={compact ? 'empty-state empty-state-compact' : 'empty-state'}>
      {!compact && <span className="empty-state-icon" />}
      <p className="empty-state-title" {...(titleRef ? { ref: titleRef, tabIndex: -1 } : {})}>
        {title}
      </p>
      {children && <p className="empty-state-body">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
