import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { CardHead, NewButton, useNewForm } from '../admin/NewButton';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import type { PrioritiesClient, Priority, PrioritySet } from './client';
import { useFeedback } from './feedback';

/** Where a track chooses the set it uses (UI-T20). */
const TRACK_SETS_HREF = '#/admin/track-sets';

export interface PrioritySetsSectionProps {
  client: PrioritiesClient;
  /** The site's priorities, in their order. */
  priorities: Priority[];
  sets: PrioritySet[];
  /** Reads the page again after a change. */
  reload: () => Promise<void>;
}

/**
 * Priority sets (CORE-014 (2)): which priorities a track offers and which one new tickets get.
 * Add a set; change its name, priorities and default; make it the site's default set; delete one
 * that is not the default, whose tracks go back to the default set.
 */
export function PrioritySetsSection({
  client,
  priorities,
  sets,
  reload,
}: PrioritySetsSectionProps) {
  const t = useT();
  const intl = useIntl();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const creating = useNewForm();
  const feedback = useFeedback(reload);
  const [open, setOpen] = useState<number | null>(null);
  const note = useRef<HTMLParagraphElement>(null);
  /** A set just made the default: its note, drawn where its button was, takes the keyboard. */
  const [madeDefault, setMadeDefault] = useState(false);
  useEffect(() => {
    if (!madeDefault) return;
    note.current?.focus();
    setMadeDefault(false);
  }, [madeDefault]);
  const nameOf = new Map(priorities.map((p) => [p.id, p.name]));
  const fallback = sets.find((s) => s.isDefault);

  const summary = (set: PrioritySet) => {
    const offered = intl.formatList(
      set.priorityIds.map((id) => nameOf.get(id) ?? ''),
      { type: 'conjunction' },
    );
    const chosen = set.defaultPriorityId === null ? undefined : nameOf.get(set.defaultPriorityId);
    return chosen
      ? t('admin.priorities.setSummary', {
          priorities: offered,
          priority: chosen,
          tracks: set.trackCount,
        })
      : t('admin.priorities.setSummaryMiddle', { priorities: offered, tracks: set.trackCount });
  };

  return (
    <section aria-labelledby={headingId} className="glass-card people-card">
      <CardHead
        action={
          <NewButton
            label={t('admin.priorities.newSet')}
            open={creating.open}
            onToggle={creating.toggle}
            ref={creating.button}
          />
        }
      >
        <h2 id={headingId} ref={heading} tabIndex={-1} className="facts-title">
          {t('admin.priorities.sets')}
        </h2>
      </CardHead>
      <p className="page-note">
        {t('admin.priorities.setsNote')}{' '}
        <a href={routeHref(TRACK_SETS_HREF)}>{t('admin.priorities.setsLink')}</a>
      </p>
      {creating.open && (
        <SetForm
          label={t('admin.priorities.addSet')}
          submitLabel={t('admin.priorities.addSet')}
          priorities={priorities}
          onCancel={creating.close}
          onSubmit={async (body) => {
            try {
              await client.createPrioritySet(body);
            } catch (error) {
              feedback.refused(error);
              return false;
            }
            creating.close();
            await feedback.said(t('admin.priorities.added', { name: body.name }));
            return true;
          }}
        />
      )}
      <p role="status" className="form-status">
        {feedback.message}
      </p>
      {feedback.problem && (
        <p role="alert" className="form-error">
          {feedback.problem}
        </p>
      )}
      <ul className="people-list">
        {sets.map((set) => (
          <li key={set.id} className="people-item">
            <div className="people-main">
              <p className="people-name">
                {set.name}
                {set.isDefault && (
                  <span className="people-badge">{t('admin.priorities.defaultSet')}</span>
                )}
              </p>
              {set.description && <p className="people-meta">{set.description}</p>}
              <p className="people-meta">{summary(set)}</p>
            </div>
            <div className="people-actions">
              <button
                type="button"
                className="button-secondary people-action"
                aria-expanded={open === set.id}
                aria-label={t('admin.priorities.manageSetOf', { name: set.name })}
                onClick={() => setOpen(open === set.id ? null : set.id)}
              >
                {t('admin.priorities.manage')}
              </button>
            </div>
            {open === set.id && (
              <div className="people-panel">
                <SetForm
                  key={set.id}
                  label={t('admin.priorities.setChangeOf', { name: set.name })}
                  submitLabel={t('admin.priorities.save')}
                  priorities={priorities}
                  initial={set}
                  onSubmit={async (body) => {
                    try {
                      await client.updatePrioritySet(set.id, body);
                    } catch (error) {
                      feedback.refused(error);
                      return false;
                    }
                    await feedback.said(t('admin.priorities.saved', { name: body.name }));
                    return true;
                  }}
                />
                {set.isDefault ? (
                  <p ref={note} tabIndex={-1} className="page-note">
                    {t('admin.priorities.defaultSetNote')}
                  </p>
                ) : (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      aria-label={t('admin.priorities.makeDefaultOf', { name: set.name })}
                      onClick={() => {
                        client
                          .updatePrioritySet(set.id, { isDefault: true })
                          .then(
                            () =>
                              feedback
                                .said(t('admin.priorities.madeDefault', { name: set.name }))
                                .then(() => setMadeDefault(true)),
                            feedback.refused,
                          );
                      }}
                    >
                      {t('admin.priorities.makeDefault')}
                    </button>
                    {/* Asks first, saying what will happen (D13); its tracks go to the default. */}
                    <DangerAction
                      label={t('admin.priorities.delete')}
                      name={t('admin.priorities.deleteSetOf', { name: set.name })}
                      outcome={t('admin.priorities.confirmDeleteSet', {
                        name: set.name,
                        tracks: set.trackCount,
                        fallback: fallback?.name ?? '',
                      })}
                      confirmLabel={t('admin.priorities.deleteSetOf', { name: set.name })}
                      onConfirm={async () => {
                        try {
                          await client.deletePrioritySet(set.id);
                        } catch (error) {
                          feedback.refused(error);
                          throw error;
                        }
                        setOpen(null);
                        await feedback.said(t('admin.priorities.deleted', { name: set.name }));
                        heading.current?.focus();
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface SetBody {
  name: string;
  description: string;
  priorityIds: number[];
  defaultPriorityId: number | null;
}

/** A set's name, the priorities it offers and the one new tickets get. */
function SetForm({
  label,
  submitLabel,
  priorities,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  priorities: Priority[];
  initial?: PrioritySet;
  /** Answers whether it was saved; the form keeps what was chosen when it was not. */
  onSubmit: (body: SetBody) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [chosen, setChosen] = useState<number[]>(initial?.priorityIds ?? []);
  const [fallback, setFallback] = useState(String(initial?.defaultPriorityId ?? ''));
  // In the site's order, whatever order they were ticked in.
  const offered = priorities.filter((p) => chosen.includes(p.id));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted || offered.length === 0) return;
    void onSubmit({
      name: wanted,
      description: description.trim(),
      priorityIds: offered.map((p) => p.id),
      defaultPriorityId: fallback === '' ? null : Number(fallback),
    }).then((saved) => {
      if (saved && !initial) {
        setName('');
        setDescription('');
        setChosen([]);
        setFallback('');
      }
    });
  };

  return (
    <form className="people-inline" aria-label={label} onSubmit={submit}>
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.priorities.setName')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          maxLength={255}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-about`} className="form-label">
          {t('admin.priorities.description')}
        </label>
        <input
          id={`${id}-about`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <fieldset className="sets-choices">
        <legend>{t('admin.priorities.offers')}</legend>
        {priorities.map((priority) => (
          <div key={priority.id} className="form-field form-field-inline">
            <input
              id={`${id}-${priority.id}`}
              type="checkbox"
              checked={chosen.includes(priority.id)}
              onChange={(event) => {
                if (event.target.checked) {
                  setChosen([...chosen, priority.id]);
                  return;
                }
                setChosen(chosen.filter((p) => p !== priority.id));
                // A priority it no longer offers is no longer what new tickets get.
                if (fallback === String(priority.id)) setFallback('');
              }}
            />
            <label htmlFor={`${id}-${priority.id}`}>{priority.name}</label>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-default`} className="form-label">
          {t('admin.priorities.newTickets')}
        </label>
        <select
          id={`${id}-default`}
          value={fallback}
          aria-describedby={`${id}-default-hint`}
          onChange={(event) => setFallback(event.target.value)}
        >
          <option value="">{t('admin.priorities.middle')}</option>
          {offered.map((priority) => (
            <option key={priority.id} value={priority.id}>
              {priority.name}
            </option>
          ))}
        </select>
        <p id={`${id}-default-hint`} className="form-hint">
          {t('admin.priorities.newTicketsHint')}
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={offered.length === 0}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="button-secondary" onClick={onCancel}>
            {t('admin.priorities.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
