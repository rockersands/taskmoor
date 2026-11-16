import { fromMarkdown, type PmJson } from '@taskmoor/richtext';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type AiFeatures, loadAiFeatures, useAiFeatures } from '../ai/AiFeature';
import { type AiNoticeClient, aiNoticeClient } from '../ai/AiNotice';
import type { AiClient, TicketDraft } from '../ai/client';
import { DraftFromText } from '../ai/DraftFromText';
import { ApiError, api } from '../api/client';
import { everyTrack } from '../api/tracks';
import { useT } from '../i18n/I18nProvider';
import { lockOfField, useLockText } from '../locks/useLockText';
import { type MentionSource, mentionSource } from '../richtext/mentions';
import { RichTextEditor } from '../richtext/RichTextEditor';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { IconSelect } from '../shell/IconSelect';
import { PageHeader } from '../shell/PageHeader';
import { priorityName } from '../shell/priorityName';
import { fieldName, typeName } from '../shell/seededNames';
import { PriorityGlyph, TypeGlyph } from '../shell/TicketIcons';
import { TrackSelect } from '../shell/TrackSelect';
import { type DuplicateLookup, DuplicateSuggestions } from './DuplicateSuggestions';
import {
  type CustomField,
  createBody,
  customId,
  EDITABLE_CUSTOM,
  EDITABLE_SYSTEM,
  errorMessage,
  type FormField,
  type FormValues,
  fieldErrors,
  PICKED_CUSTOM,
  PICKED_SYSTEM,
  SYSTEM_FIELDS,
  type TicketForm,
  trackThingOf,
} from './form';
import { PersonPicker, type PickedPerson } from './PersonPicker';
import { findFieldPeople, findGroups, findPeople, findTeams } from './pickerSources';
import { type AppliedTemplate, type PickerClient, pickerClient } from './templates/client';
import { SUBTICKET_RANK } from './templates/draft';
import { omitKeys } from './templates/start';
import { type PickedTemplate, TemplateOutcome, TemplatePicker } from './templates/TemplatePicker';
import { type PickedTicket, pickerQuery, ticketToolsClient } from './tools/client';
import { TicketPicker } from './tools/TicketPicker';

export interface TrackChoice {
  id: number;
  key: string;
  name: string;
  /** The colour its administrators gave it, edging its mark in the Track picker (T-255). */
  color?: string | null;
}
/** A release or an area the form offers. */
export interface NamedChoice {
  id: number;
  name: string;
}
export interface TypeChoice {
  id: number;
  name: string;
  icon?: string | null;
  /** Its hierarchy level (CORE-006), which says where its parent sits; absent in older fixtures. */
  level?: { rank: number };
}

/** The endpoints the page uses. Stories and some tests pass their own. */
export interface CreateClient {
  tracks: () => Promise<TrackChoice[]>;
  ticketTypes: (track: string) => Promise<{ defaultTypeId: number | null; types: TypeChoice[] }>;
  form: (track: string, ticketTypeId: number) => Promise<TicketForm>;
  priorities: () => Promise<{ id: number; name: string; level?: number }[]>;
  create: (body: Record<string, unknown>) => Promise<{ key: string }>;
  /** A ticket to start from (M1-052); the form offers it only when the client has it. */
  template?: (key: string) => Promise<TicketTemplate>;
  /** People to mention in rich text fields (M1-017); none when left out. */
  mentions?: (track: string) => MentionSource;
  /** Ticket templates (CORE-030); the form offers them only when the client has them. */
  ticketTemplates?: PickerClient;
  /**
   * The pickers' sources (T-253). A field whose source the client lacks stays as one the form
   * cannot set: people who may be given tickets in a track (the assignee); people for a custom
   * person field; tickets for the parent, from a query `pickerQuery` wrote; a track's releases
   * and areas.
   */
  assignable?: (track: string, typed: string) => Promise<PickedPerson[]>;
  people?: (track: string, typed: string) => Promise<PickedPerson[]>;
  tickets?: (query: string) => Promise<PickedTicket[]>;
  releases?: (trackId: number) => Promise<NamedChoice[]>;
  areas?: (trackId: number) => Promise<NamedChoice[]>;
  /**
   * More sources (T-265): the people a restricted person field allows for a ticket of a type in
   * a track (CORE-009 (2)); the site's groups for a group field; the site's teams whose name holds
   * what was typed (T-276).
   */
  fieldPeople?: (
    fieldId: number,
    track: string,
    ticketTypeId: number,
    typed: string,
  ) => Promise<PickedPerson[]>;
  groups?: (fieldId: number, typed: string) => Promise<NamedChoice[]>;
  teams?: (typed: string) => Promise<NamedChoice[]>;
}

export const createClient: CreateClient = {
  tracks: () => everyTrack<TrackChoice>(),
  ticketTypes: async (track) => {
    const res = await api<{ defaultTypeId: number | null; ticketTypes: TypeChoice[] }>(
      `/tracks/${encodeURIComponent(track)}/ticket-types`,
    );
    return { defaultTypeId: res.defaultTypeId, types: res.ticketTypes };
  },
  form: (track, ticketTypeId) =>
    api<TicketForm>(
      `/tracks/${encodeURIComponent(track)}/layout?ticketTypeId=${ticketTypeId}&operation=create`,
    ),
  priorities: async () =>
    (await api<{ priorities: { id: number; name: string; level?: number }[] }>('/priorities'))
      .priorities,
  create: async (body) =>
    (await api<{ ticket: { key: string } }>('/tickets', { method: 'POST', body })).ticket,
  mentions: (track) => mentionSource({ track }),
  ticketTemplates: pickerClient,
  assignable: (track, typed) => findPeople(track, typed, true),
  people: (track, typed) => findPeople(track, typed),
  tickets: (query) => ticketToolsClient.pick(query),
  releases: async (trackId) =>
    (await api<{ releases: NamedChoice[] }>(`/tracks/${trackId}/releases`)).releases.map((r) => ({
      id: r.id,
      name: r.name,
    })),
  areas: async (trackId) =>
    (await api<{ areas: NamedChoice[] }>(`/tracks/${trackId}/areas`)).areas.map((a) => ({
      id: a.id,
      name: a.name,
    })),
  fieldPeople: findFieldPeople,
  groups: findGroups,
  teams: findTeams,
  template: async (key) =>
    templateOf(
      (await api<{ ticket: TemplateSource }>(`/tickets/${encodeURIComponent(key)}`)).ticket,
    ),
};

