import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NewButton, useNewForm } from '../../admin/NewButton';
import { useT } from '../../i18n/I18nProvider';
import { useSessionExpiry } from '../../session/useSessionExpiry';
import { DangerAction } from '../../shell/DangerAction';
import { EmptyState } from '../../shell/EmptyState';
import { PageHeader } from '../../shell/PageHeader';
import {
  type SavedTemplate,
  type TemplateClient,
  type TemplateList,
  type TemplateOptions,
  templateClient,
} from './client';
import { refusalOf } from './draft';
import { TemplateForm } from './TemplateForm';

export interface TicketTemplatesPageProps {
  /** The track whose templates these are (#/tracks/KEY/templates); none for every track. */
  trackKey?: string;
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TemplateClient;
}

/**
 * Ticket templates (CORE-029): a track's at #/tracks/KEY/templates, with those for every track
 * alongside, read-only; those for every track at #/admin/ticket-templates. Those who may change
 * them add, edit and delete here; everyone else reads what the create form will offer.
 */
export function TicketTemplatesPage({
  trackKey,
  client = templateClient,
}: TicketTemplatesPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const track = trackKey ?? null;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'loaded'; list: TemplateList; options: TemplateOptions }
  >({ status: 'loading' });
  // A new template's form opens from the New button (D11); a saved one's from its row.
  const creating = useNewForm();
  const [editing, setEditing] = useState<SavedTemplate | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, options] = await Promise.all([client.list(track), client.options(track)]);
      setState({ status: 'loaded', list, options });
    } catch (error) {
      if (!expired(error)) setState({ status: 'failed' });
    }
  }, [client, track, expired]);
  useEffect(() => {
    void load();
  }, [load]);

  const typeName = (options: TemplateOptions, id: number) =>
    options.types.find((type) => type.id === id)?.name ?? String(id);

  // Asked first (D13); a refusal keeps the question open, the reason above the list.
  const remove = async (template: SavedTemplate) => {
    try {
      await client.remove(template.id);
    } catch (error) {
      setProblem(t(refusalOf(error)));
      throw error;
    }
    setProblem(null);
    setMessage(t('tickets.templates.deleted', { name: template.name }));
    await load();
    // The template's row is gone: the page's heading takes the focus.
    titleRef.current?.focus();
  };

  // A track's templates sit under its tab bar (T-215): titled like its other pages, the track named
  // above the title (D26); the line under it says what this page covers (TR-27).
  const trackName = state.status === 'loaded' ? (state.options.track?.name ?? null) : null;
  const title = track ? t('tickets.templates.trackTitle') : t('tickets.templates.adminTitle');

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={titleRef}
        title={title}
        eyebrow={track ? (trackName ?? track) : undefined}
        purpose={track ? t('tickets.templates.trackPurpose') : t('settings.ticketTemplatesHint')}
        about={t('tickets.templates.intro')}
        {...(state.status === 'loaded' && state.list.mayCreate
          ? {
              // In the one place every administration page has it (D11, AD-18).
              actions: (
                <NewButton
                  label={t('tickets.templates.new')}
                  open={creating.open}
                  onToggle={() => {
                    setMessage('');
                    setEditing(null);
                    creating.toggle();
                  }}
                  ref={creating.button}
                />
              ),
            }
          : {})}
      />
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state.status === 'loading' && <p className="page-note">{t('tickets.templates.loading')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('tickets.templates.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {!state.list.mayCreate && (
            <p className="page-note">
              {track
                ? t('tickets.templates.readOnlyTrack')
                : t('tickets.templates.readOnlyEveryTrack')}
            </p>
          )}
          {(creating.open || editing) && (
            <TemplateForm
              key={editing?.id ?? 'new'}
              client={client}
              track={track}
              options={state.options}
              template={editing}
              onCancel={() => (editing ? setEditing(null) : creating.close())}
              onSaved={(saved) => {
                if (editing) setEditing(null);
                else creating.close();
                setProblem(null);
                setMessage(t('tickets.templates.saved', { name: saved.name }));
                void load();
              }}
            />
          )}
          {state.list.templates.length === 0 ? (
            <EmptyState title={t('tickets.templates.none')}>{t('empty.templates.body')}</EmptyState>
          ) : (
            <ul className="people-list">
              {state.list.templates.map((template) => {
                // A template for every track is kept on its own page: a track's form would
                // offer that track's areas and releases, which it cannot hold.
                const here = track === null || template.track !== null;
                return (
                  <li key={template.id} className="people-item">
                    <div className="people-main">
                      <p className="people-name">
                        {template.name}
                        {track !== null && template.track === null && (
                          <span className="people-badge">{t('tickets.templates.everyTrack')}</span>
                        )}
                      </p>
                      {template.purpose && <p className="people-meta">{template.purpose}</p>}
                      <p className="people-meta">
                        {template.ticketTypeIds.length === 0
                          ? t('tickets.templates.everyType')
                          : template.ticketTypeIds
                              .map((id) => typeName(state.options, id))
                              .join(', ')}
                      </p>
                      {template.subtickets.length > 0 && (
                        <p className="people-meta">
                          {t('tickets.templates.subticketCount', {
                            count: template.subtickets.length,
                          })}
                        </p>
                      )}
                    </div>
                    {template.mayEdit && here && (
                      <div className="people-actions">
                        <button
                          type="button"
                          className="button-secondary people-action"
                          aria-label={t('tickets.templates.editOf', { name: template.name })}
                          onClick={() => {
                            setMessage('');
                            // One form at a time: a new template's gives way.
                            if (creating.open) creating.toggle();
                            setEditing(template);
                          }}
                        >
                          {t('tickets.templates.edit')}
                        </button>
                        <DangerAction
                          label={t('tickets.templates.delete')}
                          name={t('tickets.templates.deleteOf', { name: template.name })}
                          outcome={t('tickets.templates.confirmDelete', { name: template.name })}
                          confirmLabel={t('tickets.templates.deleteOf', { name: template.name })}
                          onConfirm={() => remove(template)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
