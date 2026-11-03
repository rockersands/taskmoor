import { z } from 'zod';
import { createBoardBody } from '../boards/model';
import { bulkBody } from '../bulk/model';
import { cloneBody } from '../clone/model';
import { dataQuery as boardDataQuery, listQuery as boardListQuery } from '../routes/boards';
import { itemsQuery as bulkItemsQuery } from '../routes/bulk';
import {
  checklistOrderBody,
  createChecklistBody,
  createItemBody,
  updateChecklistBody,
  updateItemBody,
} from '../routes/checklists';
import {
  createBody as commentCreateBody,
  listQuery as commentListQuery,
  updateBody as commentUpdateBody,
} from '../routes/comments';
import { createLinkBody } from '../routes/links';
import { metaAnswer, metaQuery } from '../routes/meta';
import { propertyIndexBody, putPropertyBody } from '../routes/properties';
import { createReleaseBody, archivedQuery as releaseListQuery } from '../routes/releases';
import {
  createBody as savedSearchCreateBody,
  listQuery as savedSearchListQuery,
} from '../routes/saved-searches';
import { checkQuery, searchInput } from '../routes/search';
import { signInBody } from '../routes/session';
import { similarQuery, similarTextBody } from '../routes/similar';
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
const listParam = { ...ticketParam, checklistId: 'The checklist’s id.' };
const itemParam = { ...listParam, itemId: 'The item’s id.' };
const format = z
  .object({
    format: z.enum(RICH_TEXT_FORMATS).optional().meta({
      description:
        'The rich-text format of bodies, in and out; the stored document by default. `text` (plain text) is for answers only.',
    }),
  })
  .strict();
const one = <K extends string>(key: K, schema: z.ZodType) =>
  z.object({ [key]: schema } as Record<K, z.ZodType>);

