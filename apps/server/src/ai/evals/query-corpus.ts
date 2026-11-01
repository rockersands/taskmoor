/**
 * Natural language to query: the eval corpus (M1-133; AI-014; ADR-107).
 *
 * Provenance: synthetic. Written for Taskmoor on 2026-11-01 by the M1-133 task, in our own
 * words, against the eval dataset (`dataset.ts`); no real query log or user data. The Spanish,
 * German and Japanese prompts were written for this corpus too, as people would type them.
 *
 * Each pair has a prompt, its language, the person who asks it and a reference query in
 * Taskmoor's native query language (`packages/query/src/fields.ts`, `functions.ts`). The
 * expected result is not written down: it is whatever the reference finds on the dataset as that
 * person, at the dataset's fixed "now" (`query-eval.ts`). A candidate scores a pair when its
 * query finds exactly the same tickets (in the same order where `ordered` is set).
 *
 * To add a pair: write the prompt and the reference, tag what it covers, and run the eval tests;
 * a reference must parse, resolve and find at least one ticket unless `expectEmpty` says why not.
 */
import type { Handle } from './model';

export type Coverage =
  | 'fields'
  | 'operators'
  | 'dates'
  | 'functions'
  | 'text'
  | 'order'
  | 'empty'
  | 'negation'
  | 'my'
  | 'this-week'
  | 'overdue'
  | 'unassigned'
  | 'history'
  | 'permissions';

export interface QueryPair {
  id: string;
  prompt: string;
  language: 'en' | 'es' | 'de' | 'ja';
  asUser: Handle;
  reference: string;
  /** The prompt asks for an order: results are compared in order. */
  ordered?: true;
  /** The reference finds nothing on purpose; the reason. */
  expectEmpty?: string;
  covers: readonly Coverage[];
}

type Row = [string, Handle, string, string, Coverage[], { ordered?: true; expectEmpty?: string }?];

const rows = (language: QueryPair['language'], list: Row[]): QueryPair[] =>
  list.map(([id, asUser, prompt, reference, covers, extra]) => ({
    id: `${language}-${id}`,
    language,
    asUser,
    prompt,
    reference,
    covers,
    ...(extra ?? {}),
  }));