/** What the create form takes from a ticket it starts from. */
export interface TicketTemplate {
  track: string;
  ticketTypeId: number;
  values: FormValues;
  docs: Record<string, PmJson | null>;
}

/** The parts of `GET /api/v1/tickets/:key` a template uses. */
export interface TemplateSource {
  track: { key: string };
  ticketType: { id: number };
  summary: string;
  description?: PmJson | null;
  environment?: PmJson | null;
  priority: { id: number } | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
}

/**
 * A ticket as a template (M1-052): its track and type, words, priority, labels and dates.
 * People, releases and custom fields are not copied: they are the new ticket's own.
 */
export function templateOf(ticket: TemplateSource): TicketTemplate {
  const values: FormValues = { summary: ticket.summary };
  if (ticket.priority) values.priority = String(ticket.priority.id);
  if (ticket.labels.length > 0) values.labels = ticket.labels.join(' ');
  if (ticket.startDate) values.startDate = ticket.startDate;
  if (ticket.dueDate) values.dueDate = ticket.dueDate;
  const docs: Record<string, PmJson | null> = {};
  if (ticket.description) docs.description = ticket.description;
  if (ticket.environment) docs.environment = ticket.environment;
  return { track: ticket.track.key, ticketTypeId: ticket.ticketType.id, values, docs };
}

/** No one found: what a picker without its source offers. */
const none = (): Promise<PickedPerson[]> => Promise.resolve([]);

/** Fields written in the rich text editor (M1-017). */
const RICH_TYPES = new Set(['description', 'environment', 'paragraph']);

type Loaded<T> = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; value: T };

/** The custom field a layout key names, when the form has it. */
function customField(form: TicketForm, key: string): CustomField | undefined {
  const id = customId(key);
  return id === null ? undefined : form.customFields.find((f) => f.id === id);
}

/**
 * How the form sets a field: a control of its own, a set of checkboxes, a picker (people, the
 * parent, releases, areas, groups, teams; T-253, T-265), or not at all: either the person may not
 * (`withheld`, IAM-010) or the form has no way to (`unset`).
 */
type Kind = 'control' | 'multiple' | 'picker' | 'withheld' | 'unset';

/** The system fields whose picker has a source in this client. */
function pickableKeys(client: CreateClient): Set<string> {
  const out = new Set<string>();
  if (client.assignable) out.add('assignee');
  if (client.people) out.add('requester');
  if (client.tickets) out.add('parent');
  if (client.releases) out.add('targetRelease').add('foundInRelease');
  if (client.areas) out.add('area');
  return out;
}

/** Whether this client has the source a custom field's picker needs. */
function customPickable(custom: CustomField, client: CreateClient): boolean {
  switch (custom.type) {
    case 'user':
      // A restricted field offers only whom it allows (CORE-009 (2)), so it needs its own list.
      return Boolean(custom.restricted ? client.fieldPeople : client.people);
    case 'group':
      return Boolean(client.groups);
    case 'team':
      return Boolean(client.teams);
    case 'release':
      return Boolean(client.releases);
    case 'area':
      return Boolean(client.areas);
    default:
      return false;
  }
}

/** The kind of list a field chooses from, when it is a list of the track's. */
type ListKind = 'release' | 'area';
function listKindOf(field: FormField, custom: CustomField | undefined): ListKind | null {
  if (custom) return custom.type === 'release' || custom.type === 'area' ? custom.type : null;
  if (field.key === 'area') return 'area';
  return RELEASE_KEYS.has(field.key) ? 'release' : null;
}

function kindOf(
  form: TicketForm,
  field: FormField,
  custom: CustomField | undefined,
  client: CreateClient,
): Kind {
  if (form.withheld?.includes(field.key)) return 'withheld';
  if (custom) {
    if (custom.type === 'select' && custom.multiple) return 'multiple';
    if (EDITABLE_CUSTOM.has(custom.type)) return 'control';
    return PICKED_CUSTOM.has(custom.type) && customPickable(custom, client) ? 'picker' : 'unset';
  }
  if (EDITABLE_SYSTEM.has(field.key)) return 'control';
  return PICKED_SYSTEM.has(field.key) && pickableKeys(client).has(field.key) ? 'picker' : 'unset';
}

/**
 * The fields that have a row on the form: those it sets, and those required at create that it
 * cannot set (D30 leaves out only what is set after creation).
 */
function shownKeys(form: TicketForm, client: CreateClient): Set<string> {
  const out = new Set<string>();
  for (const field of form.layout.tabs.flatMap((tab) => tab.sections.flatMap((s) => s.fields))) {
    const kind = kindOf(form, field, customField(form, field.key), client);
    if (kind === 'control' || kind === 'multiple' || kind === 'picker' || field.required) {
      out.add(field.key);
    }
  }
  return out;
}

