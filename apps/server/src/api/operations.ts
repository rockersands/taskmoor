import { z } from 'zod';
import { createBoardBody } from '../boards/model';
import { dataQuery as boardDataQuery, listQuery as boardListQuery } from '../routes/boards';
import {
  createBody as commentCreateBody,
  listQuery as commentListQuery,
  updateBody as commentUpdateBody,
} from '../routes/comments';
import { createLinkBody } from '../routes/links';
import { metaAnswer, metaQuery } from '../routes/meta';
import { createReleaseBody, archivedQuery as releaseListQuery } from '../routes/releases';
import {
  createBody as savedSearchCreateBody,
  listQuery as savedSearchListQuery,
} from '../routes/saved-searches';
import { checkQuery, searchInput } from '../routes/search';
import { signInBody } from '../routes/session';
import { backlogQuery, listQuery as sprintListQuery } from '../routes/sprints';
import {
  historyQuery,
  rankBody,
  createBody as ticketCreateBody,
  listQuery as ticketListQuery,
  updateBody as ticketUpdateBody,
  transitionBody,
} from '../routes/tickets';
import { createBody as timeCreateBody, listQuery as timeListQuery } from '../routes/time';
import { createBody as trackCreateBody, listQuery as trackListQuery } from '../routes/tracks';
import {
  completeSprintBody,
  createSprintBody,
  sprintTicketsBody,
  startSprintBody,
} from '../sprints/model';
import { RICH_TEXT_FORMATS } from '../tickets/rich-text';
import { type Operation, op } from './operation';
import * as s from './schemas';

/**
 * The stable operations of API v1 (M1-065; API-001; ADR-067), by area. Each one's request is
 * the schema its route validates with, so the document cannot drift from the server; each
 * response is written here and checked against real answers by `contract.test.ts`.
 */
const ticketParam = { id: 'The ticket: its id or its key, such as `PAY-12`.' };
const trackParam = { id: 'The track: its id or its key.' };
const format = z
  .object({
    format: z.enum(RICH_TEXT_FORMATS).optional().meta({
      description: 'The rich-text format of bodies, in and out; the stored document by default.',
    }),
  })
  .strict();
const one = <K extends string>(key: K, schema: z.ZodType) =>
  z.object({ [key]: schema } as Record<K, z.ZodType>);