const ENGLISH = rows('en', [
  [
    '001',
    'ana',
    'my open bugs updated this week',
    'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
    ['my', 'this-week', 'fields', 'negation'],
  ],
  ['002', 'ana', 'tickets assigned to me', 'assignee = currentUser()', ['my', 'functions']],
  ['003', 'ana', 'everything I reported', 'requester = currentUser()', ['my', 'functions']],
  [
    '004',
    'chen',
    'urgent tickets in the Platform API track',
    'track = API AND priority = Urgent',
    ['fields'],
  ],
  [
    '005',
    'grace',
    'high or urgent bugs in the web app',
    'track = WEB AND type = Bug AND priority IN (High, Urgent)',
    ['fields', 'operators'],
  ],
  ['006', 'ben', 'tickets in review', 'status = "In Review"', ['fields']],
  [
    '007',
    'ben',
    'closed tickets in the mobile track',
    'track = MOB AND stage = closed',
    ['fields'],
  ],
  [
    '008',
    'dara',
    'tickets nobody is assigned to in Platform API',
    'track = API AND assignee IS EMPTY',
    ['unassigned', 'empty'],
  ],
  [
    '009',
    'elif',
    'unassigned urgent or high priority tickets',
    'assignee IS EMPTY AND priority IN (Urgent, High)',
    ['unassigned', 'empty', 'operators'],
  ],
  [
    '010',
    'ana',
    'overdue tickets',
    'due < startOfDay() AND stage != closed',
    ['overdue', 'dates', 'functions'],
  ],
  [
    '011',
    'ben',
    'my overdue tickets',
    'assignee = currentUser() AND due < startOfDay() AND stage != closed',
    ['my', 'overdue'],
  ],
  [
    '012',
    'grace',
    'tickets due this week',
    'due >= startOfWeek() AND due <= endOfWeek()',
    ['this-week', 'dates'],
  ],
  [
    '013',
    'hiro',
    'open tickets due in the next 14 days',
    'due >= startOfDay() AND due <= endOfDay(14d) AND stage != closed',
    ['dates', 'functions'],
  ],
  ['014', 'ana', 'tickets created in the last 7 days', 'created >= -7d', ['dates']],
  [
    '015',
    'chen',
    'tickets updated this week in Operations',
    'track = OPS AND updated >= startOfWeek()',
    ['this-week', 'permissions'],
  ],
  [
    '016',
    'ben',
    'bugs created this month',
    'type = Bug AND created >= startOfMonth()',
    ['dates', 'functions'],
  ],
  ['017', 'grace', 'tickets closed in the last 30 days', 'closed >= -30d', ['dates']],
  [
    '018',
    'ana',
    'features planned for release 1.5',
    'type = Feature AND targetRelease = "1.5"',
    ['fields'],
  ],
  [
    '019',
    'chen',
    'tickets planned for a release that has not shipped yet',
    'targetRelease IN upcomingReleases()',
    ['functions'],
  ],
  [
    '020',
    'grace',
    'tickets in releases that already shipped',
    'targetRelease IN shippedReleases()',
    ['functions'],
  ],
  ['021', 'dara', 'bugs found in release 3.1', 'type = Bug AND foundInRelease = "3.1"', ['fields']],
  [
    '022',
    'ben',
    'web app tickets without a target release',
    'track = WEB AND targetRelease IS EMPTY',
    ['empty'],
  ],
  ['023', 'ana', 'tickets labelled regression', 'labels = regression', ['fields']],
  [
    '024',
    'elif',
    'tickets with the ios or android label',
    'labels IN (ios, android)',
    ['operators'],
  ],
  ['025', 'ben', 'web tickets that have no labels', 'track = WEB AND labels IS EMPTY', ['empty']],
  [
    '026',
    'grace',
    'customer-reported tickets that are still open',
    'labels = "customer-reported" AND stage != closed',
    ['fields', 'negation'],
  ],
  ['027', 'ana', 'tickets in the Checkout area', 'area = Checkout', ['fields']],
  ['028', 'chen', 'billing or webhooks tickets', 'area IN (Billing, Webhooks)', ['operators']],
  ['029', 'hiro', 'mobile tickets without an area', 'track = MOB AND area IS EMPTY', ['empty']],
  ['030', 'ben', 'tickets estimated at more than 3 points', 'Points > 3', ['operators']],
  ['031', 'ana', 'features estimated at 8 points', 'type = Feature AND Points = 8', ['fields']],
  [
    '032',
    'grace',
    'features with no points estimate',
    'type = Feature AND Points IS EMPTY',
    ['empty'],
  ],
  ['033', 'ben', 'tickets assigned to Ana', 'assignee = "Ana Ortiz"', ['fields']],
  [
    '034',
    'ana',
    'tickets assigned to Ben or Chen',
    'assignee IN ("Ben Okafor", "Chen Wei")',
    ['operators'],
  ],
  ['035', 'grace', 'tickets reported by Dara', 'requester = "Dara Kowalski"', ['fields']],
  [
    '036',
    'ana',
    'open tickets assigned to someone in the security group',
    'assignee IN membersOf("security") AND stage != closed',
    ['functions'],
  ],
  [
    '037',
    'elif',
    'tickets assigned to the mobile team',
    'assignee IN membersOf("mobile-team")',
    ['functions'],
  ],
  [
    '038',
    'ben',
    'tickets assigned to someone other than me',
    'assignee != currentUser()',
    ['my', 'negation'],
  ],
  ['039', 'grace', 'bugs that are not closed', 'type = Bug AND stage != closed', ['negation']],
  ['040', 'ana', 'tickets that are not bugs', 'type != Bug', ['negation']],
  [
    '041',
    'chen',
    'tickets outside the Platform API track',
    'track != API',
    ['negation', 'permissions'],
  ],
  [
    '042',
    'ben',
    'tickets that are in neither the web nor the mobile track',
    'track NOT IN (WEB, MOB)',
    ['negation', 'operators'],
  ],
  [
    '043',
    'dara',
    'open tickets that are not low priority',
    'stage != closed AND priority != Low',
    ['negation'],
  ],
  ['044', 'grace', 'tickets without a priority', 'priority IS EMPTY', ['empty']],
  ['045', 'ana', 'tickets that have a due date', 'due IS NOT EMPTY', ['empty', 'negation']],
  [
    '046',
    'hiro',
    'open mobile tickets with no due date',
    'track = MOB AND due IS EMPTY AND stage != closed',
    ['empty'],
  ],
  ['047', 'ben', 'tickets mentioning Safari', 'text ~ safari', ['text']],
  ['048', 'ana', 'tickets whose summary is about dark mode', 'summary ~ "dark mode"', ['text']],
  [
    '049',
    'grace',
    'tickets with the exact phrase "blank screen"',
    'text ~ "\\"blank screen\\""',
    ['text'],
  ],
  ['050', 'chen', 'tickets where a comment mentions staging', 'comment ~ staging', ['text']],
  ['051', 'dara', 'tickets that mention a timeout', 'text ~ timeout', ['text']],
  ['052', 'ben', 'tickets about CSV export', 'text ~ "csv export"', ['text']],
  [
    '053',
    'grace',
    'tickets that mention duplicate emails, newest first',
    'text ~ "duplicate emails" ORDER BY created DESC',
    ['text', 'order'],
    { ordered: true },
  ],
  [
    '054',
    'ana',
    'web tickets with a due date, earliest due first',
    'track = WEB AND due IS NOT EMPTY ORDER BY due ASC',
    ['order', 'empty'],
    { ordered: true },
  ],
  [
    '055',
    'ben',
    'tickets about payments, most relevant first',
    'text ~ payment ORDER BY relevance',
    ['text', 'order'],
    { ordered: true },
  ],
  [
    '056',
    'chen',
    'urgent tickets, most recently updated first',
    'priority = Urgent ORDER BY updated DESC',
    ['order'],
    { ordered: true },
  ],
  [
    '057',
    'grace',
    'open features sorted by priority, most important first',
    'type = Feature AND stage != closed ORDER BY priority DESC',
    ['order'],
    { ordered: true },
  ],
  [
    '058',
    'ana',
    'oldest open bugs first',
    'type = Bug AND stage != closed ORDER BY created ASC',
    ['order'],
    { ordered: true },
  ],
  [
    '059',
    'hiro',
    'mobile tickets with the most points first',
    'track = MOB AND Points IS NOT EMPTY ORDER BY Points DESC',
    ['order'],
    { ordered: true },
  ],
  ['060', 'ben', 'tickets I created', 'creator = currentUser()', ['my']],
  [
    '061',
    'dara',
    'tickets I changed this week',
    'key IN updatedBy(currentUser(), startOfWeek())',
    ['my', 'this-week', 'functions', 'history'],
  ],
  [
    '062',
    'ana',
    'tickets in tracks where I am a member',
    'track IN tracksWhereUserHasRole("Members")',
    ['functions', 'my'],
  ],
  ['063', 'chen', 'tickets in tracks I own', 'track IN tracksOwnedByUser()', ['functions', 'my']],
  ['064', 'grace', 'all outcomes', 'type = Outcome', ['fields']],
  ['065', 'ana', 'tickets under WEB-1', 'parent = WEB-1', ['fields']],
  [
    '066',
    'ben',
    'chores that are active or in review',
    'type = Chore AND status IN (Active, "In Review")',
    ['operators'],
  ],
  [
    '067',
    'dara',
    'tickets that were in review at some point',
    'status WAS "In Review"',
    ['history'],
  ],
  [
    '068',
    'ben',
    'tickets whose status changed this week',
    'status CHANGED AFTER startOfWeek()',
    ['history', 'this-week'],
  ],
  ['069', 'grace', 'tickets closed as duplicates', 'closeReason = Duplicate', ['fields']],
  ['070', 'ana', 'tickets closed as not planned', 'closeReason = "Not planned"', ['fields']],
  [
    '071',
    'elif',
    'open urgent bugs in Mobile apps, newest first',
    'track = MOB AND type = Bug AND priority = Urgent AND stage != closed ORDER BY created DESC',
    ['order', 'fields'],
    { ordered: true },
  ],
  ['072', 'hiro', 'tickets created before July 2026', 'created < 2026-07-01', ['dates']],
  [
    '073',
    'ana',
    'tickets created in August 2026',
    'created >= 2026-08-01 AND created < 2026-09-01',
    ['dates'],
  ],
  [
    '074',
    'ben',
    'open tickets due by the end of this month',
    'due <= endOfMonth() AND stage != closed',
    ['dates', 'functions'],
  ],
  [
    '075',
    'farid',
    'operations tickets nobody is assigned to',
    'track = OPS AND assignee IS EMPTY',
    ['unassigned', 'permissions'],
  ],
  [
    '076',
    'farid',
    'urgent tickets, newest first',
    'priority = Urgent ORDER BY created DESC',
    ['order', 'permissions'],
    { ordered: true },
  ],
  [
    '077',
    'ben',
    'is anything in the mobile track labelled docs?',
    'track = MOB AND labels = docs',
    ['fields'],
    { expectEmpty: 'no mobile ticket has the docs label' },
  ],
]);