/** The four operations on the properties of one kind of entity (M1-129; API-013). */
function propertyOperations(
  base: string,
  name: string,
  owner: string,
  rights: string,
): Operation[] {
  const params = { id: owner };
  const keyed = { ...params, key: 'The property key: 1 to 255 characters, percent-encoded.' };
  return [
    op({
      method: 'GET',
      path: `${base}/:id/properties`,
      id: `list${name}Properties`,
      tag: 'Properties',
      summary: `The property keys of a ${name.toLowerCase()}`,
      params,
      responses: {
        200: {
          description: 'Its keys, in order, with when each was last set.',
          schema: z.object({ properties: z.array(s.propertyKey) }).loose(),
        },
      },
    }),
    op({
      method: 'GET',
      path: `${base}/:id/properties/:key`,
      id: `get${name}Property`,
      tag: 'Properties',
      summary: `One property of a ${name.toLowerCase()}`,
      params: keyed,
      responses: { 200: { description: 'The property.', schema: one('property', s.property) } },
    }),
    op({
      method: 'PUT',
      path: `${base}/:id/properties/:key`,
      id: `set${name}Property`,
      tag: 'Properties',
      summary: `Set a property of a ${name.toLowerCase()}`,
      description: `Sets the key to any JSON value of at most 32,768 bytes as JSON text, replacing what was there. ${rights}`,
      params: keyed,
      body: putPropertyBody,
      responses: {
        200: { description: 'Replaced.', schema: one('property', s.property) },
        201: { description: 'Set for the first time.', schema: one('property', s.property) },
      },
    }),
    op({
      method: 'DELETE',
      path: `${base}/:id/properties/:key`,
      id: `delete${name}Property`,
      tag: 'Properties',
      summary: `Delete a property of a ${name.toLowerCase()}`,
      params: keyed,
      responses: { 204: { description: 'Deleted.' } },
    }),
  ];
}

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
    description:
      '`member=true` keeps the tracks the caller belongs to: a role given to them or to a group they are in, ownership, or a team of theirs that one of the track’s boards or areas names. A track the caller sees only because it is open to everyone, through a grant of its access policy, or as an administrator is left out. `keys` keeps only the tracks with those keys, so a client finds particular tracks of the caller, such as the ones opened lately, without paging through all of them.',
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
    method: 'POST',
    path: '/api/v1/tickets/:id/clone',
    id: 'cloneTicket',
    tag: 'Tickets',
    summary: 'Copy a ticket, or a ticket and everything below it',
    description:
      'Starts a task that copies the ticket, by default into its own track with its subtickets, attachments and links; each copy gets a Copies link to its original. With `descendants`, every ticket below it at every level is copied too (a deep clone). Values the caller may not set, or the track does not take, are left out. Poll the bulk operation it answers; each item names the copy it made.',
    params: ticketParam,
    body: cloneBody,
    responses: {
      202: {
        description: 'Started; poll the operation for its progress and the copies.',
        schema: z.object({ bulkOperation: s.bulkOperation }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/info',
    id: 'getTicketInfo',
    tag: 'Tickets',
    summary: 'A ticket’s read-only info: first response, participants, time in status',
    params: ticketParam,
    responses: {
      200: { description: 'The info fields.', schema: one('info', s.ticketInfo) },
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
        schema: z
          .object({
            links: z.array(s.link),
            mayLink: z
              .boolean()
              .meta({ description: 'May this person add and remove links here.' }),
            enabled: z.boolean().meta({ description: 'Links are on in the workspace.' }),
          })
          .loose(),
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

  // Checklists (CORE-033): every route answers the whole of the ticket's checklists.
  op({
    method: 'GET',
    path: '/api/v1/tickets/:id/checklists',
    id: 'listChecklists',
    tag: 'Checklists',
    summary: 'A ticket’s checklists',
    params: ticketParam,
    responses: {
      200: {
        description:
          'Its checklists, with progress for each and overall. A rejected item is left out of the percentage.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/checklists',
    id: 'addChecklist',
    tag: 'Checklists',
    summary: 'Add a checklist',
    params: ticketParam,
    body: createChecklistBody,
    responses: {
      201: {
        description: 'The ticket’s checklists, with the new one.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'PUT',
    path: '/api/v1/tickets/:id/checklists/order',
    id: 'orderChecklists',
    tag: 'Checklists',
    summary: 'Put a ticket’s checklists in order',
    params: ticketParam,
    body: checklistOrderBody,
    responses: {
      200: {
        description: 'The ticket’s checklists, in the new order.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'PATCH',
    path: '/api/v1/tickets/:id/checklists/:checklistId',
    id: 'renameChecklist',
    tag: 'Checklists',
    summary: 'Rename a checklist',
    params: listParam,
    body: updateChecklistBody,
    responses: {
      200: {
        description: 'The ticket’s checklists.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/tickets/:id/checklists/:checklistId',
    id: 'removeChecklist',
    tag: 'Checklists',
    summary: 'Remove a checklist',
    params: listParam,
    responses: {
      200: {
        description: 'The ticket’s remaining checklists.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/:id/checklists/:checklistId/items',
    id: 'addChecklistItem',
    tag: 'Checklists',
    summary: 'Add an item to a checklist',
    params: listParam,
    body: createItemBody,
    responses: {
      201: {
        description: 'The ticket’s checklists, with the new item at the end.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'PUT',
    path: '/api/v1/tickets/:id/checklists/:checklistId/items/order',
    id: 'orderChecklistItems',
    tag: 'Checklists',
    summary: 'Put a checklist’s items in order',
    params: listParam,
    body: checklistOrderBody,
    responses: {
      200: {
        description: 'The ticket’s checklists, in the new order.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'PATCH',
    path: '/api/v1/tickets/:id/checklists/:checklistId/items/:itemId',
    id: 'updateChecklistItem',
    tag: 'Checklists',
    summary: 'Change an item’s words or state',
    params: itemParam,
    body: updateItemBody,
    responses: {
      200: {
        description: 'The ticket’s checklists.',
        schema: s.checklists,
      },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/tickets/:id/checklists/:checklistId/items/:itemId',
    id: 'removeChecklistItem',
    tag: 'Checklists',
    summary: 'Remove an item from a checklist',
    params: itemParam,
    responses: {
      200: {
        description: 'The ticket’s checklists.',
        schema: s.checklists,
      },
    },
  }),

  // Entity properties (M1-129; API-013): an integration's JSON under its own key.
  ...propertyOperations(
    '/api/v1/tickets',
    'Ticket',
    ticketParam.id,
    'Reading needs the right to see the ticket; writing, the right to edit it. The values of declared property indexes become searchable as `ticket.property[key].path`.',
  ),
  ...propertyOperations(
    '/api/v1/tracks',
    'Track',
    trackParam.id,
    'Reading needs the right to browse the track; writing, the right to administer it.',
  ),
  ...propertyOperations(
    '/api/v1/users',
    'User',
    'The person: their id, or `me`.',
    'Only the person and site administrators read and write a person’s properties.',
  ),
  ...propertyOperations(
    '/api/v1/boards',
    'Board',
    'The board’s id.',
    'Reading needs the right to see the board; writing, the right to configure it.',
  ),
  ...propertyOperations(
    '/api/v1/sprints',
    'Sprint',
    'The sprint’s id.',
    'Reading needs the right to see its board; writing, the right to manage its sprints.',
  ),
  op({
    method: 'GET',
    path: '/api/v1/admin/property-indexes',
    id: 'listPropertyIndexes',
    tag: 'Properties',
    summary: 'The declared property indexes',
    description: 'For site and configuration administrators.',
    responses: {
      200: {
        description: 'Every index, oldest first.',
        schema: z.object({ propertyIndexes: z.array(s.propertyIndex) }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/admin/property-indexes',
    id: 'createPropertyIndex',
    tag: 'Properties',
    summary: 'Make a value inside ticket properties searchable',
    description:
      'Declares that the values found at `path` inside the `key` property of tickets are of `type`, and fills the index from the properties already set. Queries then read them as `ticket.property[key].path`, or by the `alias`. An array along the path gives one value per element; a value of another type is left out. For site and configuration administrators.',
    body: propertyIndexBody,
    responses: {
      201: { description: 'The new index.', schema: one('propertyIndex', s.propertyIndex) },
    },
  }),
  op({
    method: 'DELETE',
    path: '/api/v1/admin/property-indexes/:id',
    id: 'deletePropertyIndex',
    tag: 'Properties',
    summary: 'Drop a property index',
    description: 'The properties stay; queries can no longer read the values.',
    params: { id: 'The index’s id.' },
    responses: { 204: { description: 'Dropped.' } },
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
    path: '/api/v1/tickets/:id/similar',
    id: 'similarTickets',
    tag: 'Search',
    summary: 'The tickets most similar in meaning to a ticket',
    description:
      'Nearest first by the vectors of the bundled embedding model, which needs no AI provider or key; a ticket matches by its summary and description or by one of its comments. Only tickets the caller may see, and comments the caller may read, take part. Tickets changed in the last seconds may not be indexed yet.',
    params: ticketParam,
    query: similarQuery,
    responses: {
      200: { description: 'The similar tickets, best first.', schema: s.similarTickets },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/tickets/similar',
    id: 'similarToText',
    tag: 'Search',
    summary: 'Tickets similar to a text being written',
    description:
      'Duplicate suggestions while a ticket is created: the same lookup as `GET /api/v1/tickets/{id}/similar` for a text, optionally in one track. It changes nothing.',
    body: similarTextBody,
    responses: {
      200: { description: 'The similar tickets, best first.', schema: s.similarTickets },
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

  // Bulk changes as tasks (M1-130; API-007): start one, poll it, read each ticket's result.
  op({
    method: 'POST',
    path: '/api/v1/bulk-operations',
    id: 'createBulkOperation',
    tag: 'Bulk changes',
    summary: 'Start a bulk change',
    description:
      'Transitions, moves, edits or deletes many tickets as one task, given as ids or keys or as a query whose results are the tickets. Each ticket goes through the same checks as a change of its own. The workspace limits how many tickets one operation may change (10,000 by default, the `tickets_per_bulk_operation` guardrail).',
    body: bulkBody,
    responses: {
      202: {
        description: 'Started; poll the operation for its progress.',
        schema: z.object({ bulkOperation: s.bulkOperation }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/bulk-operations',
    id: 'listBulkOperations',
    tag: 'Bulk changes',
    summary: 'The caller’s latest bulk changes',
    responses: {
      200: {
        description: 'The 50 most recent, newest first.',
        schema: z.object({ bulkOperations: z.array(s.bulkOperation) }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/bulk-operations/:id',
    id: 'getBulkOperation',
    tag: 'Bulk changes',
    summary: 'A bulk change’s progress',
    description: 'Readable for 14 days after it finishes.',
    params: { id: 'The bulk operation.' },
    responses: {
      200: {
        description: 'The operation.',
        schema: z.object({ bulkOperation: s.bulkOperation }).loose(),
      },
    },
  }),
  op({
    method: 'GET',
    path: '/api/v1/bulk-operations/:id/items',
    id: 'listBulkItems',
    tag: 'Bulk changes',
    summary: 'Each ticket’s result in a bulk change',
    description:
      'In the order the tickets were given, a page at a time: pass the answer’s `next` as `after`. Filter by `outcome` to read only the failures, say.',
    params: { id: 'The bulk operation.' },
    query: bulkItemsQuery,
    responses: {
      200: {
        description: 'A page of results.',
        schema: z.object({ items: z.array(s.bulkItem), next: s.nextId }).loose(),
      },
    },
  }),
  op({
    method: 'POST',
    path: '/api/v1/bulk-operations/:id/cancel',
    id: 'cancelBulkOperation',
    tag: 'Bulk changes',
    summary: 'Cancel the rest of a bulk change',
    description: 'Tickets already in hand finish; the ones not reached are skipped.',
    params: { id: 'The bulk operation.' },
    responses: {
      202: {
        description: 'Cancelling.',
        schema: z.object({ bulkOperation: s.bulkOperation }).loose(),
      },
    },
  }),
];
