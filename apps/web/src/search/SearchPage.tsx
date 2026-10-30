import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { replaceRoute } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type BasicQuery,
  basicToQuery,
  EMPTY_BASIC,
  queryToBasic,
  STAGES,
  type Stage,
} from './basic';
import { ColumnPicker } from './ColumnPicker';
import {
  type CheckResult,
  exportUrl,
  type SearchPage as Page,
  type SearchClient,
  type SearchField,
  type SearchTicket,
  searchClient,
} from './client';
import { loadColumns, saveColumns } from './columns';
import { ResultTable } from './ResultTable';
import { SavedSearchBar } from './SavedSearchBar';
import { type SavedSearch, type SavedSearchClient, savedSearchClient } from './savedClient';
import { type Suggestions, suggest } from './suggest';

export interface SearchPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: SearchClient;
  /** The query to start with (from the address, `#/search?q=`). */
  initialQuery?: string;
  /** Saved searches (M1-063); the API's by default. */
  savedClient?: SavedSearchClient;
  /** A saved search to open at once (from the address, `#/search?savedSearch=12`). */
  initialSavedSearch?: number | null;
}

type Results =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; page: Page; more: boolean; query: string }
  | { status: 'failed'; message: string };

/** The query in the address, `#/search?q=...`, or an empty one. */
export function queryFromHash(hash: string): string {
  const query = hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('q') ?? '';
}

/**
 * Searching tickets (M1-041; QRY-001): a basic mode of tracks, stages, assignment and words, and
 * an advanced mode where the query is typed with suggestions at the caret and errors shown where
 * they are. Basic choices become a query; a query within the basic mode shows as its choices.
 * The results (M1-042; QRY-014, QRY-015) show in the person's columns, edit in place and export
 * as CSV or JSON.
 */
