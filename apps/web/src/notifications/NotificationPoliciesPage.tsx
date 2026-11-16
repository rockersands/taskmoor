import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  ScopeNote,
  type ScopeTrack,
  TrackScopeLine,
  useSetScope,
  useTrackPageTrail,
} from '../sets/trackScope';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import {
  type Choice,
  type FieldChoice,
  type NotificationPolicy,
  type PoliciesClient,
  type PolicyEvents,
  type PolicyRule,
  policiesClient,
  RECIPIENTS,
  type Recipient,
  type RuleInput,
  ruleInput,
} from './policiesClient';

/** Where a track's policy is chosen, beside its other sets (UI-T20). */
const TRACK_SETS_HREF = '#/admin/track-sets';
/** A local-mode track's own policies, beside its Manage page (T-163a's pattern). */
export const ownPoliciesHref = (trackId: number) =>
  `#/manage/tracks/${trackId}/notification-policies`;

const CUSTOM = 'custom:';
/** A transition's event as a policy names it (the server's `notifications/model.ts`). */
const CUSTOM_NAME = /^[A-Za-z0-9 _.-]{1,100}$/;
/** The event choice that opens a box for a transition event's name. */
const TYPED = 'typed';
/** Track keys named in a line before "and N more". */
const TRACKS_SHOWN = 12;
/** Recipient types that name one person, group, role or field. */
const TARGETED: ReadonlySet<Recipient> = new Set([
  'user',
  'group',
  'role',
  'user_field',
  'group_field',
]);

type Translate = ReturnType<typeof useT>;

/** An event as people read it: its name in the account settings, or the transition's own. */
function eventLabel(t: Translate, event: string): string {
  if (event.startsWith(CUSTOM)) {
    return t('notificationPolicies.customEvent', { name: event.slice(CUSTOM.length) });
  }
  return t(`notifications.event.${event}` as MessageId);
}

/** Who a rule reaches, by the name of what it points at. */
function recipientLabel(t: Translate, rule: PolicyRule): string {
  const gone = t('notificationPolicies.gone');
  switch (rule.recipient) {
    case 'user':
      return t('notificationPolicies.recipient.user', { name: rule.userName ?? gone });
    case 'group':
      return t('notificationPolicies.recipient.group', { name: rule.groupName ?? gone });
    case 'role':
      return t('notificationPolicies.recipient.role', { name: rule.roleName ?? gone });
    case 'user_field':
    case 'group_field':
      return t(`notificationPolicies.recipient.${rule.recipient}`, {
        name: rule.fieldName ?? gone,
      });
    default:
      return t(`notificationPolicies.recipient.${rule.recipient}` as MessageId);
  }
}

/**
 * A rule naming a field since deleted (T-155): deleting a field leaves its rules, which then reach
 * nobody, and the server refuses a rule list that names a field no longer there. Every change to
 * the rules sends the whole list, so these are left out of it, and the page says so.
 */
const namesGoneField = (rule: PolicyRule) => rule.fieldKey !== null && rule.fieldName === null;
/** The rules a save sends: the policy's own, without those naming a field since deleted. */
const keptRules = (rules: readonly PolicyRule[]) =>
  rules.filter((r) => !namesGoneField(r)).map(ruleInput);

/** A recipient type in the rule form's choice. */
const kindLabel = (t: Translate, kind: Recipient) =>
  t(
    (TARGETED.has(kind)
      ? `notificationPolicies.kind.${kind}`
      : `notificationPolicies.recipient.${kind}`) as MessageId,
  );

/** The tracks a policy serves, by key; a long list ends with how many more. */
function trackKeys(t: Translate, tracks: { key: string }[]): string {
  const keys = tracks
    .slice(0, TRACKS_SHOWN)
    .map((x) => x.key)
    .join(', ');
  return tracks.length > TRACKS_SHOWN
    ? t('notificationPolicies.moreTracks', { tracks: keys, count: tracks.length - TRACKS_SHOWN })
    : keys;
}

