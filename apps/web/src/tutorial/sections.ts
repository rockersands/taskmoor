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

/**
 * The sections of the guided tutorial (ADR-112), in the order they are offered. Each makes one
 * real thing in the person's own instance; `admin` sections need a site administrator.
 */
export const TUTORIAL_SECTIONS = [
  {
    id: 'tracks',
    titleId: 'tutorial.section.tracks',
    hintId: 'tutorial.section.tracksHint',
    minutes: 5,
    admin: false,
    icon: TracksIcon,
  },
  {
    id: 'workflows',
    titleId: 'tutorial.section.workflows',
    hintId: 'tutorial.section.workflowsHint',
    minutes: 6,
    admin: true,
    icon: FlowIcon,
  },
  {
    id: 'boards',
    titleId: 'tutorial.section.boards',
    hintId: 'tutorial.section.boardsHint',
    minutes: 6,
    admin: false,
    icon: BoardsIcon,
  },
  {
    id: 'search',
    titleId: 'tutorial.section.search',
    hintId: 'tutorial.section.searchHint',
    minutes: 4,
    admin: false,
    icon: SearchIcon,
  },
  {
    id: 'dashboards',
    titleId: 'tutorial.section.dashboards',
    hintId: 'tutorial.section.dashboardsHint',
    minutes: 4,
    admin: false,
    icon: DashboardsIcon,
  },
  {
    id: 'releases',
    titleId: 'tutorial.section.releases',
    hintId: 'tutorial.section.releasesHint',
    minutes: 3,
    admin: false,
    icon: ReleaseIcon,
  },
  {
    id: 'admin',
    titleId: 'tutorial.section.admin',
    hintId: 'tutorial.section.adminHint',
    minutes: 5,
    admin: true,
    icon: SettingsIcon,
  },
  {
    id: 'import',
    titleId: 'tutorial.section.import',
    hintId: 'tutorial.section.importHint',
    minutes: 5,
    admin: true,
    icon: ImportIcon,
  },
] as const satisfies readonly {
  id: string;
  titleId: MessageId;
  hintId: MessageId;
  minutes: number;
  admin: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}[];

export type TutorialSectionId = (typeof TUTORIAL_SECTIONS)[number]['id'];
export type TutorialStatus = 'new' | 'active' | 'done' | 'skipped';