export function SearchPage({
  client = searchClient,
  initialQuery,
  savedClient = savedSearchClient,
  initialSavedSearch = null,
}: SearchPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const start = initialQuery ?? '';
  const startBasic = start === '' ? EMPTY_BASIC : queryToBasic(start);
  const [mode, setMode] = useState<'basic' | 'advanced'>(startBasic ? 'basic' : 'advanced');
  const [basic, setBasic] = useState<BasicQuery>(startBasic ?? EMPTY_BASIC);
  const [text, setText] = useState(start || basicToQuery(EMPTY_BASIC));
  const [tooMuch, setTooMuch] = useState(false);
  const [results, setResults] = useState<Results>({ status: 'idle' });
  const [tracks, setTracks] = useState<{ key: string; name: string }[]>([]);
  const [fields, setFields] = useState<SearchField[]>([]);
  const { session } = useSession();
  const userId = session.status === 'signed-in' ? session.user.id : 0;
  const [columns, setColumns] = useState<string[]>(() => loadColumns(userId));
  const chooseColumns = (next: string[]) => {
    setColumns(next);
    saveColumns(userId, next);
  };
  const [opened, setOpened] = useState<SavedSearch | null>(null);

  useEffect(() => {
    void Promise.allSettled([client.tracks(), client.fields()]).then(([tr, fi]) => {
      if (tr.status === 'fulfilled') setTracks(tr.value);
      if (fi.status === 'fulfilled') setFields(fi.value);
    });
  }, [client]);

  const run = useCallback(
    async (query: string, cursor?: string) => {
      if (!cursor) setResults({ status: 'loading' });
      try {
        const page = await client.search(query, cursor);
        setResults((current) =>
          cursor && current.status === 'loaded'
            ? {
                status: 'loaded',
                more: page.next !== null,
                query,
                page: {
                  tickets: [...current.page.tickets, ...page.tickets],
                  next: page.next,
                  ...(current.page.total ? { total: current.page.total } : {}),
                },
              }
            : { status: 'loaded', page, more: page.next !== null, query },
        );
      } catch (error) {
        if (expired(error)) return;
        const body = error instanceof ApiError ? (error.body as { message?: string } | null) : null;
        setResults({ status: 'failed', message: body?.message ?? t('search.failed') });
      }
    },
    [client, expired, t],
  );

  /** Shows a saved search: its query in the mode that can show it, its columns, its results. */
  const openSaved = (saved: SavedSearch) => {
    setOpened(saved);
    const read = saved.query === '' ? EMPTY_BASIC : queryToBasic(saved.query);
    if (read) setBasic(read);
    setText(saved.query);
    setTooMuch(false);
    setMode(read ? 'basic' : 'advanced');
    if (saved.columns && saved.columns.length > 0) chooseColumns(saved.columns);
    replaceRoute(`#/search?savedSearch=${saved.id}`);
    void run(saved.query);
  };

  // A query from the address runs at once; so does a saved search named there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the address's query
  useEffect(() => {
    if (initialSavedSearch !== null) {
      savedClient.get(initialSavedSearch).then(openSaved, (error: unknown) => {
        if (expired(error)) return;
        setResults({ status: 'failed', message: t('saved.notFound') });
      });
    } else if (start) void run(start);
  }, []);

  const searchFor = (query: string) => {
    replaceRoute(`#/search?q=${encodeURIComponent(query)}`);
    void run(query);
  };

  const toAdvanced = () => {
    if (mode === 'basic') setText(basicToQuery(basic));
    setTooMuch(false);
    setMode('advanced');
  };
  const toBasic = () => {
    const read = queryToBasic(text);
    if (!read) {
      setTooMuch(true);
      return;
    }
    setBasic(read);
    setTooMuch(false);
    setMode('basic');
  };

  return (
    <section aria-labelledby={titleId} className="search-page">
      <h1 id={titleId} className="page-title">
        {t('search.title')}
      </h1>
      <fieldset className="search-modes">
        <legend className="visually-hidden">{t('search.mode')}</legend>
        <button
          type="button"
          className="button-secondary search-mode"
          aria-pressed={mode === 'basic'}
          onClick={toBasic}
        >
          {t('search.basic')}
        </button>
        <button
          type="button"
          className="button-secondary search-mode"
          aria-pressed={mode === 'advanced'}
          onClick={toAdvanced}
        >
          {t('search.advanced')}
        </button>
      </fieldset>
      {tooMuch && (
        <p role="alert" className="form-error">
          {t('search.tooMuch')}
        </p>
      )}
      {mode === 'basic' ? (
        <BasicForm
          basic={basic}
          tracks={tracks}
          onChange={setBasic}
          onSearch={(next) => searchFor(basicToQuery(next))}
        />
      ) : (
        <AdvancedForm
          text={text}
          client={client}
          context={{ customFields: fields.map((f) => f.name), tracks: tracks.map((tr) => tr.key) }}
          onChange={(next) => {
            setText(next);
            setTooMuch(false);
          }}
          onSearch={searchFor}
        />
      )}
      <SavedSearchBar
        client={savedClient}
        query={currentQuery()}
        columns={columns}
        opened={opened}
        onOpen={openSaved}
        onSaved={(saved) => {
          setOpened(saved);
          replaceRoute(`#/search?savedSearch=${saved.id}`);
        }}
      />
      <ResultList
        results={results}
        columns={columns}
        fields={fields}
        client={client}
        onColumns={chooseColumns}
        onSaved={(ticket) =>
          setResults((current) =>
            current.status === 'loaded'
              ? {
                  ...current,
                  page: {
                    ...current.page,
                    tickets: current.page.tickets.map((tk) =>
                      tk.id === ticket.id ? { ...tk, ...ticket } : tk,
                    ),
                  },
                }
              : current,
          )
        }
        onMore={(cursor) => void run(currentQuery(), cursor)}
      />
    </section>
  );

  function currentQuery() {
    return mode === 'basic' ? basicToQuery(basic) : text;
  }
}

