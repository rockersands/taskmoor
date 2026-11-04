import type { ComponentType, SVGProps } from 'react';
import type { MessageId } from '../i18n/messages.en';
import {
  BoardsIcon,
  DashboardsIcon,
  FlowIcon,
  ImportIcon,
  ReleaseIcon,
  SearchIcon,
  SettingsIcon,
  TracksIcon,
} from '../shell/icons';
import { newTrackModes } from '../tracks/trackAccess';

/**
 * Who a section is offered to (ADR-115): everyone, those who may change shared configuration
 * (site and configuration administrators, who may edit workflows), or site administrators only.
 * The web app offers; the server still decides each change.
 */
export type TutorialAudienceLevel = 'everyone' | 'setup' | 'site';

/**
 * The sections of the guided tutorial (ADR-115), in the order they are offered. Each makes one
 * real thing in the person's own instance.
 */
export const TUTORIAL_SECTIONS = [
  {
    id: 'tracks',
    titleId: 'tutorial.section.tracks',
    hintId: 'tutorial.section.tracksHint',
    minutes: 5,
    who: 'everyone',
    icon: TracksIcon,
  },
  {
    id: 'workflows',
    titleId: 'tutorial.section.workflows',
    hintId: 'tutorial.section.workflowsHint',
    minutes: 6,
    who: 'setup',
    icon: FlowIcon,
  },
  {
    id: 'boards',
    titleId: 'tutorial.section.boards',
    hintId: 'tutorial.section.boardsHint',
    minutes: 6,
    who: 'everyone',
    icon: BoardsIcon,
  },
  {
    id: 'search',
    titleId: 'tutorial.section.search',
    hintId: 'tutorial.section.searchHint',
    minutes: 4,
    who: 'everyone',
    icon: SearchIcon,
  },
  {
    id: 'dashboards',
    titleId: 'tutorial.section.dashboards',
    hintId: 'tutorial.section.dashboardsHint',
    minutes: 4,
    who: 'everyone',
    icon: DashboardsIcon,
  },
  {
    id: 'releases',
    titleId: 'tutorial.section.releases',
    hintId: 'tutorial.section.releasesHint',
    minutes: 3,
    who: 'everyone',
    icon: ReleaseIcon,
  },
  {
    id: 'admin',
    titleId: 'tutorial.section.admin',
    hintId: 'tutorial.section.adminHint',
    minutes: 5,
    who: 'site',
    icon: SettingsIcon,
  },
  {
    id: 'import',
    titleId: 'tutorial.section.import',
    hintId: 'tutorial.section.importHint',
    minutes: 5,
    who: 'site',
    icon: ImportIcon,
  },
] as const satisfies readonly {
  id: string;
  titleId: MessageId;
  hintId: MessageId;
  minutes: number;
  who: TutorialAudienceLevel;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[];

export type TutorialSection = (typeof TUTORIAL_SECTIONS)[number];
export type TutorialSectionId = TutorialSection['id'];
export type TutorialStatus = 'new' | 'active' | 'done' | 'skipped';

/** What the tutorial knows of the person, to offer sections and steps they can do. */
export interface TutorialAudience {
  siteAdmin: boolean;
  /** May change shared configuration: workflows, maps and sets. */
  setupAdmin: boolean;
  /** May make a track (CORE-001): the tracks section starts by making one. */
  makesTracks: boolean;
}

export const NOBODY: TutorialAudience = { siteAdmin: false, setupAdmin: false, makesTracks: false };

export function audienceOf(
  user: {
    isSiteAdmin: boolean;
    isConfigAdmin?: boolean | undefined;
    mayCreateLocalTracks?: boolean | undefined;
  } | null,
): TutorialAudience {
  if (!user) return NOBODY;
  const isConfigAdmin = user.isConfigAdmin === true;
  return {
    siteAdmin: user.isSiteAdmin,
    setupAdmin: user.isSiteAdmin || isConfigAdmin,
    makesTracks:
      newTrackModes({
        isSiteAdmin: user.isSiteAdmin,
        isConfigAdmin,
        mayCreateLocalTracks: user.mayCreateLocalTracks === true,
      }).length > 0,
  };
}

export function mayTake(section: TutorialSection, audience: TutorialAudience): boolean {
  if (section.who === 'site') return audience.siteAdmin;
  if (section.who === 'setup') return audience.setupAdmin;
  return true;
}

/** The sections this person is offered, in order. */
export function sectionsFor(audience: TutorialAudience): TutorialSection[] {
  return TUTORIAL_SECTIONS.filter((section) => mayTake(section, audience));
}

export function sectionById(id: string): TutorialSection | undefined {
  return TUTORIAL_SECTIONS.find((section) => section.id === id);
}

/** Ticked in the first-run offer to begin with: the everyday work, short enough for a first go. */
export const SUGGESTED: readonly TutorialSectionId[] = ['tracks', 'boards', 'search'];