/** The release fields, whose picker lists the track's releases. */
const RELEASE_KEYS = new Set(['targetRelease', 'foundInRelease']);
/** Durations typed as time tracking reads them ('2h 30m'). */
const ESTIMATES = new Set(['originalEstimate', 'remainingEstimate']);

/** The keys of a layout, to know which pickers need their lists. */
const layoutKeys = (form: TicketForm) =>
  new Set(form.layout.tabs.flatMap((t) => t.sections.flatMap((s) => s.fields.map((f) => f.key))));

/**
 * The lists a laid-out form chooses from: the track's releases and areas. Teams are searched by
 * name instead, as a site can have many (T-276).
 */
function wantedLists(form: TicketForm): Set<ListKind> {
  const keys = layoutKeys(form);
  const out = new Set<ListKind>();
  if (keys.has('targetRelease') || keys.has('foundInRelease')) out.add('release');
  if (keys.has('area')) out.add('area');
  for (const field of form.customFields) {
    if (!keys.has(`cf[${field.id}]`)) continue;
    if (field.type === 'release' || field.type === 'area') out.add(field.type);
  }
  return out;
}

/**
 * The fields of a laid-out form whose pickers a template's values can fill: the system ones this
 * client has a source for, and the custom person, group, team, release and area fields (T-276).
 */
function templatePickable(form: TicketForm, client: CreateClient): Set<string> {
  const out = pickableKeys(client);
  for (const key of layoutKeys(form)) {
    const custom = customField(form, key);
    if (custom && PICKED_CUSTOM.has(custom.type) && customPickable(custom, client)) out.add(key);
  }
  return out;
}

/**
 * What the Parent picker looks among (spec 01a section 1.2): tickets one level above the type's,
 * and for a subticket only in its own track, as the create route checks. Unknown without the
 * type's level.
 */
function parentScope(type: TypeChoice | undefined, track: string) {
  const rank = type?.level?.rank;
  if (rank === undefined) return null;
  return { level: rank + 1, ...(rank === SUBTICKET_RANK ? { trackKey: track } : {}) };
}

export interface CreateTicketPageProps {
  client?: CreateClient;
  /** In the create dialog (M1-052): a second-level heading with this id, and a close button. */
  variant?: 'page' | 'dialog';
  titleId?: string;
  onClose?: () => void;
  /** Drafts from text and duplicate suggestions (M1-079); the API's by default. */
  ai?: {
    client?: AiClient;
    notice?: AiNoticeClient;
    features?: (trackId?: number) => Promise<AiFeatures>;
    duplicates?: DuplicateLookup;
  };
}

/**
 * Creating a ticket (#/create; M1-012, CORE-008, CORE-013): the create form of the chosen
 * track and ticket type as the backend lays it out, required fields marked, hidden ones absent,
 * and the backend's refusals shown at each field. People, the parent, releases and areas are
 * chosen with pickers (T-253): the assignee among those who may be given tickets in the track.
 * Fields the person may not set at create (IAM-010), and those this form has no way to set, are
 * left out and set on the ticket once it exists (D30), unless the layout requires them at
 * create: those stay, saying why, so a refusal has a place.
 */