const SPANISH = rows('es', [
  [
    '001',
    'ana',
    'mis tickets abiertos',
    'assignee = currentUser() AND stage != closed',
    ['my', 'negation'],
  ],
  [
    '002',
    'ana',
    'errores urgentes o de prioridad alta en la app web',
    'track = WEB AND type = Bug AND priority IN (Urgent, High)',
    ['fields', 'operators'],
  ],
  [
    '003',
    'ben',
    'tickets sin asignar en la app móvil',
    'track = MOB AND assignee IS EMPTY',
    ['unassigned'],
  ],
  ['004', 'ana', 'tickets vencidos', 'due < startOfDay() AND stage != closed', ['overdue']],
  ['005', 'grace', 'tickets actualizados esta semana', 'updated >= startOfWeek()', ['this-week']],
  ['006', 'ana', 'tickets que mencionan Safari', 'text ~ safari', ['text']],
  [
    '007',
    'elif',
    'tickets en revisión, los más recientes primero',
    'status = "In Review" ORDER BY created DESC',
    ['order'],
    { ordered: true },
  ],
  [
    '008',
    'ana',
    'funcionalidades previstas para la versión 2.0',
    'type = Feature AND targetRelease = "2.0"',
    ['fields'],
  ],
  [
    '009',
    'ben',
    'tickets con la etiqueta regression que no estén cerrados',
    'labels = regression AND stage != closed',
    ['negation'],
  ],
  ['010', 'chen', 'tickets del área de facturación', 'area = Billing', ['fields']],
  ['011', 'ana', 'tickets creados en los últimos 14 días', 'created >= -14d', ['dates']],
  [
    '012',
    'grace',
    'tickets de la app web sin fecha de vencimiento',
    'track = WEB AND due IS EMPTY',
    ['empty'],
  ],
  [
    '013',
    'ana',
    'tickets del área Checkout que no son errores',
    'area = Checkout AND type != Bug',
    ['negation'],
  ],
  [
    '014',
    'ben',
    'tickets asignados a Chen Wei con prioridad alta',
    'assignee = "Chen Wei" AND priority = High',
    ['fields'],
  ],
  [
    '015',
    'ana',
    'tickets que vencen esta semana',
    'due >= startOfWeek() AND due <= endOfWeek()',
    ['this-week', 'dates'],
  ],
  ['016', 'hiro', 'tickets cerrados como duplicados', 'closeReason = Duplicate', ['fields']],
]);

