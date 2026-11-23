import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { messagesEn as messages } from '../i18n/messages.en';
import {
  DEFINITION_PROBLEMS,
  definitionProblemMessage,
  namesFor,
  refusalMessage,
} from './describe';
import { STATUSES, SUPPORT_DEFINITION } from './fixtures';

// The catalogue's English text with arguments filled in, enough to tell messages apart.
const t: Translate = (id, values = {}) =>
  messages[id].replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
const names = namesFor(t, STATUSES, SUPPORT_DEFINITION);

describe('the editor words server refusals (M1-030)', () => {
  it('[WF-002] gives every definition problem its own sentence, naming what it is about', () => {
    const detail = { transitionId: 3, statusId: 99, field: 'mood', pattern: '([' };
    const sentences = Object.keys(DEFINITION_PROBLEMS).map((problem) =>
      definitionProblemMessage(t, { problem, ...detail }, names),
    );
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(sentences).not.toContain(messages['workflow.problem.refused']);
    expect(
      definitionProblemMessage(
        t,
        { problem: 'unknown_field', transitionId: 3, field: 'mood' },
        names,
      ),
    ).toBe('Approve: there is no field named mood.');
    expect(definitionProblemMessage(t, { problem: 'unknown_status', statusId: 99 }, names)).toBe(
      'Status 99 no longer exists on the site.',
    );
    expect(definitionProblemMessage(t, { problem: 'toString' }, names)).toBe(
      messages['workflow.problem.refused'],
    );
  });

  it('[WF-002] explains refused publishes and restores', () => {
    const refused = (body: unknown) => refusalMessage(t, new ApiError(409, body), names, 1);
    expect(refused({ error: 'status_mapping_required', statuses: [] })).toBe(
      messages['workflow.problem.mappingRequired'],
    );
    expect(
      refused({ error: 'cannot_restore', detail: { problem: 'unknown_status', statusId: 7 } }),
    ).toBe('Version 1 cannot be restored: Status 7 no longer exists on the site.');
    expect(
      refused({
        error: 'cannot_restore',
        detail: { problem: 'unknown_close_reason', transitionId: null, reasonId: 3 },
      }),
    ).toBe(
      `Version 1 cannot be restored: ${messages['workflow.problem.onCreate']}: the close reason it sets no longer exists.`,
    );
    expect(
      refusalMessage(
        t,
        new ApiError(400, {
          error: 'invalid_request',
          detail: { statusMapping: 4, problem: 'not_in_workflow' },
        }),
        names,
      ),
    ).toBe(messages['workflow.problem.badMapping']);
    expect(refused({ error: 'something_else' })).toBeNull();
    expect(refusalMessage(t, new Error('network'), names)).toBeNull();
  });

  it('[WF-008] explains a publish free moves cannot give any move, with the fixes that work (T-260)', () => {
    const said = refusalMessage(
      t,
      new ApiError(400, { error: 'invalid_request', detail: { problem: 'no_moves' } }),
      names,
    );
    expect(said).toBe(messages['workflow.problem.no_moves']);
    // A close reason named Completed, the default workflow, a status outside the closed stage,
    // or the transitions drawn by hand: never just "add a close reason".
    for (const fix of [
      'a close reason named Completed',
      'the default workflow set a reason',
      'a status outside the closed stage',
      'draw the transitions yourself',
    ]) {
      expect(said).toContain(fix);
    }
  });
});
