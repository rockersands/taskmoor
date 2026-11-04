import { api } from '../api/client';
import { sectionById, type TutorialSectionId } from './sections';

/** A section's saved place (ADR-115); a section with none has not been started. */
export interface SectionProgress {
  section: TutorialSectionId;
  state: 'active' | 'done' | 'skipped';
  step: number;
}

/**
 * The person's place in the tutorial, as `GET /api/v1/account/tutorial` answers: whether the
 * first-run offer was answered (`shown` after Start or Not now, `dismissed` after Don't offer
 * again, null before), and each section they started.
 */
export interface TutorialProgress {
  offer: 'shown' | 'dismissed' | null;
  sections: SectionProgress[];
}

export interface TutorialClient {
  progress: () => Promise<TutorialProgress>;
  save: (
    section: TutorialSectionId,
    state: SectionProgress['state'],
    step: number,
  ) => Promise<void>;
  answerOffer: (answer: 'shown' | 'dismissed') => Promise<void>;
}

const STATES = new Set(['active', 'done', 'skipped']);

/**
 * Reads only what it understands. An answer of another shape (an older backend, a stand-in in a
 * test) throws, so nothing is offered on a guess.
 */
export function readProgress(body: unknown): TutorialProgress {
  const answer = body as { offer?: unknown; sections?: unknown } | null;
  const offer = answer?.offer;
  if (!(offer === null || offer === 'shown' || offer === 'dismissed')) {
    throw new Error('unexpected tutorial progress');
  }
  if (!Array.isArray(answer?.sections)) throw new Error('unexpected tutorial progress');
  const sections = answer.sections.flatMap((row: unknown) => {
    const r = row as { section?: unknown; state?: unknown; step?: unknown };
    const known = typeof r.section === 'string' ? sectionById(r.section) : undefined;
    if (!known || typeof r.state !== 'string' || !STATES.has(r.state)) return [];
    const step = typeof r.step === 'number' && r.step >= 0 ? Math.floor(r.step) : 0;
    return [{ section: known.id, state: r.state as SectionProgress['state'], step }];
  });
  return { offer, sections };
}

export const tutorialClient: TutorialClient = {
  progress: async () => readProgress(await api<unknown>('/account/tutorial')),
  save: async (section, state, step) => {
    await api(`/account/tutorial/${section}`, { method: 'PUT', body: { state, step } });
  },
  answerOffer: async (answer) => {
    await api('/account/tutorial/offer', { method: 'PUT', body: { state: answer } });
  },
};
