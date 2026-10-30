import type { TrackType } from '@taskmoor/db';
import { FEATURE_DEFAULTS, TRACK_FEATURES, type TrackFeature, type TrackFeatures } from './model';

/**
 * Track templates (M1-054; CORE-002 (1); ADR-062): what a new track starts with. A template
 * chooses the track's type and feature toggles, and the board it gets in its own space: Scrum
 * and Kanban boards over every ticket of the track, Bug tracking a Kanban board of its bugs,
 * Business a Kanban board of its tickets, Blank none. The configuration sets are the type's
 * defaults, as for any new track; everything stays changeable afterwards.
 */
export const TRACK_TEMPLATES = ['scrum', 'kanban', 'bug-tracking', 'business', 'blank'] as const;
export type TrackTemplate = (typeof TRACK_TEMPLATES)[number];

export interface TemplateRecipe {
  type: TrackType;
  features: TrackFeatures;
  /** The board made in the track, over the track's tickets or some of them; null for none. */
  board: { kind: 'scrum' | 'kanban'; query: (key: string) => string } | null;
}

const without = (base: TrackFeatures, ...off: TrackFeature[]): TrackFeatures =>
  Object.fromEntries(TRACK_FEATURES.map((f) => [f, base[f] && !off.includes(f)])) as TrackFeatures;

const everything = (key: string) => `track = ${key}`;

export const TEMPLATE_RECIPES: Record<TrackTemplate, TemplateRecipe> = {
  scrum: {
    type: 'software',
    features: FEATURE_DEFAULTS.software,
    board: { kind: 'scrum', query: everything },
  },
  kanban: {
    type: 'software',
    features: without(FEATURE_DEFAULTS.software, 'backlog', 'sprints'),
    board: { kind: 'kanban', query: everything },
  },
  'bug-tracking': {
    type: 'software',
    features: without(FEATURE_DEFAULTS.software, 'backlog', 'sprints', 'forms', 'timeline'),
    board: { kind: 'kanban', query: (key) => `track = ${key} AND type = Bug` },
  },
  business: {
    type: 'business',
    features: FEATURE_DEFAULTS.business,
    board: { kind: 'kanban', query: everything },
  },
  blank: { type: 'software', features: FEATURE_DEFAULTS.software, board: null },
};