export const OPERATIONS: readonly Operation[] = [
  // The instance (M1-106): what a frontend or a client reads before anything else.
  op({
    method: 'GET',
    path: '/api/meta',
    id: 'getMeta',
    tag: 'Instance',
    summary: 'What this instance is and which clients it works with',
    description:
      'Needs no sign-in and holds no secret: the backend and API versions, the frontend versions it serves, how people sign in, and the instance’s id and public key. With a nonce, the instance signs it, so a client can check it reached the instance it expects.',
    query: metaQuery,
    responses: { 200: { description: 'The instance.', schema: metaAnswer } },
  }),

  // Session.
  op({
    method: 'POST',
    path: '/api/v1/session',
    id: 'signIn',
    tag: 'Session',
    summary: 'Sign in with an email and a password',
    description:
      'Starts a browser session (a cookie). Programs use API tokens instead; a second factor, when required, is asked for by the answer.',
    body: signInBody,
    responses: {
      200: {
        description: 'Signed in, or a second factor is needed.',
        schema: z.object({ status: z.string(), user: s.signedInUser.optional() }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/session',
    id: 'getSession',
    tag: 'Session',
    summary: 'Who is calling',
    description: 'The signed-in person, and for a token its id and scopes.',
    responses: {
      200: { description: 'The caller.', schema: z.object({ user: s.signedInUser }).loose() },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/session',
    id: 'signOut',
    tag: 'Session',
    summary: 'Sign out',
    responses: { 204: { description: 'The session is over.' } },
  }),

  // Tracks.
  op({
    method: 'GET',
    path: '/api/v1/tracks',
    id: 'listTracks',
    tag: 'Tracks',
    summary: 'List the tracks the caller may browse',
    query: trackListQuery,
    responses: {
      200: {
        description: 'The tracks, by key.',
        schema: z.object({ tracks: z.array(s.track), next: s.next.optional() }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tracks',
    id: 'createTrack',
    tag: 'Tracks',
    summary: 'Make a track',
    description:
      'Shared-mode tracks need a site or configuration administrator. A `template` adds its type, features and first board; `copyFrom` takes another shared track’s configuration.',
    body: trackCreateBody,
    responses: {
      201: {
        description: 'The new track, and the board a template made.',
        schema: z.object({ track: s.track, board: s.boardSummary.optional() }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tracks/:id',
    id: 'getTrack',
    tag: 'Tracks',
    summary: 'Read a track',
    params: trackParam,
    responses: { 200: { description: 'The track.', schema: one('track', s.track) } },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tracks/:id/ticket-types',
    id: 'listTrackTicketTypes',
    tag: 'Tracks',
    summary: 'The ticket types a track offers',
    params: trackParam,
    responses: {
      200: {
        description: 'Its types in set order, and the one new tickets take by default.',
        schema: z
          .object({
            defaultTypeId: s.ticket.shape.id.nullable(),
            ticketTypes: z.array(s.ticketType),
          })
          .loose(),
      },
    },
  }),

  // Tickets.
  op({
    method: 'GET',
    path: '/api/v1/tickets',
    id: 'listTickets',
    tag: 'Tickets',
    summary: 'List tickets, a page at a time',
    description: 'For queries, use search; this lists a track’s tickets by rank.',
    query: ticketListQuery,
    paged: true,
    responses: {
      200: {
        description: 'A page of tickets.',
        schema: z.object({ tickets: z.array(s.ticket), next: s.next }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets',
    id: 'createTicket',
    tag: 'Tickets',
    summary: 'Make a ticket',
    description: 'In a track the caller may create tickets in; the track’s field rules apply.',
    body: ticketCreateBody,
    responses: { 201: { description: 'The new ticket.', schema: one('ticket', s.ticket) } },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id',
    id: 'getTicket',
    tag: 'Tickets',
    summary: 'Read a ticket',
    params: ticketParam,
    query: format,
    responses: { 200: { description: 'The ticket.', schema: one('ticket', s.ticket) } },
  }),
  op({
    method: 'PATCH',
    path: '/api/v1/tickets/:id',
    id: 'updateTicket',
    tag: 'Tickets',
    summary: 'Change a ticket’s fields',
    description:
      'Only the fields given change. Send `version` to be refused (409) if someone changed it since you read it.',
    params: ticketParam,
    body: ticketUpdateBody,
    responses: {
      200: { description: 'The ticket as it is now.', schema: one('ticket', s.ticket) },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/tickets/:id',
    id: 'deleteTicket',
    tag: 'Tickets',
    summary: 'Move a ticket to the trash',
    params: ticketParam,
    responses: { 204: { description: 'In the trash; it can be restored until it is purged.' } },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/transitions',
    id: 'listTransitions',
    tag: 'Tickets',
    summary: 'The transitions a ticket may take now',
    params: ticketParam,
    responses: {
      200: {
        description: 'Its transitions.',
        schema: z.object({ transitions: z.array(s.transition) }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/transitions',
    id: 'transitionTicket',
    tag: 'Tickets',
    summary: 'Move a ticket through a transition',
    description: 'With the values its form asks for, such as a close reason.',
    params: ticketParam,
    body: transitionBody,
    responses: {
      200: { description: 'The ticket in its new status.', schema: one('ticket', s.ticket) },
    },
  }),
  op({
    method: 'PUT',
    path: '/api/v1/tickets/:id/rank',
    id: 'rankTicket',
    tag: 'Tickets',
    summary: 'Rank a ticket before or after another, or at an end',
    params: ticketParam,
    body: rankBody,
    responses: {
      200: { description: 'The ticket with its new rank.', schema: one('ticket', s.ticket) },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/history',
    id: 'getTicketHistory',
    tag: 'Tickets',
    summary: 'A ticket’s changes, a page at a time',
    params: ticketParam,
    query: historyQuery,
    paged: true,
    responses: {
      200: {
        description: 'A page of changes.',
        schema: z.object({ changes: z.array(s.change), next: s.next }).loose(),
      },
    },
  }),

  // Comments.
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/comments',
    id: 'listComments',
    tag: 'Comments',
    summary: 'A ticket’s comments, a page at a time',
    params: ticketParam,
    query: commentListQuery,
    paged: true,
    responses: {
      200: {
        description: 'A page of the comments the caller may see.',
        schema: z.object({ comments: z.array(s.comment), next: s.nextId }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/comments',
    id: 'addComment',
    tag: 'Comments',
    summary: 'Comment on a ticket',
    params: ticketParam,
    query: format,
    body: commentCreateBody,
    responses: { 201: { description: 'The new comment.', schema: one('comment', s.comment) } },
  }),
  op({
    method: 'PATCH',
    path: '/api/v1/tickets/:id/comments/:commentId',
    id: 'updateComment',
    tag: 'Comments',
    summary: 'Change a comment',
    params: { ...ticketParam, commentId: 'The comment’s id.' },
    query: format,
    body: commentUpdateBody,
    responses: {
      200: { description: 'The comment as it is now.', schema: one('comment', s.comment) },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/tickets/:id/comments/:commentId',
    id: 'deleteComment',
    tag: 'Comments',
    summary: 'Delete a comment',
    params: { ...ticketParam, commentId: 'The comment’s id.' },
    responses: { 204: { description: 'Deleted.' } },
  }),

  // Links.
  op({
    method: 'GET',
    path: '/api/v1/link-types',
    id: 'listLinkTypes',
    tag: 'Links',
    summary: 'The kinds of link between tickets',
    responses: {
      200: {
        description: 'The link types, and whether linking is on.',
        schema: z.object({ enabled: z.boolean(), linkTypes: z.array(s.linkType) }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/links',
    id: 'listLinks',
    tag: 'Links',
    summary: 'A ticket’s links',
    params: ticketParam,
    responses: {
      200: {
        description: 'Its links to the tickets the caller may see.',
        schema: z.object({ links: z.array(s.link) }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/links',
    id: 'addLink',
    tag: 'Links',
    summary: 'Link a ticket to another',
    params: ticketParam,
    body: createLinkBody,
    responses: { 201: { description: 'The new link.', schema: one('link', s.link) } },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/tickets/:id/links/:linkId',
    id: 'removeLink',
    tag: 'Links',
    summary: 'Remove a link',
    params: { ...ticketParam, linkId: 'The link’s id.' },
    responses: { 204: { description: 'Removed.' } },
  }),

  // Time tracking.
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/time-entries',
    id: 'listTimeEntries',
    tag: 'Time',
    summary: 'Time logged on a ticket, a page at a time',
    params: ticketParam,
    query: timeListQuery,
    paged: true,
    responses: {
      200: {
        description: 'A page of time entries.',
        schema: z.object({ timeEntries: z.array(s.timeEntry), next: s.nextId }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/time-entries',
    id: 'logTime',
    tag: 'Time',
    summary: 'Log time on a ticket',
    params: ticketParam,
    body: timeCreateBody,
    responses: {
      201: { description: 'The new time entry.', schema: one('timeEntry', s.timeEntry) },
    },
  }),

  // Search.
  op({
    method: 'GET',
    path: '/api/v1/search',
    id: 'search',
    tag: 'Search',
    summary: 'Run a query, a page at a time',
    description:
      'The query language of the search page. Pages follow `next`; the first page carries a count unless asked not to: exact up to 10,000, then an estimate within 10% (`approximate`) or a lower bound.',
    query: searchInput,
    paged: true,
    responses: {
      200: {
        description: 'A page of the tickets the query finds, as the caller may see them.',
        schema: z
          .object({
            tickets: z.array(s.searchTicket),
            next: s.next,
            total: s.searchTotal.optional(),
          })
          .loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/search',
    id: 'searchLong',
    tag: 'Search',
    summary: 'Run a query too long for a URL',
    description:
      'The same as `GET /api/v1/search`, with the parameters in the body. It changes nothing.',
    body: searchInput,
    paged: true,
    responses: {
      200: {
        description: 'A page of tickets.',
        schema: z
          .object({
            tickets: z.array(s.searchTicket),
            next: s.next,
            total: s.searchTotal.optional(),
          })
          .loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/search/check',
    id: 'checkQuery',
    tag: 'Search',
    summary: 'Check a query without running it',
    query: checkQuery,
    responses: {
      200: {
        description: 'Valid, with the fields it names; or where it goes wrong.',
        schema: s.queryCheck,
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/saved-searches',
    id: 'listSavedSearches',
    tag: 'Search',
    summary: 'The saved searches the caller owns or that are shared with them',
    query: savedSearchListQuery,
    responses: {
      200: {
        description: 'The saved searches.',
        schema: z.object({ savedSearches: z.array(s.savedSearch) }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/saved-searches',
    id: 'createSavedSearch',
    tag: 'Search',
    summary: 'Save a search',
    body: savedSearchCreateBody,
    responses: {
      201: { description: 'The saved search.', schema: one('savedSearch', s.savedSearch) },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/saved-searches/:id',
    id: 'getSavedSearch',
    tag: 'Search',
    summary: 'Read a saved search',
    params: { id: 'The saved search’s id.' },
    responses: {
      200: { description: 'The saved search.', schema: one('savedSearch', s.savedSearch) },
    },
  }),

  // Boards and sprints.
  op({
    method: 'GET',
    path: '/api/v1/boards',
    id: 'listBoards',
    tag: 'Boards',
    summary: 'The boards the caller may see',
    query: boardListQuery,
    responses: {
      200: {
        description: 'The boards, by name.',
        schema: z.object({ boards: z.array(s.boardSummary) }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/boards',
    id: 'createBoard',
    tag: 'Boards',
    summary: 'Make a board from a query',
    body: createBoardBody,
    responses: { 201: { description: 'The new board.', schema: one('board', s.board) } },
  }),
  op({
    method: 'GET',
    path: '/api/v1/boards/:id',
    id: 'getBoard',
    tag: 'Boards',
    summary: 'Read a board’s configuration',
    params: { id: 'The board’s id.' },
    responses: {
      200: {
        description: 'The board and the statuses its columns may take.',
        schema: z.object({ board: s.board, statuses: z.array(z.object({}).loose()) }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/boards/:id/data',
    id: 'getBoardCards',
    tag: 'Boards',
    summary: 'A board’s columns, lanes and cards',
    params: { id: 'The board’s id.' },
    query: boardDataQuery,
    responses: {
      200: { description: 'The cards the caller may see, in rank order.', schema: s.boardData },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/boards/:id/sprints',
    id: 'listSprints',
    tag: 'Boards',
    summary: 'A Scrum board’s sprints',
    params: { id: 'The board’s id.' },
    query: sprintListQuery,
    responses: {
      200: {
        description: 'Its sprints in order.',
        schema: z.object({ sprints: z.array(s.sprint) }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/boards/:id/backlog',
    id: 'getBacklog',
    tag: 'Boards',
    summary: 'A Scrum board’s open sprints and backlog',
    params: { id: 'The board’s id.' },
    query: backlogQuery,
    responses: {
      200: {
        description: 'Sprint sections, then the backlog, in rank order with totals.',
        schema: s.backlog,
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/boards/:id/sprints',
    id: 'createSprint',
    tag: 'Boards',
    summary: 'Plan a sprint',
    params: { id: 'The board’s id.' },
    body: createSprintBody,
    responses: { 201: { description: 'The new future sprint.', schema: one('sprint', s.sprint) } },
  }),
  op({
    method: 'POST',
    path: '/api/v1/sprints/:id/tickets',
    id: 'addSprintTickets',
    tag: 'Boards',
    summary: 'Move tickets into a sprint',
    description: 'From the backlog or another open sprint, in one operation.',
    params: { id: 'The sprint’s id.' },
    body: sprintTicketsBody,
    responses: {
      200: {
        description: 'How many were added, and whether after its start.',
        schema: z.object({ added: z.number().int(), afterStart: z.boolean() }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/sprints/:id/start',
    id: 'startSprint',
    tag: 'Boards',
    summary: 'Start a sprint',
    params: { id: 'The sprint’s id.' },
    body: startSprintBody,
    responses: { 200: { description: 'The active sprint.', schema: one('sprint', s.sprint) } },
  }),
  op({
    method: 'POST',
    path: '/api/v1/sprints/:id/complete',
    id: 'completeSprint',
    tag: 'Boards',
    summary: 'Complete a sprint',
    description: 'Its unfinished tickets go to the backlog, a future sprint or a new one.',
    params: { id: 'The sprint’s id.' },
    body: completeSprintBody,
    responses: {
      200: {
        description: 'The closed sprint and where its tickets went.',
        schema: z
          .object({ sprint: s.sprint, completed: z.number().int(), carriedOver: z.number().int() })
          .loose(),
      },
    },
  }),

  // Releases.
  op({
    method: 'GET',
    path: '/api/v1/tracks/:id/releases',
    id: 'listReleases',
    tag: 'Releases',
    summary: 'A track’s releases, in its order',
    params: { id: 'The track’s id.' },
    query: releaseListQuery,
    responses: {
      200: {
        description: 'Its releases with their progress.',
        schema: z.object({ releases: z.array(s.release), mayManage: z.boolean() }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tracks/:id/releases',
    id: 'createRelease',
    tag: 'Releases',
    summary: 'Add a release to a track',
    params: { id: 'The track’s id.' },
    body: createReleaseBody,
    responses: { 201: { description: 'The new release.', schema: one('release', s.release) } },
  }),
  op({
    method: 'GET',
    path: '/api/v1/releases/:id',
    id: 'getRelease',
    tag: 'Releases',
    summary: 'Read a release',
    params: { id: 'The release’s id.' },
    responses: {
      200: { description: 'The release with its approvers.', schema: one('release', s.release) },
    },
  }),

  // Reference data.
  op({
    method: 'GET',
    path: '/api/v1/fields',
    id: 'listFields',
    tag: 'Reference',
    summary: 'The custom fields the caller may see',
    responses: {
      200: { description: 'The fields.', schema: z.object({ fields: z.array(s.field) }).loose() },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/priorities',
    id: 'listPriorities',
    tag: 'Reference',
    summary: 'The priorities, in order',
    responses: {
      200: {
        description: 'The priorities.',
        schema: z.object({ priorities: z.array(s.priority) }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/statuses',
    id: 'listStatuses',
    tag: 'Reference',
    summary: 'The statuses, in order',
    responses: {
      200: {
        description: 'The statuses with their stages.',
        schema: z.object({ statuses: z.array(s.status) }).loose(),
      },
    },
  }),
];
