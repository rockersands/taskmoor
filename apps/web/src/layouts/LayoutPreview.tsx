import { useEffect, useId, useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { EmptyState } from '../shell/EmptyState';
import type { LayoutsClient, Named, Preview, PreviewField, TrackLists } from './client';
import { setAtCreate } from './createForm';
import { type DraftSet, entriesOf, type FormChoice } from './model';
import { layoutRefusal } from './refusal';

export interface LayoutPreviewProps {
  client: LayoutsClient;
  setId: number;
  drafts: DraftSet;
  /** The form being edited: its operation is previewed, and its type when it names one. */
  form: FormChoice;
  types: Named[];
  /** The tracks the preview may borrow fields and rules from: those using the set. */
  tracks: { id: number; key: string; name: string }[];
  /** A local-mode track's own set: that track, where the preview starts. */
  ownerTrackId: number | null;
  /**
   * A track's own page (T-163a): the preview uses that track's fields and rules and no other,
   * and offers no choice of track.
   */
  fixedTrack?: { id: number; key: string; name: string } | null;
  fieldName: (key: string) => string;
  /** A custom field's name when the page knows it, for saying why the server refuses a draft. */
  knownName?: (key: string) => string | undefined;
  /** How long typing settles before the server is asked, in milliseconds. */
  delay?: number;
}

type State =
  | { status: 'loading'; last: Preview | null }
  | { status: 'ready'; preview: Preview }
  | { status: 'refused'; answer: unknown; last: Preview | null }
  | { status: 'failed'; last: Preview | null };

/** Why a placed field is not on the form: the server's reasons, and the create form's own. */
type LeftOutReason =
  | Preview['leftOut'][number]['reason']
  | 'after_create'
  | 'no_releases'
  | 'no_areas';

const REASONS: Record<LeftOutReason, MessageId> = {
  hidden: 'layouts.preview.reason.hidden',
  not_applicable: 'layouts.preview.reason.notApplicable',
  computed: 'layouts.preview.reason.computed',
  after_create: 'layouts.preview.reason.afterCreate',
  no_releases: 'layouts.preview.reason.noReleases',
  no_areas: 'layouts.preview.reason.noAreas',
};

/** A list of the track's own that a field picks from. */
type ListKind = 'release' | 'area';

/**
 * Optional fields the create form leaves out when the track has nothing to offer in them
 * (`CreateTicketPage`'s `listKindOf`): the built-in release and area fields, and custom fields of
 * type release or area.
 */
function listKindOf(key: string, customFields: Preview['customFields']): ListKind | null {
  const custom = /^cf\[(\d+)\]$/.exec(key)?.[1];
  if (custom) {
    const type = customFields.find((f) => f.id === Number(custom))?.type;
    return type === 'release' || type === 'area' ? type : null;
  }
  if (key === 'area') return 'area';
  return key === 'targetRelease' || key === 'foundInRelease' ? 'release' : null;
}

/** Without a track's lists, the preview says under such a row that it may go. */
const ONLY_WHEN_LISTED: Record<ListKind, MessageId> = {
  release: 'layouts.preview.onlyWithReleases',
  area: 'layouts.preview.onlyWithAreas',
};

type Shown = Omit<Preview, 'leftOut'> & { leftOut: { field: string; reason: LeftOutReason }[] };

/**
 * The create form as people get it: a field set only once the ticket exists goes, unless it is
 * required (the form then says why it cannot set it); so does an optional list of the track's
 * releases or areas when the track has none, once its lists are known. One the layout placed is
 * said under the form; one in the tab of the rest (a tab with no name) was not placed, so it just
 * goes.
 */
function asCreated(preview: Preview, lists: TrackLists | null): Shown {
  const gone: { field: string; reason: LeftOutReason }[] = [];
  const why = (field: PreviewField): LeftOutReason | null => {
    if (field.required) return null;
    if (!setAtCreate(field.key)) return 'after_create';
    const kind = lists ? listKindOf(field.key, preview.customFields) : null;
    if (kind === 'release' && lists?.releases === 0) return 'no_releases';
    if (kind === 'area' && lists?.areas === 0) return 'no_areas';
    return null;
  };
  const tabs = preview.layout.tabs.map((tab) => ({
    ...tab,
    sections: tab.sections.map((section) => ({
      ...section,
      fields: section.fields.filter((field) => {
        const reason = why(field);
        if (reason && tab.name !== null) gone.push({ field: field.key, reason });
        return reason === null;
      }),
    })),
  }));
  return {
    ...preview,
    layout: { ...preview.layout, tabs },
    leftOut: [...preview.leftOut, ...gone],
  };
}

/**
 * The live preview of the layout editor (UI-T15; ADR-114 section 8; CORE-008, CORE-013): the form
 * the draft gives for a ticket type and operation, as the server works it out with the field rules
 * of a track, or the default rules with no track. The server checks the draft as a save would and
 * says why it would refuse one; the preview keeps the last good form meanwhile.
 */
export function LayoutPreview({
  client,
  setId,
  drafts,
  form,
  types,
  tracks,
  ownerTrackId,
  fixedTrack = null,
  fieldName,
  knownName = () => undefined,
  delay = 250,
}: LayoutPreviewProps) {
  const t = useT();
  const id = useId();
  const expired = useSessionExpiry();
  const [chosenType, setChosenType] = useState<number | null>(types[0]?.id ?? null);
  const [chosenTrack, setChosenTrack] = useState<number | null>(ownerTrackId);
  const trackId = fixedTrack ? fixedTrack.id : chosenTrack;
  const [state, setState] = useState<State>({ status: 'loading', last: null });
  const typeId = form.ticketTypeId ?? chosenType;
  const layouts = useMemo(() => JSON.stringify(entriesOf(drafts)), [drafts]);
  // The chosen track's releases and areas, read once per track: the create form drops an
  // optional row whose list is empty (T-359). Until they are known the preview says it may.
  const [lists, setLists] = useState<{ trackId: number; lists: TrackLists } | null>(null);
  const wantsLists = form.operation === 'create' && trackId !== null && Boolean(client.trackLists);

  useEffect(() => {
    if (!wantsLists || trackId === null || !client.trackLists) return;
    let live = true;
    client.trackLists(trackId).then(
      (read) => {
        if (live) setLists({ trackId, lists: read });
      },
      // Unknown, so the rows keep saying they may go; an expired session is said as anywhere.
      (error) => void expired(error),
    );
    return () => {
      live = false;
    };
  }, [client, trackId, wantsLists, expired]);
  const known = wantsLists && lists?.trackId === trackId ? lists.lists : null;

  useEffect(() => {
    if (typeId === null) return;
    let live = true;
    setState((s) => ({ status: 'loading', last: lastOf(s) }));
    const timer = setTimeout(() => {
      client
        .preview(setId, {
          ticketTypeId: typeId,
          operation: form.operation,
          trackId,
          layouts: JSON.parse(layouts),
        })
        .then(
          (preview) => {
            if (live) setState({ status: 'ready', preview });
          },
          (error) => {
            if (!live || expired(error)) return;
            if (error instanceof ApiError && error.status === 400) {
              setState((s) => ({ status: 'refused', answer: error.body, last: lastOf(s) }));
            } else {
              setState((s) => ({ status: 'failed', last: lastOf(s) }));
            }
          },
        );
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, setId, typeId, form.operation, trackId, layouts, delay, expired]);

  const last = state.status === 'ready' ? state.preview : state.last;
  // The create form leaves out what is set once the ticket exists, Close reason among them, unless
  // it is required (PL-20, D30): the preview leaves out the same, from the form's own lists.
  // So does a row of an empty list of the track's releases or areas, as the form drops it.
  const shown = last && last.layout.operation === 'create' ? asCreated(last, known) : last;
  // Why, in the catalogue's words; a refusal the editor does not know is said in general.
  const reason = state.status === 'refused' ? layoutRefusal(t, state.answer, knownName) : null;
  const typeName = types.find((x) => x.id === typeId)?.name ?? '';
  const nameOf = (key: string) => {
    const custom = /^cf\[(\d+)\]$/.exec(key)?.[1];
    const found = custom ? shown?.customFields.find((f) => f.id === Number(custom)) : undefined;
    return found?.name ?? fieldName(key);
  };
  /**
   * Under an optional row of a list of the track's own, while the track's lists are not known
   * (no particular track): the real create form may leave it out.
   */
  const mayGo = (key: string): MessageId | null => {
    if (known || !shown) return null;
    const kind = listKindOf(key, shown.customFields);
    return kind ? ONLY_WHEN_LISTED[kind] : null;
  };

  return (
    <section aria-labelledby={`${id}-title`} className="layout-preview glass-card">
      <h2 id={`${id}-title`} className="section-title">
        {t('layouts.preview.title')}
      </h2>
      <p className="form-hint">{t('layouts.preview.intro')}</p>
      <div className="layout-preview-choices">
        {form.ticketTypeId === null && (
          <div className="form-field">
            <label htmlFor={`${id}-type`} className="form-label">
              {t('layouts.preview.type')}
            </label>
            <select
              id={`${id}-type`}
              value={chosenType ?? ''}
              onChange={(event) => setChosenType(Number(event.target.value))}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {fixedTrack ? (
          <p className="form-hint">
            {t('layouts.preview.fixedTrack', { key: fixedTrack.key, name: fixedTrack.name })}
          </p>
        ) : (
          <div className="form-field">
            <label htmlFor={`${id}-track`} className="form-label">
              {t('layouts.preview.track')}
            </label>
            <select
              id={`${id}-track`}
              value={trackId ?? ''}
              aria-describedby={`${id}-track-hint`}
              onChange={(event) =>
                setChosenTrack(event.target.value === '' ? null : Number(event.target.value))
              }
            >
              <option value="">{t('layouts.preview.noTrack')}</option>
              {ownerTrackId !== null && !tracks.some((track) => track.id === ownerTrackId) && (
                <option value={ownerTrackId}>{t('layouts.preview.ownerTrack')}</option>
              )}
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {t('admin.explain.trackOption', { key: track.key, name: track.name })}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {/* Under the row, so the two selects stand side by side at one height (AD-37). */}
      {!fixedTrack && (
        <p id={`${id}-track-hint`} className="form-hint">
          {t('layouts.preview.trackHint')}
        </p>
      )}
      {typeId === null ? (
        <EmptyState compact title={t('layouts.preview.noTypes')} />
      ) : (
        <>
          <p role="status" className="form-status">
            {state.status === 'loading' ? t('layouts.preview.loading') : ''}
          </p>
          {state.status === 'refused' && (
            <div role="alert" className="form-error">
              <p>{t('layouts.preview.refused')}</p>
              {reason && <p className="layout-preview-detail">{reason}</p>}
            </div>
          )}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('layouts.preview.failed')}
            </p>
          )}
          {shown && (
            <div className="layout-preview-form" aria-busy={state.status === 'loading'}>
              <p className="form-label">
                {t('layouts.preview.formOf', { operation: form.operation, type: typeName })}
              </p>
              <p className="form-hint">
                {t(
                  shown.source === 'type'
                    ? form.ticketTypeId === null
                      ? 'layouts.preview.source.typeOwn'
                      : 'layouts.preview.source.type'
                    : shown.source === 'every_type'
                      ? 'layouts.preview.source.everyType'
                      : 'layouts.preview.source.none',
                  { type: typeName },
                )}
              </p>
              {shown.layout.tabs.map((tab, i) => {
                const only = shown.layout.tabs.length === 1;
                const name = tab.name ?? (only ? null : t('tickets.create.moreFields'));
                const headingId = `${id}-tab-${i}`;
                return (
                  <section
                    // biome-ignore lint/suspicious/noArrayIndexKey: the server's tabs have no id
                    key={i}
                    className="layout-preview-tab"
                    {...(name ? { 'aria-labelledby': headingId } : {})}
                  >
                    {name && (
                      <h3 id={headingId} className="facts-title">
                        {name}
                      </h3>
                    )}
                    <div className="layout-preview-sections">
                      {tab.sections.map((section, j) => (
                        <div
                          // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id
                          key={j}
                          className={`layout-preview-section is-${section.kind}`}
                        >
                          {section.hideWhenEmpty && (
                            <p className="form-hint">{t('layouts.preview.hidesWhenEmpty')}</p>
                          )}
                          {section.fields.length === 0 ? (
                            <EmptyState compact title={t('layouts.preview.emptySection')} />
                          ) : (
                            <ul className="layout-preview-fields">
                              {section.fields.map((field) => (
                                <li key={field.key} className="layout-preview-field">
                                  <span className="layout-preview-label">
                                    {nameOf(field.key)}
                                    {field.required && (
                                      <span className="layout-preview-required">
                                        {t('layouts.preview.required')}
                                      </span>
                                    )}
                                  </span>
                                  <span className="layout-preview-input" aria-hidden="true" />
                                  {field.description && (
                                    <span className="form-hint">{field.description}</span>
                                  )}
                                  {shown.layout.operation === 'create' &&
                                    !field.required &&
                                    mayGo(field.key) && (
                                      <span className="form-hint">
                                        {t(mayGo(field.key) as MessageId)}
                                      </span>
                                    )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
              {shown.leftOut.length > 0 && (
                <div className="layout-preview-left">
                  <p className="form-label">{t('layouts.preview.leftOut')}</p>
                  <ul>
                    {shown.leftOut.map((left) => (
                      <li key={left.field}>
                        {t(REASONS[left.reason], { field: nameOf(left.field) })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function lastOf(state: State): Preview | null {
  return state.status === 'ready' ? state.preview : state.last;
}
