import { type ReactNode, useId, useState } from 'react';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import {
  type ConfigurationClient,
  type MappingNeeded,
  type Named,
  type NewTrack,
  TRACK_TEMPLATES,
  type Track,
  type TrackTemplate,
} from './client';

export type TrackMode = 'shared' | 'local';

/** Why the server refused a change of a track, in plain words. */
export function trackRefusal(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t('admin.tracks.problem.other');
  const body = error.body as {
    error?: string;
    problem?: string;
    statuses?: MappingNeeded[];
  } | null;
  if (body?.error === 'status_mapping_required') {
    const needed = body.statuses ?? [];
    const tickets = needed.reduce((n, m) => n + m.ticketCount, 0);
    return t('admin.tracks.problem.mapping', { tickets });
  }
  if (body?.error === 'status_migration_running') return t('admin.tracks.problem.migrating');
  if (body?.error === 'key_taken' || body?.error === 'invalid_key') {
    return t('admin.tracks.problem.key');
  }
  if (body?.error === 'last_track_admin') return t('admin.tracks.problem.lastAdmin');
  if (error.status === 403) return t('admin.tracks.problem.forbidden');
  return t('admin.tracks.problem.other');
}

const TEMPLATE_LABELS: Record<TrackTemplate, MessageId> = {
  scrum: 'admin.tracks.template.scrum',
  kanban: 'admin.tracks.template.kanban',
  'bug-tracking': 'admin.tracks.template.bugTracking',
  business: 'admin.tracks.template.business',
  blank: 'admin.tracks.template.blank',
};

const MODE_LABELS: Record<TrackMode, MessageId> = {
  shared: 'admin.tracks.shared',
  local: 'admin.tracks.local',
};

export interface NewTrackFormProps {
  client: ConfigurationClient;
  /** The tracks whose configuration a new one may copy: the shared ones (M1-054). */
  tracks: readonly Track[];
  /** The configurations the person may choose, as the server's rule has it. */
  modes?: readonly TrackMode[];
  /** Names the form and its button. */
  label: string;
  onAdded: (track: Track, board?: Named) => void;
  onProblem: (error: unknown) => void;
  /** Other buttons beside the one that creates it. */
  actions?: ReactNode;
  /** On a page of its own it is a glass card; in a dialog it already sits on glass. */
  card?: boolean;
}

/**
 * Making a track (CORE-001, CORE-002): its key, its name, shared or its own configuration, and a
 * template or a shared track to copy. Used by Administration and by the Tracks directory.
 */
export function NewTrackForm({
  client,
  tracks,
  modes = ['shared', 'local'],
  label,
  onAdded,
  onProblem,
  actions,
  card = false,
}: NewTrackFormProps) {
  const t = useT();
  const id = useId();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TrackMode>(modes[0] ?? 'shared');
  /** `template:<id>` or `track:<id>`. */
  const [start, setStart] = useState('template:blank');
  const copyable = tracks.filter((x) => x.mode === 'shared' && !x.archived);
  const origin = (): Pick<NewTrack, 'template' | 'copyFrom'> => {
    const [kind, value] = start.split(':');
    if (kind === 'track' && mode === 'shared') return { copyFrom: Number(value) };
    return { template: (kind === 'template' ? value : 'blank') as TrackTemplate };
  };
  return (
    <form
      className={card ? 'glass-card people-card people-form' : 'people-form'}
      data-tutorial="new-track-form"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        client
          .createTrack({ key: key.trim().toUpperCase(), name: name.trim(), mode, ...origin() })
          .then(({ track, board }) => {
            onAdded(track, board);
            setKey('');
            setName('');
          }, onProblem);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-key`} className="form-label">
          {t('admin.tracks.key')}
        </label>
        <input
          id={`${id}-key`}
          type="text"
          required
          autoComplete="off"
          value={key}
          aria-describedby={`${id}-key-hint`}
          onChange={(event) => setKey(event.target.value)}
        />
        <p id={`${id}-key-hint`} className="form-hint">
          {t('admin.tracks.keyHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.tracks.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-mode`} className="form-label">
          {t('admin.tracks.mode')}
        </label>
        <select
          id={`${id}-mode`}
          value={mode}
          onChange={(event) => setMode(event.target.value as TrackMode)}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {t(MODE_LABELS[m])}
            </option>
          ))}
        </select>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-start`} className="form-label">
          {t('admin.tracks.startFrom')}
        </label>
        <select
          id={`${id}-start`}
          value={mode === 'local' && start.startsWith('track:') ? 'template:blank' : start}
          aria-describedby={`${id}-start-hint`}
          onChange={(event) => setStart(event.target.value)}
        >
          <optgroup label={t('admin.tracks.templates')}>
            {TRACK_TEMPLATES.map((template) => (
              <option key={template} value={`template:${template}`}>
                {t(TEMPLATE_LABELS[template])}
              </option>
            ))}
          </optgroup>
          {mode === 'shared' && copyable.length > 0 && (
            <optgroup label={t('admin.tracks.copyGroup')}>
              {copyable.map((x) => (
                <option key={x.id} value={`track:${x.id}`}>
                  {t('admin.tracks.copyOf', { key: x.key, name: x.name })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <p id={`${id}-start-hint`} className="form-hint">
          {t('admin.tracks.startFromHint')}
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {label}
        </button>
        {actions}
      </div>
    </form>
  );
}
