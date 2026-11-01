import { type FormEvent, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { AiFeature, type AiFeatures } from './AiFeature';
import { type AiNoticeClient, aiNoticeClient, aiRefusalMessage } from './AiNotice';
import { type AiClient, aiClient, type GeneratedQuery } from './client';
import { useFirstUse } from './FirstUse';

export interface AskQueryProps {
  /** Runs the query the person chose, as the search page runs a typed one. */
  onRun: (query: string) => void;
  client?: AiClient;
  notice?: AiNoticeClient;
  features?: (trackId?: number) => Promise<AiFeatures>;
}

/**
 * Asking in plain language on the search page (M1-079; AI-014): the question, in any language,
 * becomes a query shown in an editable field with what it means, and runs only when the person
 * presses Run. A query the server could not parse says why, and runs only once edited (the
 * search then checks it like any typed query). Shown only where the feature is available.
 */
export function AskQuery({
  onRun,
  client = aiClient,
  notice = aiNoticeClient,
  features,
}: AskQueryProps) {
  return (
    <AiFeature feature="query-from-text" {...(features ? { load: features } : {})}>
      <AskBody onRun={onRun} client={client} notice={notice} />
    </AiFeature>
  );
}

function AskBody({
  onRun,
  client,
  notice,
}: {
  onRun: (query: string) => void;
  client: AiClient;
  notice: AiNoticeClient;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<GeneratedQuery | null>(null);
  const [query, setQuery] = useState('');
  const [edited, setEdited] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const firstUse = useFirstUse(notice);

  const ask = async (text: string) => {
    setBusy(true);
    setProblem(null);
    setAnswer(null);
    try {
      const found = await client.query(text);
      setAnswer(found);
      setQuery(found.query);
      setEdited(false);
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    firstUse.run(() => void ask(text));
  };

  const runnable = query.trim() !== '' && (answer?.valid === true || edited);
  return (
    <section aria-labelledby={`${id}-title`} className="ai-panel ai-ask">
      <h2 id={`${id}-title`} className="facts-title">
        {t('ai.ask.title')}
      </h2>
      <form className="ai-ask-form" onSubmit={submit}>
        <div className="form-field">
          <label htmlFor={`${id}-question`} className="form-label">
            {t('ai.ask.question')}
          </label>
          <input
            id={`${id}-question`}
            type="text"
            value={question}
            maxLength={2000}
            placeholder={t('ai.ask.placeholder')}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
        <button type="submit" className="button-secondary" disabled={busy || !question.trim()}>
          {busy ? t('ai.ask.asking') : t('ai.ask.submit')}
        </button>
      </form>
      {firstUse.gate}
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {answer && (
        <div className="ai-ask-answer">
          <div className="form-field">
            <label htmlFor={`${id}-query`} className="form-label">
              {t('ai.ask.query')}
            </label>
            <textarea
              id={`${id}-query`}
              className="search-query"
              rows={3}
              value={query}
              spellCheck={false}
              aria-describedby={`${id}-explanation`}
              onChange={(e) => {
                setQuery(e.target.value);
                setEdited(true);
              }}
            />
          </div>
          <p id={`${id}-explanation`} className="form-hint">
            {answer.explanation}
          </p>
          {!answer.valid && !edited && (
            <p role="alert" className="form-error">
              {t('ai.ask.invalid', { message: answer.problem?.message ?? '' })}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="button-primary"
              disabled={!runnable}
              onClick={() => onRun(query.trim())}
            >
              {t('ai.ask.run')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