export function CreateTicketPage({
  client = createClient,
  variant = 'page',
  titleId: givenTitleId,
  onClose,
  ai = {},
}: CreateTicketPageProps) {
  const t = useT();
  const lockText = useLockText();
  const ownTitleId = useId();
  const titleId = givenTitleId ?? ownTitleId;
  const prefix = useId();
  const [tracks, setTracks] = useState<Loaded<TrackChoice[]>>({ status: 'loading' });
  const [track, setTrack] = useState('');
  const [types, setTypes] = useState<TypeChoice[]>([]);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [form, setForm] = useState<Loaded<TicketForm> | null>(null);
  const [priorities, setPriorities] = useState<{ id: number; name: string; level?: number }[]>([]);
  const [values, setValues] = useState<FormValues>({});
  // People chosen in person pickers, by field key, and the parent chosen (T-253).
  const [picks, setPicks] = useState<Record<string, PickedPerson[]>>({});
  const [parent, setParent] = useState<PickedTicket | null>(null);
  // Focus follows the parent's control as it swaps: to Remove once one is picked, back to the
  // search field once it is removed, so keyboard and screen-reader users keep their place.
  const focusParentRemove = useRef(false);
  const [focusParentSearch, setFocusParentSearch] = useState(false);
  useEffect(() => {
    if (focusParentSearch) setFocusParentSearch(false);
  }, [focusParentSearch]);
  // The track's releases and areas once a form that places them is here; null until then.
  const [releases, setReleases] = useState<NamedChoice[] | null>(null);
  const [areas, setAreas] = useState<NamedChoice[] | null>(null);
  // Rich text fields' documents, by field key; a new form key gives empty editors.
  const [docs, setDocs] = useState<Record<string, PmJson | null>>({});
  // What rich text editors start with: a template's documents, until the next clear.
  const [seed, setSeed] = useState<Record<string, PmJson | null>>({});
  const [templateKey, setTemplateKey] = useState('');
  const [formKey, setFormKey] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  /** The ticket just created, to open it (M1-051). */
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PickedTemplate | null>(null);
  const [outcome, setOutcome] = useState<AppliedTemplate | null>(null);
  // A template fits the track and type it was chosen for; what it filled in stays as typed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the choice changes
  useEffect(() => setPicked(null), [track, typeId]);
  const trackId =
    tracks.status === 'loaded' ? tracks.value.find((k) => k.key === track)?.id : undefined;
  // Re-ranked duplicates with reasons only where the feature is on and the AI notice was read:
  // the summary goes to the provider then. Embedding suggestions need neither (NFR-011).
  const aiFeatures = useAiFeatures(trackId, ai.features ?? loadAiFeatures);
  const noticeClient = ai.notice ?? aiNoticeClient;
  const [noticeRead, setNoticeRead] = useState(false);
  const rerankable = aiFeatures.duplicates?.available === true;
  useEffect(() => {
    if (!rerankable) return;
    let live = true;
    noticeClient.notice().then(
      (n) => live && setNoticeRead(n.acknowledgedAt !== null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rerankable, noticeClient]);

  /** Fills the form with an AI draft; the person reviews it and presses Create (AI-015). */
  const applyDraft = (draft: TicketDraft) => {
    if (draft.ticketType && types.some((k) => k.id === draft.ticketType?.id)) {
      setTypeId(draft.ticketType.id);
    }
    const next: FormValues = { ...values, summary: draft.summary };
    if (draft.priority) next.priority = String(draft.priority.id);
    if (draft.labels.length > 0) next.labels = draft.labels.join(' ');
    setValues(next);
    if (draft.description.trim()) {
      const doc = fromMarkdown(draft.description);
      setDocs((d) => ({ ...d, description: doc }));
      setSeed((d) => ({ ...d, description: doc }));
    }
    setFormKey((k) => k + 1);
    setMessage(t('ai.draft.used'));
  };

  useEffect(() => {
    let live = true;
    Promise.all([client.tracks(), client.priorities().catch(() => [])])
      .then(([list, prios]) => {
        if (!live) return;
        setTracks({ status: 'loaded', value: list });
        setPriorities(prios);
        if (list.length > 0) setTrack(list[0]?.key ?? '');
      })
      .catch(() => live && setTracks({ status: 'failed' }));
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (track === '') return;
    let live = true;
    client
      .ticketTypes(track)
      .then((res) => {
        if (!live) return;
        setTypes(res.types);
        // A type chosen while the track's list was on its way stays when the track offers it.
        setTypeId((chosen) =>
          chosen !== null && res.types.some((type) => type.id === chosen)
            ? chosen
            : (res.defaultTypeId ?? res.types[0]?.id ?? null),
        );
      })
      .catch(() => live && setForm({ status: 'failed' }));
    return () => {
      live = false;
    };
  }, [client, track]);

  // The form of the track and type chosen now: an answer for an earlier choice that comes late
  // is dropped, or it would show another type's fields under this one's name.
  const latestForm = useRef(0);
  const loadForm = useCallback(async () => {
    if (track === '' || typeId === null) return;
    const asked = ++latestForm.current;
    setForm({ status: 'loading' });
    setErrors({});
    try {
      const value = await client.form(track, typeId);
      if (asked === latestForm.current) setForm({ status: 'loaded', value });
    } catch {
      if (asked === latestForm.current) setForm({ status: 'failed' });
    }
  }, [client, track, typeId]);

  useEffect(() => {
    void loadForm();
  }, [loadForm]);

  // The track's releases and areas, asked for when the form places them (T-253). A list that
  // fails to load offers nothing, and the backend still checks what is sent.
  const lists = form?.status === 'loaded' ? wantedLists(form.value) : new Set<ListKind>();
  const wantsReleases = lists.has('release');
  const wantsAreas = lists.has('area');
  useEffect(() => {
    setReleases(null);
    if (trackId === undefined || !wantsReleases || !client.releases) return;
    let live = true;
    client.releases(trackId).then(
      (list) => live && setReleases(list),
      () => live && setReleases([]),
    );
    return () => {
      live = false;
    };
  }, [client, trackId, wantsReleases]);
  useEffect(() => {
    setAreas(null);
    if (trackId === undefined || !wantsAreas || !client.areas) return;
    let live = true;
    client.areas(trackId).then(
      (list) => live && setAreas(list),
      () => live && setAreas([]),
    );
    return () => {
      live = false;
    };
  }, [client, trackId, wantsAreas]);

  // Where the parent is looked for, by the chosen type's level; a parent chosen for another
  // level is let go when the type changes to one it cannot sit above.
  const chosenType = types.find((type) => type.id === typeId);
  const scope = parentScope(chosenType, track);
  const scopeKey = scope ? `${scope.level}:${scope.trackKey ?? ''}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the scope changes
  useEffect(() => setParent(null), [scopeKey]);

  const set = (key: string, value: string | string[]) => setValues((v) => ({ ...v, [key]: value }));
  const loadedForm = form?.status === 'loaded' ? form.value : null;
  // The pickers a template's values can fill: the system ones, and the custom ones (T-276).
  const pickable = useMemo(
    () => (loadedForm ? templatePickable(loadedForm, client) : pickableKeys(client)),
    [loadedForm, client],
  );
  // The ids the release and area pickers offer, system and custom ones, by field key, for a
  // template's values to fill them (T-265, T-276).
  const offered = useMemo(() => {
    const out: Record<string, number[]> = {};
    const releaseIds = releases?.map((r) => r.id);
    const areaIds = areas?.map((a) => a.id);
    if (releaseIds) for (const key of RELEASE_KEYS) out[key] = releaseIds;
    if (areaIds) out.area = areaIds;
    for (const field of loadedForm?.customFields ?? []) {
      const ids = field.type === 'release' ? releaseIds : field.type === 'area' ? areaIds : null;
      if (ids) out[`cf[${field.id}]`] = ids;
    }
    return out;
  }, [releases, areas, loadedForm]);
  /** The list a list picker offers; null while it loads, or for no list. */
  const listOf = (kind: ListKind | null) =>
    kind === 'area' ? areas : kind === 'release' ? releases : null;
  const mentions = useMemo(
    () => (track === '' ? undefined : client.mentions?.(track)),
    [client, track],
  );
  const clearForm = () => {
    setValues({});
    setPicks({});
    setParent(null);
    setDocs({});
    setSeed({});
    setFormKey((k) => k + 1);
  };

  // Starting from a ticket: its track and type are chosen, its values filled in.
  const copyFrom = async (event: FormEvent) => {
    event.preventDefault();
    const key = templateKey.trim().toUpperCase();
    if (!key || !client.template) return;
    setProblem(null);
    try {
      const from = await client.template(key);
      setTypeId(from.ticketTypeId);
      if (from.track !== track) {
        setTypes([]);
        setTrack(from.track);
      }
      setPicked(null);
      setValues(from.values);
      setPicks({});
      setParent(null);
      setDocs(from.docs);
      setSeed(from.docs);
      setFormKey((k) => k + 1);
      setErrors({});
      setMessage(t('tickets.create.copied', { key }));
    } catch {
      setProblem(t('tickets.create.templateMissing', { key }));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form?.status !== 'loaded' || typeId === null) return;
    setBusy(true);
    setProblem(null);
    setMessage('');
    setCreated(null);
    setOutcome(null);
    setErrors({});
    try {
      // What the pickers hold joins what was typed, as ids (T-253).
      const chosen: FormValues = { ...values };
      for (const [key, people] of Object.entries(picks)) {
        const custom = customField(form.value, key);
        chosen[key] = custom?.multiple
          ? people.map((p) => String(p.id))
          : people[0]
            ? String(people[0].id)
            : '';
      }
      if (parent) chosen.parent = String(parent.id);
      const body = createBody(track, typeId, form.value, chosen, docs);
      let made: { key: string };
      if (picked && client.ticketTemplates) {
        const applied = await client.ticketTemplates.apply(picked.template.id, {
          ...body,
          omit: omitKeys(picked.start, form.value, body, picked.off, picked.picked),
          subtickets: picked.subtickets,
        });
        setOutcome(applied);
        made = applied;
      } else {
        made = await client.create(body);
      }
      setPicked(null);
      clearForm();
      setMessage(t('tickets.create.created', { key: made.key }));
      setCreated(made.key);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { fields?: Record<string, string> }) : null;
      if (body?.fields) {
        setErrors(fieldErrors(body.fields));
        setProblem(t('tickets.create.fixErrors'));
      } else {
        setProblem(t('tickets.create.createFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (key: string, custom: CustomField | undefined) => {
    const system = SYSTEM_FIELDS[key];
    return custom ? fieldName(t, custom.name) : system ? t(system.label) : key;
  };
  const labelOf = (field: FormField, custom: CustomField | undefined) => {
    const name = nameOf(field.key, custom);
    return field.required ? t('tickets.create.requiredLabel', { label: name }) : name;
  };

  function control(
    field: FormField,
    custom: CustomField | undefined,
    id: string,
    described: string,
    locked: boolean,
  ) {
    const value = values[field.key];
    const text = typeof value === 'string' ? value : '';
    const common = {
      id,
      'aria-describedby': described || undefined,
      'aria-required': field.required || undefined,
      'aria-invalid': errors[field.key] ? true : undefined,
      // A field the person may not set (M1-029) shows, read-only, with the reason beside it.
      disabled: locked || undefined,
    };
    const type = custom?.type ?? field.key;
    if (RICH_TYPES.has(type)) {
      return (
        <RichTextEditor
          key={`${formKey}:${field.key}`}
          labelledBy={`${id}-label`}
          describedBy={described || undefined}
          required={field.required}
          invalid={Boolean(errors[field.key])}
          editable={!locked}
          initial={seed[field.key] ?? null}
          onChange={(doc) => setDocs((d) => ({ ...d, [field.key]: doc }))}
          mentions={mentions}
        />
      );
    }
    if (type === 'startDate' || type === 'dueDate' || type === 'date') {
      return (
        <input
          {...common}
          type="date"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'datetime') {
      return (
        <input
          {...common}
          type="datetime-local"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'number') {
      return (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => set(field.key, e.target.value)}
        />
      );
    }
    if (type === 'priority') {
      // No empty choice: a ticket always has a priority, and the form shows the one it would get.
      const prioritySet = form?.status === 'loaded' ? form.value.priorities : undefined;
      const offered = prioritySet
        ? priorities.filter((p) => prioritySet.offered.includes(p.id))
        : priorities;
      return (
        <IconSelect
          id={id}
          aria-describedby={described || undefined}
          aria-required={field.required || undefined}
          aria-invalid={errors[field.key] ? true : undefined}
          disabled={locked || undefined}
          value={text || String(prioritySet?.defaultId ?? '')}
          options={offered.map((p) => ({
            value: String(p.id),
            label: priorityName(t, p.name),
            icon: <PriorityGlyph level={p.level} />,
          }))}
          onChange={(next) => set(field.key, next)}
        />
      );
    }
    if (type === 'select' && !custom?.multiple) {
      const options = custom?.options ?? [];
      return (
        <select {...common} value={text} onChange={(e) => set(field.key, e.target.value)}>
          <option value="">{t('tickets.create.none')}</option>
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {o.value}
            </option>
          ))}
        </select>
      );
    }
    if (type === 'cascading-select') {
      const parent = (custom?.options ?? []).find((o) => String(o.id) === text);
      const childValue = values[`${field.key}/child`];
      return (
        <div className="create-cascade">
          <select
            {...common}
            value={text}
            onChange={(e) => {
              set(field.key, e.target.value);
              set(`${field.key}/child`, '');
            }}
          >
            <option value="">{t('tickets.create.none')}</option>
            {(custom?.options ?? []).map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.value}
              </option>
            ))}
          </select>
          {parent && (parent.children?.length ?? 0) > 0 && (
            <select
              aria-label={t('tickets.create.childOption', { label: custom?.name ?? '' })}
              disabled={locked}
              value={typeof childValue === 'string' ? childValue : ''}
              onChange={(e) => set(`${field.key}/child`, e.target.value)}
            >
              <option value="">{t('tickets.create.none')}</option>
              {(parent.children ?? []).map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.value}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }
    return (
      <input
        {...common}
        type={type === 'url' ? 'url' : 'text'}
        value={text}
        onChange={(e) => set(field.key, e.target.value)}
      />
    );
  }

  /**
   * Where a person, group or team picker looks (T-253, T-265, T-276): those who may be given
   * tickets for the assignee; anyone for the requester and a person field, unless the field
   * allows only some (CORE-009 (2)); the site's groups for a group field, its teams for a team
   * field.
   */
  function searchOf(field: FormField, custom: CustomField | undefined) {
    return (typed: string): Promise<PickedPerson[]> => {
      if (custom?.type === 'group') return client.groups?.(custom.id, typed) ?? none();
      if (custom?.type === 'team') return client.teams?.(typed) ?? none();
      if (custom?.restricted) {
        return typeId === null || !client.fieldPeople
          ? none()
          : client.fieldPeople(custom.id, track, typeId, typed);
      }
      const search = field.key === 'assignee' ? client.assignable : client.people;
      return search?.(track, typed) ?? none();
    };
  }

  /** The hint under a person picker that differs from the usual one. */
  function personHint(field: FormField, custom: CustomField | undefined) {
    if (field.key === 'requester') return t('tickets.create.requesterHint');
    if (custom?.restricted) return t('tickets.create.restrictedHint');
    return undefined;
  }

  /**
   * People, the parent, releases, areas, groups or teams (T-253, T-265): each with the picker the
   * app has for it.
   */
  function picker(
    field: FormField,
    custom: CustomField | undefined,
    id: string,
    label: string,
    described: string,
    locked: boolean,
  ) {
    const invalid = Boolean(errors[field.key]);
    const listKind = listKindOf(field, custom);
    if (field.key !== 'parent' && listKind === null) {
      const hint = personHint(field, custom);
      return (
        <PersonPicker
          label={label}
          search={searchOf(field, custom)}
          chosen={picks[field.key] ?? []}
          onChange={(people) => setPicks((p) => ({ ...p, [field.key]: people }))}
          multiple={custom?.multiple ?? false}
          kind={custom?.type === 'group' ? 'groups' : custom?.type === 'team' ? 'teams' : 'people'}
          {...(hint ? { hint } : {})}
          describedBy={described}
          required={field.required}
          invalid={invalid}
          disabled={locked}
        />
      );
    }
    if (field.key === 'parent') {
      if (parent) {
        return (
          <fieldset aria-describedby={described || undefined} className="create-parent">
            <legend className="form-label">{label}</legend>
            <p className="create-parent-chosen">
              <span>
                {parent.key} {parent.summary}
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={locked}
                aria-label={t('tickets.create.removeParent', { key: parent.key })}
                ref={(button) => {
                  if (!button || !focusParentRemove.current) return;
                  focusParentRemove.current = false;
                  button.focus();
                }}
                onClick={() => {
                  setParent(null);
                  setFocusParentSearch(true);
                }}
              >
                {t('tickets.pickers.removeShort')}
              </button>
            </p>
          </fieldset>
        );
      }
      return (
        <TicketPicker
          label={label}
          hint={t(
            scope === null
              ? 'tickets.create.parentHint'
              : scope.trackKey
                ? 'tickets.create.parentHintTrack'
                : 'tickets.create.parentHintLevel',
          )}
          search={(typed) => {
            const query = pickerQuery(typed, scope ?? {});
            return query && client.tickets ? client.tickets(query) : Promise.resolve([]);
          }}
          onPick={(ticket) => {
            focusParentRemove.current = true;
            setParent(ticket);
          }}
          autoFocus={focusParentSearch}
          describedBy={described}
          required={field.required}
          invalid={invalid}
          disabled={locked}
        />
      );
    }
    // Releases and areas: one checkbox each, as for a field that holds several options; a custom
    // field that holds one is a list to choose one from.
    const options = listOf(listKind);
    const chosen = values[field.key];
    const emptyId = `${id}-empty`;
    const empty = options !== null && options.length === 0;
    const emptyNote = empty && (
      <p id={emptyId} className="form-hint">
        {t(listKind === 'area' ? 'tickets.create.noAreas' : 'tickets.create.noReleases')}
      </p>
    );
    if (custom && !custom.multiple) {
      return (
        <>
          <label htmlFor={id} className="form-label">
            {label}
          </label>
          <select
            id={id}
            aria-describedby={
              [empty ? emptyId : '', described].filter(Boolean).join(' ') || undefined
            }
            aria-required={field.required || undefined}
            aria-invalid={invalid || undefined}
            disabled={locked || undefined}
            value={typeof chosen === 'string' ? chosen : ''}
            onChange={(e) => set(field.key, e.target.value)}
          >
            <option value="">{t('tickets.create.none')}</option>
            {(options ?? []).map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.name}
              </option>
            ))}
          </select>
          {emptyNote}
        </>
      );
    }
    const list = Array.isArray(chosen) ? chosen : [];
    return (
      <fieldset
        className="create-choices"
        aria-describedby={[empty ? emptyId : '', described].filter(Boolean).join(' ') || undefined}
        disabled={locked}
      >
        <legend className="form-label">{label}</legend>
        {(options ?? []).map((o) => (
          <label key={o.id} className="create-choice">
            <input
              type="checkbox"
              checked={list.includes(String(o.id))}
              onChange={(e) =>
                set(
                  field.key,
                  e.target.checked
                    ? [...list, String(o.id)]
                    : list.filter((x) => x !== String(o.id)),
                )
              }
            />
            {o.name}
          </label>
        ))}
        {emptyNote}
      </fieldset>
    );
  }

  function fieldRow(field: FormField, loaded: TicketForm) {
    const id = `${prefix}-${field.key}`;
    const custom = customField(loaded, field.key);
    const label = labelOf(field, custom);
    const help = field.description ?? (custom?.description || null);
    const error = errors[field.key];
    // What a field expects, where its control cannot show it: labels, a duration, a number.
    const hint =
      field.key === 'labels' || custom?.type === 'labels'
        ? t('tickets.create.labelsHint')
        : ESTIMATES.has(field.key)
          ? t('tickets.create.estimateHint')
          : custom?.type === 'number'
            ? t('tickets.create.numberHint')
            : null;
    const lock = lockOfField(loaded.locks, field.key);
    const helpId = help || hint ? `${id}-help` : '';
    const lockId = lock ? `${id}-lock` : '';
    const errorId = error ? `${id}-error` : '';
    const described = [helpId, lockId, errorId].filter(Boolean).join(' ');
    const kind = kindOf(loaded, field, custom, client);
    const multiple = kind === 'multiple';
    // A field set only once the ticket exists is left out, Close reason among them (PL-20, D30),
    // and so is one the person may not set at create (IAM-010).
    if ((kind === 'unset' || kind === 'withheld') && !field.required) return null;
    // A track with no releases or areas has nothing to offer: an optional row goes too.
    const list = listOf(listKindOf(field, custom));
    if (kind === 'picker' && list?.length === 0 && !field.required) return null;
    if (kind === 'unset' || kind === 'withheld') {
      // Required at create, yet not to be set here: it stays, saying why, and the backend's
      // refusal shows here rather than nowhere.
      const noteId = `${id}-note`;
      return (
        <fieldset
          key={field.key}
          aria-describedby={[noteId, helpId, errorId].filter(Boolean).join(' ')}
          className="form-field create-unset"
        >
          <legend className="form-label">{label}</legend>
          <p id={noteId} className="form-hint">
            {t(kind === 'withheld' ? 'tickets.create.withheld' : 'tickets.create.notSetHere')}
          </p>
          {(help || hint) && (
            <p id={helpId || undefined} className="form-hint">
              {help ?? hint}
            </p>
          )}
          {error && (
            <p id={errorId} className="form-error">
              {t(errorMessage(error, trackThingOf(field.key, custom?.type)))}
            </p>
          )}
        </fieldset>
      );
    }
    return (
      <div key={field.key} className="form-field create-field">
        {kind === 'picker' ? (
          picker(field, custom, id, label, described, lock !== null)
        ) : multiple ? (
          <fieldset
            className="create-choices"
            aria-describedby={described || undefined}
            disabled={lock !== null}
          >
            <legend className="form-label">{label}</legend>
            {(custom?.options ?? []).map((o) => {
              const chosen = values[field.key];
              const list = Array.isArray(chosen) ? chosen : [];
              return (
                <label key={o.id} className="create-choice">
                  <input
                    type="checkbox"
                    checked={list.includes(String(o.id))}
                    onChange={(e) =>
                      set(
                        field.key,
                        e.target.checked
                          ? [...list, String(o.id)]
                          : list.filter((x) => x !== String(o.id)),
                      )
                    }
                  />
                  {o.value}
                </label>
              );
            })}
          </fieldset>
        ) : (
          <>
            {RICH_TYPES.has(custom?.type ?? field.key) ? (
              // A rich text editor is no form control: it names itself by this text's id.
              <span id={`${id}-label`} className="form-label rt-label">
                {label}
              </span>
            ) : (
              <label htmlFor={id} className="form-label">
                {label}
              </label>
            )}
            {control(field, custom, id, described, lock !== null)}
          </>
        )}
        {(help || hint) && (
          <p id={helpId || undefined} className="form-hint">
            {help ?? hint}
          </p>
        )}
        {field.key === 'summary' && (
          <DuplicateSuggestions
            text={typeof values.summary === 'string' ? values.summary : ''}
            track={track}
            reasons={rerankable && noticeRead}
            {...(ai.duplicates ? { lookup: ai.duplicates } : {})}
          />
        )}
        {lock && (
          <p id={lockId} className="form-hint">
            {lockText(lock)}
          </p>
        )}
        {error && (
          <p id={errorId} className="form-error">
            {t(errorMessage(error, trackThingOf(field.key, custom?.type)))}
          </p>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} className="page create-page">
      {variant === 'dialog' ? (
        <div className="create-dialog-head">
          <h2 id={titleId} className="page-title">
            {t('tickets.create.title')}
          </h2>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('tickets.create.close')}
          </button>
        </div>
      ) : (
        <PageHeader
          titleId={titleId}
          title={t('tickets.create.title')}
          purpose={t('purpose.createTicket')}
        />
      )}
      {client.template && tracks.status === 'loaded' && tracks.value.length > 0 && (
        <form
          className="create-template"
          aria-label={t('tickets.create.template')}
          onSubmit={(e) => void copyFrom(e)}
        >
          <div className="form-field">
            <label htmlFor={`${prefix}-template`} className="form-label">
              {t('tickets.create.templateKey')}
            </label>
            <input
              id={`${prefix}-template`}
              type="text"
              autoComplete="off"
              value={templateKey}
              onChange={(e) => setTemplateKey(e.target.value)}
            />
          </div>
          <button type="submit" className="button-secondary">
            {t('tickets.create.copy')}
          </button>
        </form>
      )}
      {tracks.status === 'loading' && (
        <p role="status" className="page-note">
          {t('tickets.create.loading')}
        </p>
      )}
      {tracks.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('tickets.create.failed')}
        </p>
      )}
      {tracks.status === 'loaded' && tracks.value.length === 0 && (
        <EmptyState compact title={t('tickets.create.noTracks')} />
      )}
      {tracks.status === 'loaded' && tracks.value.length > 0 && (
        <form
          className="create-form"
          data-tutorial="create-ticket-form"
          onSubmit={(e) => void submit(e)}
          noValidate
        >
          <div className="create-choosers">
            <div className="form-field">
              <label htmlFor={`${prefix}-track`} className="form-label">
                {t('tickets.create.track')}
              </label>
              <TrackSelect
                id={`${prefix}-track`}
                tracks={tracks.value}
                value={track}
                label={(k) => t('tickets.create.trackName', { key: k.key, name: k.name })}
                onChange={(next) => {
                  // The same track again changes nothing: its types are already here and
                  // would not load again (found by the fresh-install run, M1-113).
                  if (next === track) return;
                  setTrack(next);
                  clearForm();
                  // The old track's types until the new ones arrive would let a choice made
                  // meanwhile be overwritten, or sent with a type of the wrong track.
                  setTypes([]);
                  setTypeId(null);
                }}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`${prefix}-type`} className="form-label">
                {t('tickets.create.type')}
              </label>
              <IconSelect
                id={`${prefix}-type`}
                value={String(typeId ?? '')}
                options={types.map((k) => ({
                  value: String(k.id),
                  label: typeName(t, k.name),
                  icon: <TypeGlyph name={k.name} icon={k.icon} />,
                }))}
                onChange={(next) => setTypeId(Number(next))}
              />
            </div>
          </div>
          {client.ticketTemplates && (
            <TemplatePicker
              client={client.ticketTemplates}
              track={track}
              typeId={typeId}
              form={form?.status === 'loaded' ? form.value : null}
              picked={picked}
              pickable={pickable}
              offered={offered}
              onChange={setPicked}
              onPick={(next, fill) => {
                setPicked(next);
                setValues(fill?.values ?? {});
                setPicks(fill?.picks ?? {});
                setParent(null);
                setDocs(fill?.docs ?? {});
                setSeed(fill?.docs ?? {});
                setFormKey((k) => k + 1);
                setErrors({});
                setMessage(next ? t('tickets.templates.filled', { name: next.template.name }) : '');
              }}
            />
          )}
          <DraftFromText
            track={track}
            {...(trackId !== undefined ? { trackId } : {})}
            onUse={applyDraft}
            {...(ai.client ? { client: ai.client } : {})}
            {...(ai.notice ? { notice: ai.notice } : {})}
            {...(ai.features ? { features: ai.features } : {})}
          />
          {form?.status === 'loading' && (
            <p role="status" className="page-note">
              {t('tickets.create.loading')}
            </p>
          )}
          {form?.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('tickets.create.failed')}
            </p>
          )}
          {form?.status === 'loaded' &&
            form.value.layout.tabs.map((tab, i) => {
              const headingId = `${prefix}-tab-${i}`;
              const only = form.value.layout.tabs.length === 1;
              // Fields set only after creation are left out; a section or tab left empty goes too.
              const sections = tab.sections
                .map((section) => ({
                  section,
                  rows: section.fields.map((field) => fieldRow(field, form.value)).filter(Boolean),
                }))
                .filter((part) => part.rows.length > 0);
              if (sections.length === 0) return null;
              const name = tab.name ?? (only ? null : t('tickets.create.moreFields'));
              return (
                <section
                  // biome-ignore lint/suspicious/noArrayIndexKey: tabs have no id; their order is fixed
                  key={i}
                  // On the page a slab of its own; in the dialog a well, as glass is already there.
                  className={variant === 'dialog' ? 'create-tab' : 'glass-card create-tab'}
                  {...(name ? { 'aria-labelledby': headingId } : {})}
                >
                  {name && (
                    <h2 id={headingId} className="facts-title">
                      {name}
                    </h2>
                  )}
                  <div className="create-sections">
                    {sections.map(({ section, rows }, j) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id
                        key={j}
                        className={section.kind === 'context' ? 'create-context' : 'create-main'}
                      >
                        {rows}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          {problem && (
            <p role="alert" className="form-error">
              {problem}
              {/* Refusals of fields with no row on this form, by name. */}
              {form?.status === 'loaded' &&
                Object.entries(errors)
                  .filter(([key]) => !shownKeys(form.value, client).has(key))
                  .map(([key, code]) => (
                    <span key={key}>
                      {' '}
                      {t('tickets.create.fieldProblem', {
                        field: nameOf(key, customField(form.value, key)),
                        problem: t(
                          errorMessage(code, trackThingOf(key, customField(form.value, key)?.type)),
                        ),
                      })}
                    </span>
                  ))}
            </p>
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {created && (
            <p className="page-note">
              <a
                href={routeHref(`#/tickets/${encodeURIComponent(created)}`)}
                data-tutorial="ticket-created"
                onClick={onClose}
              >
                {t('tickets.create.open', { key: created })}
              </a>
            </p>
          )}
          {outcome && (
            <TemplateOutcome
              outcome={outcome}
              form={form?.status === 'loaded' ? form.value : null}
            />
          )}
          <div className="form-actions">
            <button
              type="submit"
              className="button-primary"
              disabled={busy || form?.status !== 'loaded'}
            >
              {busy ? t('tickets.create.creating') : t('tickets.create.submit')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
