import { useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { priorityName } from '../shell/priorityName';
import { typeName } from '../shell/seededNames';
import { AiFeature, type AiFeatures } from './AiFeature';
import { type AiNoticeClient, aiNoticeClient, aiRefusalMessage } from './AiNotice';
import { type AiClient, aiClient, type TicketDraft } from './client';
import { useFirstUse } from './FirstUse';

export interface DraftFromTextProps {
  /** The track the ticket is being created in (its key), and its id for the feature switch. */
  track: string;
  trackId?: number;
  /** Fills the create form with a draft; the person still reviews it and presses Create. */
  onUse: (draft: TicketDraft) => void;
  client?: AiClient;
  notice?: AiNoticeClient;
  features?: (trackId?: number) => Promise<AiFeatures>;
}

/**
 * Drafting a ticket from pasted text in the create dialog (M1-079; AI-015): the model proposes
 * one or more tickets; choosing one fills the form, and nothing is created until the person
 * submits it (AI-015 (2)). Shown only where the feature is available.
 */
export function DraftFromText({
  track,
  trackId,
  onUse,
  client = aiClient,
  notice = aiNoticeClient,
  features,
}: DraftFromTextProps) {
  return (
    <AiFeature
      feature="assisted-creation"
      {...(trackId !== undefined ? { trackId } : {})}
      {...(features ? { load: features } : {})}
    >
      <DraftBody track={track} onUse={onUse} client={client} notice={notice} />
    </AiFeature>
  );
}

function DraftBody({
  track,
  onUse,
  client,
  notice,
}: {
  track: string;
  onUse: (draft: TicketDraft) => void;
  client: AiClient;
  notice: AiNoticeClient;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<TicketDraft[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const firstUse = useFirstUse(notice);

  const draft = async () => {
    setBusy(true);
    setProblem(null);
    setDrafts(null);
    try {
      const found = await client.drafts(track, text.trim());
      setDrafts(found);
      if (found.length === 0) setProblem(t('ai.draft.none'));
    } catch (error) {
      setProblem(
        aiRefusalMessage(error instanceof ApiError ? error.body : null, t, (iso) =>
          intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="ai-draft">
        <button type="button" className="button-secondary" onClick={() => setOpen(true)}>
          {t('ai.draft.open')}
        </button>
      </div>
    );
  }
  return (
    <section aria-labelledby={`${id}-title`} className="ai-panel ai-draft">
      <h3 id={`${id}-title`} className="facts-title">
        {t('ai.draft.title')}
      </h3>
      <div className="form-field">
        <label htmlFor={`${id}-text`} className="form-label">
          {t('ai.draft.text')}
        </label>
        <textarea
          id={`${id}-text`}
          rows={5}
          value={text}
          maxLength={20_000}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="form-hint">{t('ai.draft.hint')}</p>
      </div>
      <div className="ai-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={busy || !text.trim()}
          onClick={() => firstUse.run(() => void draft())}
        >
          {busy ? t('ai.draft.drafting') : t('ai.draft.submit')}
        </button>
        <button type="button" className="button-secondary" onClick={() => setOpen(false)}>
          {t('ai.draft.close')}
        </button>
      </div>
      {firstUse.gate}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {drafts && drafts.length > 0 && (
        <ul className="ai-proposals" aria-label={t('ai.draft.list')}>
          {drafts.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: proposals have no id
            <li key={i} className="ai-proposal">
              <p className="ai-proposal-summary">{d.summary}</p>
              <p className="form-hint">
                {[
                  d.ticketType && typeName(t, d.ticketType.name),
                  d.priority && priorityName(t, d.priority.name),
                  ...d.labels,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <button
                type="button"
                className="button-secondary"
                aria-label={t('ai.draft.useNamed', { summary: d.summary })}
                onClick={() => {
                  onUse(d);
                  setOpen(false);
                  setDrafts(null);
                }}
              >
                {t('ai.draft.use')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
