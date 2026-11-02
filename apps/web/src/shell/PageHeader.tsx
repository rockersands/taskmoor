import type { ReactNode } from 'react';
import { HelpTip } from './HelpTip';

interface PageHeaderProps {
  /** The page's name, its only level-one heading. */
  title: ReactNode;
  /** Plain text of the title for the help button's name, when the title is not a string. */
  titleText?: string;
  titleId?: string;
  /** One line under the title saying what the page is for (ADR-112). */
  purpose?: ReactNode;
  /** A longer explanation behind the "What is this for?" button. */
  about?: ReactNode;
  /** A small line above the title: where the page sits, such as a track and a ticket type. */
  eyebrow?: ReactNode;
  /** The page's own actions, at the right end on wide screens and under the title on phones. */
  actions?: ReactNode;
}

/**
 * The top of every page (ADR-112): where it sits, its name, one line on what it is for, an
 * optional longer explanation and its actions.
 */
export function PageHeader({
  title,
  titleText,
  titleId,
  purpose,
  about,
  eyebrow,
  actions,
}: PageHeaderProps) {
  const name = titleText ?? (typeof title === 'string' ? title : '');
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
        <div className="page-header-title">
          <h1 id={titleId} className="page-title">
            {title}
          </h1>
          {about && name && <HelpTip name={name}>{about}</HelpTip>}
        </div>
        {purpose && <p className="page-purpose">{purpose}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