/** The default policy first, then the server's order (by name). */
const ordered = (policies: NotificationPolicy[]) => [
  ...policies.filter((p) => p.isDefault),
  ...policies.filter((p) => !p.isDefault),
];

const sameRule = (a: RuleInput, b: RuleInput) =>
  a.event === b.event &&
  a.recipient === b.recipient &&
  a.userId === b.userId &&
  a.groupId === b.groupId &&
  a.roleId === b.roleId &&
  a.fieldKey === b.fieldKey;

export interface NotificationPoliciesPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PoliciesClient;
  /** A local-mode track's own page: only the policies it owns (T-163a's pattern). */
  trackId?: number | null;
}

/**
 * Notification policies (NTF-001; T-155): each policy pairs events with who hears of them, and a
 * track uses one, or the default. Site and configuration administrators manage the shared ones;
 * on a local-mode track's own page (`trackId`) whoever runs the track manages the policies it
 * owns and makes the track use one. Someone who runs tracks but is no administrator is offered
 * those pages instead (`sets/trackScope.tsx`). Which shared policy a track uses is chosen on
 * Which sets a track uses.
 */
export function NotificationPoliciesPage({
  client = policiesClient,
  trackId = null,
}: NotificationPoliciesPageProps) {
  const t = useT();
  const titleId = useId();
  const scope = useSetScope(trackId, client);
  const track = scope.status === 'track' ? scope.track : null;
  useTrackPageTrail(scope, t('notificationPolicies.title'));
  /** The purpose shows only to someone who may be here; only the policies themselves can tell. */
  const header = (allowed: boolean, actions?: ReactNode) => (
    <PageHeader
      titleId={titleId}
      title={t('notificationPolicies.title')}
      {...(track ? { eyebrow: t('ownSets.trackName', { key: track.key, name: track.name }) } : {})}
      {...(allowed
        ? {
            purpose: t('settings.notificationPoliciesHint'),
            about: t(track ? 'notificationPolicies.trackAbout' : 'notificationPolicies.about'),
            ...(actions ? { actions } : {}),
          }
        : {})}
    />
  );
  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      {scope.status === 'all' || track ? (
        <Policies key={track?.id ?? 'all'} client={client} track={track} header={header} />
      ) : (
        <>
          {header(false)}
          <ScopeNote
            scope={scope}
            hrefOf={ownPoliciesHref}
            words={{
              chooseIntro: t('notificationPolicies.choose.intro'),
              chooseNone: t('notificationPolicies.choose.none'),
              chooseOpen: (run) =>
                t('notificationPolicies.choose.open', { key: run.key, name: run.name }),
              shared: (shared) => t('notificationPolicies.scope.shared', { key: shared.key }),
              none: t('notificationPolicies.forbidden'),
              failed: t('notificationPolicies.failed'),
            }}
          />
        </>
      )}
    </section>
  );
}

/** What the rule form chooses from, read once with the page. */
interface Lists {
  events: PolicyEvents;
  roles: Choice[];
  groups: Choice[];
  fields: FieldChoice[];
}

interface Feedback {
  /** A policy as the server now has it. */
  put: (policy: NotificationPolicy) => void;
  /** Says what happened. */
  said: (text: string) => void;
  failed: (error: unknown) => void;
}