function BasicForm({
  basic,
  tracks,
  onChange,
  onSearch,
}: {
  basic: BasicQuery;
  tracks: { key: string; name: string }[];
  onChange: (basic: BasicQuery) => void;
  onSearch: (basic: BasicQuery) => void;
}) {
  const t = useT();
  const id = useId();
  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((v) => v !== value);
  return (
    <form
      className="search-basic"
      aria-label={t('search.basic')}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(basic);
      }}
    >
      <fieldset className="search-choices">
        <legend>{t('search.tracks')}</legend>
        {tracks.map((track) => (
          <div key={track.key} className="form-field form-field-inline">
            <input
              id={`${id}-track-${track.key}`}
              type="checkbox"
              checked={basic.tracks.includes(track.key)}
              onChange={(event) =>
                onChange({
                  ...basic,
                  tracks: toggle(basic.tracks, track.key, event.target.checked),
                })
              }
            />
            <label htmlFor={`${id}-track-${track.key}`}>
              {t('search.trackName', { key: track.key, name: track.name })}
            </label>
          </div>
        ))}
      </fieldset>
      <fieldset className="search-choices">
        <legend>{t('search.stages')}</legend>
        {STAGES.map((stage) => (
          <div key={stage} className="form-field form-field-inline">
            <input
              id={`${id}-stage-${stage}`}
              type="checkbox"
              checked={basic.stages.includes(stage)}
              onChange={(event) =>
                onChange({
                  ...basic,
                  stages: toggle<Stage>(basic.stages, stage, event.target.checked),
                })
              }
            />
            <label htmlFor={`${id}-stage-${stage}`}>{t(`search.stage.${stage}`)}</label>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-assignee`} className="form-label">
          {t('search.assignee')}
        </label>
        <select
          id={`${id}-assignee`}
          value={basic.assignee}
          onChange={(event) =>
            onChange({ ...basic, assignee: event.target.value as BasicQuery['assignee'] })
          }
        >
          <option value="any">{t('search.assignee.any')}</option>
          <option value="me">{t('search.assignee.me')}</option>
          <option value="none">{t('search.assignee.none')}</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-text`} className="form-label">
          {t('search.text')}
        </label>
        <input
          id={`${id}-text`}
          type="search"
          value={basic.text}
          onChange={(event) => onChange({ ...basic, text: event.target.value })}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('search.run')}
        </button>
      </div>
    </form>
  );
}