const GERMAN = rows('de', [
  [
    '001',
    'dara',
    'meine offenen Bugs, die diese Woche aktualisiert wurden',
    'assignee = currentUser() AND type = Bug AND stage != closed AND updated >= startOfWeek()',
    ['my', 'this-week'],
  ],
  [
    '002',
    'dara',
    'nicht zugewiesene Tickets in der Platform API',
    'track = API AND assignee IS EMPTY',
    ['unassigned'],
  ],
  [
    '003',
    'elif',
    'überfällige Tickets in den Mobile apps',
    'track = MOB AND due < startOfDay() AND stage != closed',
    ['overdue'],
  ],
  [
    '004',
    'dara',
    'dringende Tickets, zuletzt aktualisierte zuerst',
    'priority = Urgent ORDER BY updated DESC',
    ['order', 'permissions'],
    { ordered: true },
  ],
  ['005', 'elif', 'Tickets mit dem Label android', 'labels = android', ['fields']],
  [
    '006',
    'dara',
    'Tickets, deren Zusammenfassung „dark mode“ enthält',
    'summary ~ "dark mode"',
    ['text'],
  ],
  [
    '007',
    'grace',
    'geschlossene Tickets der letzten 30 Tage',
    'stage = closed AND closed >= -30d',
    ['dates'],
  ],
  ['008', 'dara', 'Tickets ohne Priorität', 'priority IS EMPTY', ['empty']],
  [
    '009',
    'elif',
    'Features für Release 5.1',
    'type = Feature AND targetRelease = "5.1"',
    ['fields'],
  ],
  ['010', 'dara', 'Tickets, die nicht im Track WEB sind', 'track != WEB', ['negation']],
  ['011', 'chen', 'Tickets, die ich gemeldet habe', 'requester = currentUser()', ['my']],
  [
    '012',
    'dara',
    'Tickets im Bereich Webhooks mit mehr als 2 Punkten',
    'area = Webhooks AND Points > 2',
    ['operators'],
  ],
  [
    '013',
    'elif',
    'Tickets, die in diesem Monat erstellt wurden',
    'created >= startOfMonth()',
    ['dates'],
  ],
  [
    '014',
    'dara',
    'offene Tickets, die jemandem aus dem platform-team zugewiesen sind',
    'assignee IN membersOf("platform-team") AND stage != closed',
    ['functions'],
  ],
  ['015', 'ben', 'Tickets, in deren Kommentaren „staging“ vorkommt', 'comment ~ staging', ['text']],
  [
    '016',
    'grace',
    'älteste offene Features zuerst',
    'type = Feature AND stage != closed ORDER BY created ASC',
    ['order'],
    { ordered: true },
  ],
]);

