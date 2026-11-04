import type { TutorialClient, TutorialProgress } from './client';

/** Synthetic progress for stories: one section done, one halfway, one skipped (ADR-115). */
export const SOME_PROGRESS: TutorialProgress = {
  offer: 'dismissed',
  sections: [
    { section: 'tracks', state: 'done', step: 9 },
    { section: 'dashboards', state: 'active', step: 3 },
    { section: 'search', state: 'skipped', step: 1 },
  ],
};

/** A backend for stories that answers with the given progress and accepts every save. */
export function fakeTutorialClient(
  progress: TutorialProgress = { offer: null, sections: [] },
): TutorialClient {
  return {
    progress: async () => progress,
    save: async () => {},
    answerOffer: async () => {},
  };
}