function AdvancedForm({
  text,
  client,
  context,
  onChange,
  onSearch,
}: {
  text: string;
  client: SearchClient;
  context: { customFields: string[]; tracks: string[] };
  onChange: (text: string) => void;
  onSearch: (text: string) => void;
}) {
  const t = useT();
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [offer, setOffer] = useState<Suggestions | null>(null);
  const [active, setActive] = useState(0);
  const [check, setCheck] = useState<CheckResult | null>(null);
  /** Where the caret goes once an accepted suggestion is in the box. */
  const caretAfter = useRef<number | null>(null);

  // Placed as soon as the new text is committed, before the next key press: a deferred move
  // could land after keys typed straight after the accepting Tab and put the caret back.
  useLayoutEffect(() => {
    const caret = caretAfter.current;
    if (caret === null || !box.current) return;
    caretAfter.current = null;
    box.current.setSelectionRange(caret, caret);
    box.current.focus();
  });

  // The backend checks the query as it is typed: fields, operators, values (QRY-001 (2)).
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      client.check(text).then(
        (result) => live && setCheck(result),
        () => live && setCheck(null),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, text]);

  const refresh = (value: string, caret: number) => {
    setOffer(suggest(value, caret, context));
    setActive(0);
  };
  const accept = (item: string) => {
    if (!offer) return;
    const next = `${text.slice(0, offer.from)}${item} ${text.slice(offer.to)}`;
    const caret = offer.from + item.length + 1;
    caretAfter.current = caret;
    onChange(next);
    setOffer(null);
  };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    setOffer(null);
    onSearch(text);
  };

  const error = check && !check.ok ? check.error : null;
  const listId = `${id}-suggestions`;
  const errorId = `${id}-error`;
  const open = offer !== null && offer.items.length > 0;
  return (
    <form className="search-advanced" aria-label={t('search.advanced')} onSubmit={submit}>
      <div className="form-field search-editor">
        <label htmlFor={`${id}-query`} className="form-label">
          {t('search.query')}
        </label>
        <textarea
          ref={box}
          id={`${id}-query`}
          className="search-query"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          {...(open ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
            refresh(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => refresh(text, event.currentTarget.selectionStart)}
          onBlur={() => window.setTimeout(() => setOffer(null), 150)}
          onKeyDown={(event) => {
            if (open && offer) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((i) => Math.min(offer.items.length - 1, i + 1));
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((i) => Math.max(0, i - 1));
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                const item = offer.items[active];
                if (item) {
                  event.preventDefault();
                  accept(item);
                  return;
                }
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setOffer(null);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === ' ' && event.ctrlKey) {
              event.preventDefault();
              refresh(text, event.currentTarget.selectionStart);
            }
          }}
        />
        <div
          id={listId}
          role="listbox"
          aria-label={t('search.suggestions')}
          className={open ? 'search-suggestions' : 'search-suggestions is-empty'}
        >
          {open &&
            offer.items.map((item, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox
              <div
                key={item}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                className={index === active ? 'search-suggestion is-active' : 'search-suggestion'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => accept(item)}
              >
                {item}
              </div>
            ))}
        </div>
        <p className="form-hint">{t('search.hint')}</p>
        {error && (
          <p id={errorId} role="alert" className="form-error">
            {t('search.errorAt', {
              message: error.message,
              column: error.position + 1,
              near: text.slice(error.position, error.position + Math.max(1, error.length)) || '…',
            })}
          </p>
        )}
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('search.run')}
        </button>
      </div>
    </form>
  );
}

function ResultList({
  results,
  columns,
  fields,
  client,
  onColumns,
  onSaved,
  onMore,
}: {
  results: Results;
  columns: string[];
  fields: SearchField[];
  client: SearchClient;
  onColumns: (columns: string[]) => void;
  onSaved: (ticket: SearchTicket) => void;
  onMore: (cursor: string) => void;
}) {
  const t = useT();
  const headingId = useId();
  if (results.status === 'idle') return null;
  return (
    <section aria-labelledby={headingId} className="search-results">
      <h2 id={headingId} className="facts-title">
        {t('search.results')}
      </h2>
      {results.status === 'loading' && (
        <p role="status" className="page-note">
          {t('search.loading')}
        </p>
      )}
      {results.status === 'failed' && (
        <p role="alert" className="form-error">
          {results.message}
        </p>
      )}
      {results.status === 'loaded' && (
        <>
          <div className="search-results-bar">
            <p role="status" className="page-note">
              {results.page.total
                ? t(
                    results.page.total.exact
                      ? 'search.count'
                      : results.page.total.approximate
                        ? 'search.countAbout'
                        : 'search.countAtLeast',
                    { count: results.page.total.count },
                  )
                : t('search.shown', { count: results.page.tickets.length })}
            </p>
            <ColumnPicker columns={columns} fields={fields} onChange={onColumns} />
            {results.page.tickets.length > 0 && (
              <nav className="search-export" aria-label={t('search.export')}>
                <a
                  className="button-secondary search-export-link"
                  href={exportUrl(results.query, 'csv', columns)}
                  download
                >
                  {t('search.export.csv')}
                </a>
                <a
                  className="button-secondary search-export-link"
                  href={exportUrl(results.query, 'json', columns)}
                  download
                >
                  {t('search.export.json')}
                </a>
              </nav>
            )}
          </div>
          {results.page.tickets.length > 0 && (
            <ResultTable
              tickets={results.page.tickets}
              columns={columns}
              fields={fields}
              client={client}
              onSaved={onSaved}
            />
          )}
          {results.more && results.page.next && (
            <button
              type="button"
              className="button-secondary"
              onClick={() => onMore(results.page.next as string)}
            >
              {t('search.more')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