/** The policies the page shows: every shared one, or one track's own. */
function Policies({
  client,
  track,
  header,
}: {
  client: PoliciesClient;
  track: ScopeTrack | null;
  header: (allowed: boolean, actions?: ReactNode) => ReactNode;
}) {
  const t = useT();
  const expired = useSessionExpiry();
  const listId = useId();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const creating = useNewForm();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; policies: NotificationPolicy[]; lists: Lists }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const owner = track?.id ?? null;

  const load = useCallback(async () => {
    try {
      const [policies, events, roles, groups, fields] = await Promise.all([
        client.policies(owner),
        client.events(owner),
        // The lists only offer choices: a rule form without them still names the ticket's people.
        client.roles(track).catch(() => []),
        client.groups(),
        client.fields(track).catch(() => []),
      ]);
      setState({
        status: 'loaded',
        policies: ordered(policies),
        lists: { events, roles, groups, fields },
      });
    } catch (error) {
      if (expired(error)) return;
      setState({
        status: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'failed',
      });
    }
  }, [client, owner, track, expired]);
  useEffect(() => {
    void load();
  }, [load]);

  const put = (policy: NotificationPolicy) =>
    setState((was) =>
      was.status === 'loaded'
        ? {
            ...was,
            policies: was.policies.some((p) => p.id === policy.id)
              ? was.policies.map((p) => (p.id === policy.id ? policy : p))
              : [...was.policies, policy],
          }
        : was,
    );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
  };
  const failed = (error: unknown) => {
    if (expired(error)) return;
    const status = error instanceof ApiError ? error.status : 0;
    const code = error instanceof ApiError ? error.code : undefined;
    const usedBy = (
      error instanceof ApiError ? (error.body as { usedBy?: { key: string }[] }) : null
    )?.usedBy;
    setMessage('');
    setProblem(
      code === 'name_taken'
        ? t('notificationPolicies.problem.nameTaken')
        : code === 'in_use'
          ? t('notificationPolicies.problem.inUse', { tracks: trackKeys(t, usedBy ?? []) })
          : code === 'default_policy'
            ? t('notificationPolicies.problem.default')
            : status === 400
              ? t('notificationPolicies.problem.invalid')
              : status === 403 || status === 404
                ? t('notificationPolicies.problem.forbidden')
                : t('notificationPolicies.problem.other'),
    );
  };

  if (state.status === 'forbidden') {
    return (
      <>
        {header(false)}
        <p className="page-note">{t('notificationPolicies.forbidden')}</p>
      </>
    );
  }
  const policies = state.status === 'loaded' ? state.policies : [];
  const usedHere = track ? policies.find((p) => p.usedBy.some((u) => u.id === track.id)) : null;
  return (
    <>
      {header(
        true,
        <NewButton
          label={t('notificationPolicies.new')}
          open={creating.open}
          onToggle={creating.toggle}
          ref={creating.button}
        />,
      )}
      {track && <TrackScopeLine track={track} intro={t('notificationPolicies.trackIntro')} />}
      <p role="status" className="form-status">
        {message}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
      {state.status === 'loading' && (
        <p className="page-note">{t('notificationPolicies.loading')}</p>
      )}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('notificationPolicies.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {creating.open && (
            <NewPolicy
              client={client}
              track={track}
              policies={policies}
              failed={failed}
              onCancel={creating.close}
              onAdded={(made) => {
                put(made);
                setOpen(made.id);
                creating.close();
                said(t('notificationPolicies.added', { name: made.name }));
              }}
            />
          )}
          <section aria-labelledby={listId} className="glass-card admin-panel">
            <h2 id={listId} ref={listHeading} tabIndex={-1} className="section-title">
              {track
                ? t('notificationPolicies.ownList', { key: track.key })
                : t('notificationPolicies.sharedList')}
            </h2>
            {track ? (
              <p className="page-note">
                {usedHere
                  ? t('notificationPolicies.trackUsesOwn', { key: track.key, name: usedHere.name })
                  : t('notificationPolicies.trackUsesShared', { key: track.key })}
              </p>
            ) : (
              <p className="page-note">
                {t('notificationPolicies.chooseNote')}{' '}
                <a href={routeHref(TRACK_SETS_HREF)}>{t('notificationPolicies.chooseLink')}</a>
              </p>
            )}
            {policies.length === 0 ? (
              <EmptyState compact title={t('notificationPolicies.emptyTitle')}>
                {track
                  ? t('notificationPolicies.empty', { key: track.key })
                  : t('notificationPolicies.emptyShared')}
              </EmptyState>
            ) : (
              <ul className="people-list">
                {policies.map((policy) => (
                  <li key={policy.id} className="people-item people-group">
                    <div className="people-main">
                      <p className="people-name">
                        {policy.name}
                        {policy.isDefault && (
                          <span className="people-badge">{t('notificationPolicies.default')}</span>
                        )}
                      </p>
                      {policy.description && <p className="people-meta">{policy.description}</p>}
                      <p className="people-meta">
                        {[
                          policy.isDefault ? t('notificationPolicies.defaultUse') : '',
                          policy.usedBy.length > 0
                            ? t('notificationPolicies.usedBy', {
                                tracks: trackKeys(t, policy.usedBy),
                              })
                            : t('notificationPolicies.unused'),
                          t('notificationPolicies.ruleCount', { count: policy.rules.length }),
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      </p>
                    </div>
                    <div className="people-actions">
                      <button
                        type="button"
                        className="button-secondary people-action"
                        aria-expanded={open === policy.id}
                        aria-label={t('notificationPolicies.manageOf', { name: policy.name })}
                        onClick={() => setOpen(open === policy.id ? null : policy.id)}
                      >
                        {t('notificationPolicies.manage')}
                      </button>
                    </div>
                    {open === policy.id && (
                      <PolicyPanel
                        policy={policy}
                        track={track}
                        lists={state.lists}
                        client={client}
                        put={put}
                        said={said}
                        failed={failed}
                        onUsed={() => void load()}
                        onDeleted={() => {
                          // The policy's row goes: the list's heading takes the focus.
                          setOpen(null);
                          setState((was) =>
                            was.status === 'loaded'
                              ? {
                                  ...was,
                                  policies: was.policies.filter((p) => p.id !== policy.id),
                                }
                              : was,
                          );
                          listHeading.current?.focus();
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

/** A new policy: its name, what it is for, and the rules it starts with. */
function NewPolicy({
  client,
  track,
  policies,
  failed,
  onCancel,
  onAdded,
}: {
  client: PoliciesClient;
  track: ScopeTrack | null;
  policies: NotificationPolicy[];
  failed: (error: unknown) => void;
  onCancel: () => void;
  onAdded: (policy: NotificationPolicy) => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // A policy with no rules tells nobody anything: the default's rules are the usual start.
  const [from, setFrom] = useState(() => String(policies.find((p) => p.isDefault)?.id ?? ''));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    const source = policies.find((p) => String(p.id) === from);
    client
      .create({
        name: wanted,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(track ? { trackId: track.id } : {}),
        rules: source ? keptRules(source.rules) : [],
      })
      .then(onAdded, failed);
  };
  return (
    <form
      className="glass-card people-card people-inline"
      aria-label={t('notificationPolicies.addPolicy')}
      onSubmit={submit}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('notificationPolicies.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-about`} className="form-label">
          {t('notificationPolicies.description')}
        </label>
        <textarea
          id={`${id}-about`}
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-from`} className="form-label">
          {t('notificationPolicies.startWith')}
        </label>
        <select
          id={`${id}-from`}
          value={from}
          aria-describedby={`${id}-from-hint`}
          onChange={(e) => setFrom(e.target.value)}
        >
          <option value="">{t('notificationPolicies.startEmpty')}</option>
          {policies.map((p) => (
            <option key={p.id} value={p.id}>
              {t('notificationPolicies.startCopy', { name: p.name })}
            </option>
          ))}
        </select>
        <p id={`${id}-from-hint`} className="form-hint">
          {t('notificationPolicies.startHint')}
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('notificationPolicies.addPolicy')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('notificationPolicies.cancelNew')}
        </button>
      </div>
    </form>
  );
}

/** One policy open: its rules by event, a rule to add, its name, and Delete. */
function PolicyPanel({
  policy,
  track,
  lists,
  client,
  put,
  said,
  failed,
  onUsed,
  onDeleted,
}: Feedback & {
  policy: NotificationPolicy;
  track: ScopeTrack | null;
  lists: Lists;
  client: PoliciesClient;
  /** The track now uses this policy: the page reads who uses what again. */
  onUsed: () => void;
  /** The policy is gone: the list's heading takes the focus. */
  onDeleted: () => void;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // Events in the order people know them from their settings; transition events after.
  const known = lists.events.events;
  const events = [...new Set(policy.rules.map((r) => r.event))].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia !== -1 || ib !== -1)
      return (ia === -1 ? known.length : ia) - (ib === -1 ? known.length : ib);
    return a.localeCompare(b);
  });
  // A rule naming a field since deleted goes with the next change to the rules, and is said.
  const goneRules = policy.rules.filter(namesGoneField).length;
  /** Saves the rules kept plus those added; one kept that names a field since deleted goes. */
  const save = (keep: readonly PolicyRule[], added: RuleInput[], text: string) => {
    const dropped = keep.filter(namesGoneField).length;
    return client.update(policy.id, { rules: [...keptRules(keep), ...added] }).then((saved) => {
      put(saved);
      said(
        dropped > 0
          ? `${text} ${t('notificationPolicies.goneRulesRemoved', { count: dropped })}`
          : text,
      );
    });
  };
  const mayUse =
    track !== null &&
    policy.trackId === track.id &&
    !policy.usedBy.some((used) => used.id === track.id);
  return (
    <div className="people-panel">
      <h3 ref={heading} tabIndex={-1} className="facts-title">
        {t('notificationPolicies.rulesOf', { name: policy.name })}
      </h3>
      {goneRules > 0 && (
        <p className="form-hint">{t('notificationPolicies.goneRulesNote', { count: goneRules })}</p>
      )}
      {events.length === 0 ? (
        <EmptyState compact title={t('notificationPolicies.noRules')}>
          {t('notificationPolicies.noRulesBody')}
        </EmptyState>
      ) : (
        events.map((event, index) => {
          const label = eventLabel(t, event);
          return (
            <div key={event}>
              <p id={`${id}-event-${index}`} className="people-name">
                {label}
              </p>
              <ul className="visibility-members" aria-labelledby={`${id}-event-${index}`}>
                {policy.rules
                  .filter((rule) => rule.event === event)
                  .map((rule) => {
                    const recipient = recipientLabel(t, rule);
                    return (
                      <li key={rule.id} className="visibility-member">
                        <span>{recipient}</span>
                        <button
                          type="button"
                          className="button-secondary people-action"
                          aria-label={t('notificationPolicies.removeRule', {
                            recipient,
                            event: label,
                          })}
                          onClick={() => {
                            save(
                              policy.rules.filter((r) => r.id !== rule.id),
                              [],
                              t('notificationPolicies.ruleRemoved', { recipient, event: label }),
                            ).then(
                              // Its button is gone: the policy's rules heading takes the focus.
                              () => heading.current?.focus(),
                              failed,
                            );
                          }}
                        >
                          {t('notificationPolicies.remove')}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </div>
          );
        })
      )}
      <AddRule
        policy={policy}
        track={track}
        lists={lists}
        client={client}
        onAdd={(rule, labels) =>
          save(policy.rules, [rule], t('notificationPolicies.ruleAdded', labels)).then(
            () => true,
            (error: unknown) => {
              failed(error);
              return false;
            },
          )
        }
      />
      <Details policy={policy} client={client} put={put} said={said} failed={failed} />
      {mayUse && track && (
        <div className="sets-assign">
          <button
            type="button"
            className="button-secondary"
            aria-describedby={`${id}-use-hint`}
            onClick={() =>
              client.chooseFor(track.id, policy.id).then(() => {
                said(t('notificationPolicies.usedFor', { key: track.key, name: policy.name }));
                onUsed();
                heading.current?.focus();
              }, failed)
            }
          >
            {t('notificationPolicies.useFor', { key: track.key })}
          </button>
          <p id={`${id}-use-hint`} className="form-hint">
            {t('notificationPolicies.useHint')}
          </p>
        </div>
      )}
      {policy.isDefault ? (
        <p className="page-note">{t('notificationPolicies.defaultStays')}</p>
      ) : policy.usedBy.length > 0 ? (
        <p className="page-note">{t('notificationPolicies.inUseStays')}</p>
      ) : (
        <div className="people-actions">
          {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
          <DangerAction
            label={t('notificationPolicies.delete')}
            name={t('notificationPolicies.deleteOf', { name: policy.name })}
            outcome={t('notificationPolicies.confirmDelete', { name: policy.name })}
            confirmLabel={t('notificationPolicies.deleteOf', { name: policy.name })}
            onConfirm={async () => {
              try {
                await client.remove(policy.id);
              } catch (error) {
                failed(error);
                throw error;
              }
              said(t('notificationPolicies.deleted', { name: policy.name }));
              onDeleted();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A rule to add: the event, who hears of it, and the one person, group, role or field that kind
 * names. Kinds with nothing to choose from are not offered.
 */
function AddRule({
  policy,
  track,
  lists,
  client,
  onAdd,
}: {
  policy: NotificationPolicy;
  track: ScopeTrack | null;
  lists: Lists;
  client: PoliciesClient;
  /** Saves the rule; true once it is saved. */
  onAdd: (rule: RuleInput, labels: { recipient: string; event: string }) => Promise<boolean>;
}) {
  const t = useT();
  const id = useId();
  const userFields = lists.fields.filter((f) => f.type === 'user');
  const groupFields = lists.fields.filter((f) => f.type === 'group');
  const kinds = RECIPIENTS.filter((kind) =>
    kind === 'group'
      ? lists.groups.length > 0
      : kind === 'role'
        ? lists.roles.length > 0
        : kind === 'user_field'
          ? userFields.length > 0
          : kind === 'group_field'
            ? groupFields.length > 0
            : true,
  );
  const [event, setEvent] = useState(lists.events.events[0] ?? TYPED);
  const [typed, setTyped] = useState('');
  const [kind, setKind] = useState<Recipient>('assignee');
  const [target, setTarget] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<Choice[]>([]);
  const [error, setError] = useState<string | null>(null);

  const choicesOf = (of: Recipient): { value: string; name: string }[] =>
    of === 'group'
      ? lists.groups.map((g) => ({ value: String(g.id), name: g.name }))
      : of === 'role'
        ? lists.roles.map((r) => ({ value: String(r.id), name: r.name }))
        : of === 'user_field'
          ? userFields.map((f) => ({ value: f.key, name: f.name }))
          : of === 'group_field'
            ? groupFields.map((f) => ({ value: f.key, name: f.name }))
            : of === 'user'
              ? people.map((p) => ({ value: String(p.id), name: p.name }))
              : [];

  useEffect(() => {
    if (kind !== 'user') {
      setPeople([]);
      return;
    }
    if (query.trim() === '') {
      // No one is listed, so no one stays chosen: Add rule must not name a person not shown.
      setPeople([]);
      setTarget('');
      return;
    }
    let live = true;
    client.findPeople(query.trim(), track).then(
      (found) => {
        if (!live) return;
        setPeople(found);
        setTarget(String(found[0]?.id ?? ''));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, kind, query, track]);

  const targets = choicesOf(kind);
  const targetLabel: Record<string, MessageId> = {
    user: 'notificationPolicies.person',
    group: 'notificationPolicies.group',
    role: 'notificationPolicies.role',
    user_field: 'notificationPolicies.userField',
    group_field: 'notificationPolicies.groupField',
  };
  const submit = async (form: FormEvent) => {
    form.preventDefault();
    const name = event === TYPED ? typed.trim() : '';
    if (event === TYPED && !CUSTOM_NAME.test(name)) {
      setError(t('notificationPolicies.eventNameInvalid'));
      return;
    }
    const chosen = event === TYPED ? `${CUSTOM}${name}` : event;
    // Only one the choice shows: never a person left chosen from an earlier search.
    if (TARGETED.has(kind) && !targets.some((x) => x.value === target)) {
      setError(t('notificationPolicies.pickTarget'));
      return;
    }
    const rule: RuleInput = {
      event: chosen,
      recipient: kind,
      ...(kind === 'user' ? { userId: Number(target) } : {}),
      ...(kind === 'group' ? { groupId: Number(target) } : {}),
      ...(kind === 'role' ? { roleId: Number(target) } : {}),
      ...(kind === 'user_field' || kind === 'group_field' ? { fieldKey: target } : {}),
    };
    if (policy.rules.some((r) => sameRule(ruleInput(r), rule))) {
      setError(t('notificationPolicies.duplicate'));
      return;
    }
    setError(null);
    const named = targets.find((x) => x.value === target)?.name ?? '';
    const recipient = TARGETED.has(kind)
      ? t(`notificationPolicies.recipient.${kind}` as MessageId, { name: named })
      : kindLabel(t, kind);
    if (await onAdd(rule, { recipient, event: eventLabel(t, chosen) })) {
      // Ready for the next person on the same event.
      setQuery('');
      setTyped(event === TYPED ? typed : '');
    }
  };

  return (
    <form
      className="people-inline"
      aria-label={t('notificationPolicies.addRuleTo', { name: policy.name })}
      onSubmit={(form) => void submit(form)}
    >
      <div className="form-field">
        <label htmlFor={`${id}-event`} className="form-label">
          {t('notificationPolicies.event')}
        </label>
        <select
          id={`${id}-event`}
          value={event}
          onChange={(e) => {
            setEvent(e.target.value);
            setError(null);
          }}
        >
          <optgroup label={t('notificationPolicies.builtInEvents')}>
            {lists.events.events.map((name) => (
              <option key={name} value={name}>
                {eventLabel(t, name)}
              </option>
            ))}
          </optgroup>
          <optgroup label={t('notificationPolicies.transitionEvents')}>
            {lists.events.customEvents.map((name) => (
              <option key={name} value={name}>
                {eventLabel(t, name)}
              </option>
            ))}
            <option value={TYPED}>{t('notificationPolicies.otherEvent')}</option>
          </optgroup>
        </select>
      </div>
      {event === TYPED && (
        <div className="form-field">
          <label htmlFor={`${id}-typed`} className="form-label">
            {t('notificationPolicies.eventName')}
          </label>
          <input
            id={`${id}-typed`}
            type="text"
            maxLength={100}
            value={typed}
            aria-describedby={`${id}-typed-hint`}
            onChange={(e) => setTyped(e.target.value)}
          />
          <p id={`${id}-typed-hint`} className="form-hint">
            {t('notificationPolicies.eventNameHint')}
          </p>
        </div>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-kind`} className="form-label">
          {t('notificationPolicies.recipientKind')}
        </label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as Recipient;
            setKind(next);
            setTarget(choicesOf(next)[0]?.value ?? '');
            setError(null);
          }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {kindLabel(t, k)}
            </option>
          ))}
        </select>
      </div>
      {kind === 'user' && (
        <div className="form-field">
          <label htmlFor={`${id}-find`} className="form-label">
            {t('notificationPolicies.findPerson')}
          </label>
          <input
            id={`${id}-find`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {TARGETED.has(kind) && (
        <div className="form-field">
          <label htmlFor={`${id}-target`} className="form-label">
            {t(targetLabel[kind] as MessageId)}
          </label>
          <select id={`${id}-target`} value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.length === 0 && (
              <option value="">{t('notificationPolicies.personEmpty')}</option>
            )}
            {targets.map((x) => (
              <option key={x.value} value={x.value}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" className="button-secondary">
        {t('notificationPolicies.addRule')}
      </button>
    </form>
  );
}

/** A policy's name and what it is for. */
function Details({
  policy,
  client,
  put,
  said,
  failed,
}: Feedback & { policy: NotificationPolicy; client: PoliciesClient }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(policy.name);
  const [description, setDescription] = useState(policy.description);
  return (
    <form
      className="people-inline"
      aria-label={t('notificationPolicies.detailsOf', { name: policy.name })}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client
          .update(policy.id, { name: wanted, description: description.trim() })
          .then((saved) => {
            put(saved);
            said(t('notificationPolicies.detailsSaved', { name: saved.name }));
          }, failed);
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('notificationPolicies.name')}
        </label>
        <input
          id={`${id}-name`}
          type="text"
          required
          maxLength={255}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-about`} className="form-label">
          {t('notificationPolicies.description')}
        </label>
        <textarea
          id={`${id}-about`}
          rows={2}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <button type="submit" className="button-secondary">
        {t('notificationPolicies.saveDetails')}
      </button>
    </form>
  );
}