const JAPANESE = rows('ja', [
  [
    '001',
    'hiro',
    '自分の未完了のバグ',
    'assignee = currentUser() AND type = Bug AND stage != closed',
    ['my'],
  ],
  ['002', 'hiro', '今週更新されたチケット', 'updated >= startOfWeek()', ['this-week']],
  [
    '003',
    'hiro',
    'モバイルで担当者が決まっていないチケット',
    'track = MOB AND assignee IS EMPTY',
    ['unassigned'],
  ],
  ['004', 'hiro', '期限切れのチケット', 'due < startOfDay() AND stage != closed', ['overdue']],
  [
    '005',
    'hiro',
    '優先度が緊急のチケットを新しい順に',
    'priority = Urgent ORDER BY created DESC',
    ['order'],
    { ordered: true },
  ],
  ['006', 'elif', 'iosラベルが付いたチケット', 'labels = ios', ['fields']],
  ['007', 'hiro', 'レビュー中のチケット', 'status = "In Review"', ['fields']],
  [
    '008',
    'hiro',
    'リリース5.1に予定されている機能',
    'type = Feature AND targetRelease = "5.1"',
    ['fields'],
  ],
  ['009', 'hiro', 'Safariに関するチケット', 'text ~ safari', ['text']],
  [
    '010',
    'hiro',
    '期限が設定されていないモバイルのチケット',
    'track = MOB AND due IS EMPTY',
    ['empty'],
  ],
  ['011', 'hiro', 'バグ以外のチケット', 'type != Bug', ['negation']],
  ['012', 'hiro', '過去7日間に作成されたチケット', 'created >= -7d', ['dates']],
  ['013', 'hiro', 'Ana Ortizに割り当てられたチケット', 'assignee = "Ana Ortiz"', ['fields']],
  [
    '014',
    'hiro',
    'ウェブの未完了チケットを期限が早い順に',
    'track = WEB AND stage != closed AND due IS NOT EMPTY ORDER BY due ASC',
    ['order'],
    { ordered: true },
  ],
  ['015', 'hiro', 'ポイントが5以上のチケット', 'Points >= 5', ['operators']],
  ['016', 'hiro', '今月クローズされたチケット', 'closed >= startOfMonth()', ['dates']],
]);

export const QUERY_PAIRS: readonly QueryPair[] = [...ENGLISH, ...SPANISH, ...GERMAN, ...JAPANESE];
