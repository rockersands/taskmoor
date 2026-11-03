import type { ComponentType, ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import {
  BugIcon,
  ChoreIcon,
  CustomTypeIcon,
  FeatureIcon,
  type IconProps,
  IdeaIcon,
  OutcomeIcon,
  PriorityLevelIcon,
  SubticketIcon,
  ToDoIcon,
} from './icons';
import { priorityName } from './priorityName';

/** The ticket type icons, by the name a type's `icon` holds. */
const TYPE_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  outcome: OutcomeIcon,
  feature: FeatureIcon,
  bug: BugIcon,
  chore: ChoreIcon,
  'to-do': ToDoIcon,
  idea: IdeaIcon,
  subticket: SubticketIcon,
};

/** Where a priority sits when nothing says: the middle of the six levels. */
const MIDDLE_LEVEL = 4;

/** The picture alone, for beside a word that already names it. */
export function TypeGlyph({ name, icon }: { name: string; icon?: string | null | undefined }) {
  const wanted = icon ?? name.toLowerCase();
  const Glyph = Object.hasOwn(TYPE_ICONS, wanted)
    ? (TYPE_ICONS[wanted] as ComponentType<IconProps>)
    : CustomTypeIcon;
  return <Glyph width={16} height={16} />;
}

/** The picture alone, for beside a word that already names it. */
export function PriorityGlyph({ level }: { level?: number | null | undefined }) {
  return <PriorityLevelIcon level={level ?? MIDDLE_LEVEL} width={16} height={16} />;
}

function Labelled({
  name,
  level,
  children,
}: {
  name: string;
  level?: number | undefined;
  children: ReactNode;
}) {
  return (
    <span className="ticket-icon" role="img" aria-label={name} title={name} data-level={level}>
      {children}
      {/* Shown by the stylesheet while the keyboard is on this card or row: there is no pointer to
          bring up the tooltip, and a tab stop per icon would make a large board unusable. */}
      <span className="ticket-icon-word" aria-hidden="true">
        {name}
      </span>
    </span>
  );
}

/**
 * A ticket's type as an icon (CORE-005): the name a type's `icon` holds if it is one of ours, then
 * the type's own name, then a plain shape for a custom type. The name stays as its accessible name
 * and tooltip, and shape carries it: colour does not.
 */
export function TypeIcon({ name, icon }: { name: string; icon?: string | null | undefined }) {
  return (
    <Labelled name={name}>
      <TypeGlyph name={name} icon={icon} />
    </Labelled>
  );
}

/**
 * A priority as an icon (CORE-014): the picture comes from its place in the order, which the server
 * sends as a level from 1 to 6, never from its name, so a renamed or added priority reads sensibly.
 */
export function PriorityIcon({ name, level }: { name: string; level?: number | null | undefined }) {
  const t = useT();
  return (
    <Labelled name={priorityName(t, name)} level={level ?? MIDDLE_LEVEL}>
      <PriorityGlyph level={level} />
    </Labelled>
  );
}
