import type { SVGProps } from 'react';

// Original line icons on a 24px grid. Stroke colour follows the text colour.
export type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />
  </Icon>
);

export const TracksIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);

export const BoardsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="5" height="16" rx="1.2" />
    <rect x="9.5" y="4" width="5" height="11" rx="1.2" />
    <rect x="15.5" y="4" width="5" height="7" rx="1.2" />
  </Icon>
);

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13.5 6.2 6.3A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.3L20 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5.5 5.5" />
  </Icon>
);

export const DashboardsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7.5" height="9" rx="1.2" />
    <rect x="13" y="3.5" width="7.5" height="5" rx="1.2" />
    <rect x="13" y="10.5" width="7.5" height="10" rx="1.2" />
    <rect x="3.5" y="14.5" width="7.5" height="6" rx="1.2" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Icon>
);

export const AdministrationIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Icon>
);

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const EyeOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 5.6a9.7 9.7 0 0 1 1.4-.1c6 0 9.5 6.5 9.5 6.5a16.8 16.8 0 0 1-2.9 3.7M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3.5 3.5 17 17" />
  </Icon>
);

export const HelpIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" />
    <path d="M12 17h.01" />
  </Icon>
);

export const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </Icon>
);

export const MoonIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

/** A map with a route on it: the guided tour. */
export const TourIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5 9 4l6 2.5L20 4v13.5L15 20l-6-2.5L4 20z" />
    <path d="M9 4v13.5M15 6.5V20" />
  </Icon>
);

export const TicketIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="5" width="16" height="14" rx="3" />
    <path d="M8 10h8M8 14h5" />
  </Icon>
);

/** Ticket types: a flag for a result to reach. */
export const OutcomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 21V4" />
    <path d="M6 5h11l-2.5 4L17 13H6" />
  </Icon>
);

/** Ticket types: a spark, something new. */
export const FeatureIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z" />
  </Icon>
);

/** Ticket types: a beetle seen from above. */
export const BugIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="8" width="8" height="12" rx="4" />
    <path d="M12 8v12M9 5.5 10.5 8M15 5.5 13.5 8M8 11.5H4.5M8 15H4M8.5 18.5l-3 2M16 11.5h3.5M16 15h4M15.5 18.5l3 2" />
  </Icon>
);

/** Ticket types: a spanner, work that keeps things running. */
export const ChoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.5 4.5a4.5 4.5 0 0 0-5.6 5.9L4.2 16a2.1 2.1 0 0 0 3 3l5.7-5.6a4.5 4.5 0 0 0 5.9-5.6l-2.9 2.9-2.8-.7-.7-2.8z" />
  </Icon>
);

/** Ticket types: a round tick, a piece of work to get done. */
export const ToDoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.2 12.3 2.6 2.6 5-5.4" />
  </Icon>
);

/** Ticket types: a light bulb. */
export const IdeaIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 21h5" />
    <path d="M12 3a6.2 6.2 0 0 0-3.8 11.1c.6.5.8 1 .8 1.7v1.7h6v-1.7c0-.7.2-1.2.8-1.7A6.2 6.2 0 0 0 12 3z" />
  </Icon>
);

/** Ticket types: a line stepping down and along from its parent. */
export const SubticketIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4v9a3 3 0 0 0 3 3h9" />
    <path d="m14.5 12.5 3.5 3.5-3.5 3.5" />
  </Icon>
);

/** Ticket types: a plain hexagon, for a type with no icon of ours. */
export const CustomTypeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8z" />
  </Icon>
);

/** Heights of the rising bars of a priority, shortest first. */
const PRIORITY_BARS = [6, 10, 14, 18];
const PRIORITY_STUB = 2.5;

/**
 * A priority's six levels by shape alone. Level 1 is a solid diamond with an exclamation mark; 2 to
 * 5 are four rising bars with fewer of them standing (4, 3, 2, 1), the rest down to a stub; level 6
 * is all stubs. They read as a meter, and read in black and white.
 */
export const PriorityLevelIcon = ({ level, ...p }: IconProps & { level: number }) =>
  level <= 1 ? (
    <Icon {...p} fill="currentColor" stroke="none">
      <path
        fillRule="evenodd"
        d="M12 2.5 21.5 12 12 21.5 2.5 12ZM10.9 7v6.5h2.2V7ZM12 15a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z"
      />
    </Icon>
  ) : (
    <Icon {...p} fill="currentColor" stroke="none">
      {PRIORITY_BARS.map((height, i) => {
        const standing = i < 6 - level;
        const h = standing ? height : PRIORITY_STUB;
        return <rect key={height} x={3 + i * 5} y={21 - h} width="3" height={h} rx="1" />;
      })}
    </Icon>
  );

/** A dial: how long something has waited. */
export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

/** Nobody yet: the outline of a person's place, dashed. */
export const NobodyIcon = (p: IconProps) => (
  <Icon {...p} strokeDasharray="3 3">
    <circle cx="12" cy="12" r="9" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const MoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="12" r="1.3" fill="currentColor" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" />
    <circle cx="18" cy="12" r="1.3" fill="currentColor" />
  </Icon>
);

/** Three states joined by arrows: a workflow. */
export const FlowIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="7" r="2.5" />
    <circle cx="18.5" cy="7" r="2.5" />
    <circle cx="12" cy="18" r="2.5" />
    <path d="M8 7h8M17.2 9.2l-3.8 6.6M6.8 9.2l3.8 6.6" />
  </Icon>
);

/** A flag on a pole: a release. */
export const ReleaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 21V4M6 4h10.5l-2 3.5 2 3.5H6" />
  </Icon>
);

/** A tray with an arrow coming in: import. */
export const ImportIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5v10M8 9.5l4 4 4-4" />
    <path d="M4 14.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </Icon>
);
