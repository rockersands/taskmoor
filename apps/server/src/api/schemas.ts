import { z } from 'zod';

/**
 * The bodies the stable operations answer with (M1-065; ADR-067). Objects are loose: a field
 * added later is not a breaking change, so clients must ignore fields they do not know. Ids are
 * integers unless said otherwise; instants are ISO 8601 strings in UTC; days are YYYY-MM-DD.
 */
const id = z.number().int();
const instant = z.string().meta({ format: 'date-time' });
const day = z.string().meta({ description: 'A calendar day, YYYY-MM-DD.' });
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

export const person = z
  .object({ id, name: z.string() })
  .loose()
  .meta({ id: 'PersonRef', description: 'A person, by id and display name.' });

export const stage = z
  .enum(['new', 'active', 'closed'])
  .meta({ id: 'Stage', description: 'The stage of a status: to do, in progress or done.' });

export const ticket = z
  .object({
    id,
    key: z.string().meta({ description: 'The track key and the number, such as `PAY-12`.' }),
    number: z.number().int(),
    track: z.object({ id, key: z.string(), name: z.string() }).loose(),
    ticketType: z
      .object({
        id,
        name: z.string(),
        icon: nullable(z.string()),
        color: nullable(z.string()),
        level: z.object({ id, rank: z.number().int(), name: z.string() }).loose(),
      })
      .loose(),
    parent: nullable(
      z
        .object({
          id,
          key: nullable(z.string()).meta({ description: 'Null when the caller may not see it.' }),
          summary: nullable(z.string()),
        })
        .loose(),
    ),
    status: z.object({ id, name: z.string(), stage }).loose(),
    summary: z.string(),
    description: z
      .unknown()
      .meta({ description: 'Rich text, in the format the request asked for.' }),
    environment: z.unknown(),
    assignee: nullable(person),
    requester: nullable(person),
    creator: nullable(person),
    startDate: nullable(day),
    dueDate: nullable(day),
    priority: nullable(
      z
        .object({ id, name: z.string(), icon: nullable(z.string()), color: nullable(z.string()) })
        .loose(),
    ),
    closeReason: nullable(z.object({ id, name: z.string() }).loose()),
    closedAt: nullable(instant),
    visibilityLevel: nullable(z.object({ id, name: z.string() }).loose()),
    labels: z.array(z.string()),
    targetReleases: z.array(z.unknown()),
    foundInReleases: z.array(z.unknown()),
    areas: z.array(z.unknown()),
    followerCount: z.number().int(),
    voteCount: z.number().int(),
    timeTracking: z
      .object({
        originalEstimate: nullable(z.number().int()).meta({ description: 'Seconds.' }),
        remainingEstimate: nullable(z.number().int()).meta({ description: 'Seconds.' }),
        timeSpent: z.number().int().meta({ description: 'Seconds.' }),
        effortRatio: nullable(z.number()),
      })
      .loose(),
    fields: z
      .record(z.string(), z.unknown())
      .meta({ description: 'Custom field values by field id.' }),
    rank: z.string().meta({ description: 'The global rank key: tickets sort by it.' }),
    version: z
      .number()
      .int()
      .meta({ description: 'Send it back with a change to guard against a lost update.' }),
    createdAt: instant,
    updatedAt: instant,
    trash: nullable(z.object({}).loose()).meta({
      description: 'Set while the ticket is in the trash.',
    }),
  })
  .loose()
  .meta({ id: 'Ticket' });

/** A ticket as search lists it: every property unless `fields` names some; id and key always. */
export const searchTicket = ticket
  .partial()
  .extend({ id, key: z.string() })
  .meta({ id: 'SearchTicket' });

export const next = nullable(z.string()).meta({
  description: 'The cursor of the next page; null on the last one.',
});

/** How many tickets a query finds (M1-040, ADR-069). */
export const searchTotal = z
  .object({
    count: z.number().int(),
    exact: z.boolean().meta({ description: 'The count is exact.' }),
    approximate: z.boolean().optional().meta({
      description:
        'The count is an estimate, within 10% of the true count 99 times in 100. With neither flag, the count is a lower bound: there are more.',
    }),
  })
  .loose()
  .meta({
    id: 'SearchTotal',
    description:
      'Exact up to 10,000; beyond, an estimate from a sample, or "more than 10,000" when no sample is precise enough.',
  });

/** The cursor of lists that page by id (comments, time entries): the last id of the page. */
export const nextId = nullable(z.number().int()).meta({
  description: 'The cursor of the next page (an id); null on the last one.',
});

export const track = z
  .object({
    id,
    key: z.string(),
    name: z.string(),
    description: z.string(),
    type: z.enum(['software', 'business', 'service', 'discovery']),
    mode: z.enum(['shared', 'local']),
    owner: nullable(person),
    archived: z.boolean(),
    features: z.record(z.string(), z.boolean()),
    createdAt: instant,
    updatedAt: instant,
  })
  .loose()
  .meta({ id: 'Track' });

export const ticketType = z
  .object({
    id,
    name: z.string(),
    description: z.string(),
    icon: nullable(z.string()),
    color: nullable(z.string()),
    level: z.object({ id, rank: z.number().int(), name: z.string() }).loose(),
    trackId: nullable(id),
  })
  .loose()
  .meta({ id: 'TicketType' });

export const transition = z
  .object({
    id,
    name: z.string(),
    to: z.object({ id, name: z.string(), stage }).loose(),
    layout: z.array(z.string()).meta({ description: 'The fields its form asks for.' }),
  })
  .loose()
  .meta({ id: 'Transition' });

const changeValue = z
  .object({ value: nullable(z.string()), display: nullable(z.string()) })
  .loose();
export const change = z
  .object({
    id: z.string(),
    changeSet: z.string(),
    at: instant,
    actor: nullable(person),
    field: z.string(),
    from: changeValue,
    to: changeValue,
    transitionId: nullable(id),
  })
  .loose()
  .meta({ id: 'Change' });

export const ticketInfo = z
  .object({
    firstResponse: nullable(instant).meta({
      description: 'When someone other than the requester first commented.',
    }),
    lastComment: nullable(instant),
    daysSinceLastComment: nullable(z.number().int()),
    participants: z.array(person).meta({
      description: 'The requester, the assignee and everyone who wrote a comment.',
    }),
    timeInStatus: z.array(
      z
        .object({
          status: z.object({ id, name: z.string() }).loose(),
          seconds: z.number().int(),
          visits: z.number().int(),
        })
        .loose(),
    ),
  })
  .loose()
  .meta({
    id: 'TicketInfo',
    description:
      'Read-only info fields, computed from comments and history. Only comments everyone who sees the ticket may read count.',
  });

export const comment = z
  .object({
    id,
    author: nullable(person),
    body: z.unknown().meta({ description: 'Rich text, in the format the request asked for.' }),
    visibility: nullable(z.object({}).loose()),
    version: z.number().int(),
    createdAt: instant,
    updatedAt: instant,
  })
  .loose()
  .meta({ id: 'Comment' });

export const link = z
  .object({
    id,
    type: z.object({ id, name: z.string() }).loose(),
    direction: z.enum(['outward', 'inward']),
    phrase: z.string(),
    ticket: z.object({ id, key: z.string(), summary: z.string(), closed: z.boolean() }).loose(),
    createdAt: instant,
  })
  .loose()
  .meta({ id: 'Link' });

export const linkType = z
  .object({ id, name: z.string(), outward: z.string(), inward: z.string(), isCopy: z.boolean() })
  .loose()
  .meta({ id: 'LinkType' });

export const timeEntry = z
  .object({
    id,
    author: nullable(person),
    startedAt: instant,
    duration: z.number().int().meta({ description: 'Seconds.' }),
    description: z.string(),
    createdAt: instant,
    updatedAt: instant,
  })
  .loose()
  .meta({ id: 'TimeEntry' });

export const savedSearch = z
  .object({
    id,
    name: z.string(),
    description: z.string(),
    query: z.string(),
    owner: person,
    shares: z.array(z.unknown()),
    starred: z.boolean(),
    editable: z.boolean(),
    version: z.number().int(),
    createdAt: instant,
    updatedAt: instant,
  })
  .loose()
  .meta({ id: 'SavedSearch' });

const location = z
  .union([
    z
      .object({
        type: z.literal('track'),
        track: z.object({ id, key: z.string(), name: z.string() }).loose(),
      })
      .loose(),
    z
      .object({
        type: z.literal('user'),
        user: z.object({ id, name: nullable(z.string()) }).loose(),
      })
      .loose(),
  ])
  .meta({ description: 'Where the board lives: a track, or a person’s own space.' });

export const boardSummary = z
  .object({
    id,
    name: z.string(),
    description: z.string(),
    kind: z.enum(['scrum', 'kanban']),
    location,
  })
  .loose()
  .meta({ id: 'BoardSummary' });

export const board = boardSummary
  .extend({
    columns: z.array(
      z.object({ id: z.string(), name: z.string(), statusIds: z.array(id) }).loose(),
    ),
    version: z.number().int(),
  })
  .meta({ id: 'Board' });

export const sprint = z
  .object({
    id,
    boardId: id,
    name: z.string(),
    goal: z.string(),
    state: z.enum(['future', 'active', 'closed']),
    sequence: z.number().int(),
    startAt: nullable(instant),
    endAt: nullable(instant),
    startedAt: nullable(instant),
    completedAt: nullable(instant),
    version: z.number().int(),
  })
  .loose()
  .meta({ id: 'Sprint' });

const backlogTicket = z
  .object({
    id,
    key: z.string(),
    summary: z.string(),
    status: z.object({ id, name: z.string() }).loose(),
    done: z.boolean(),
  })
  .loose();
const totals = z.object({ tickets: z.number().int(), estimate: z.number() }).loose();
export const backlog = z
  .object({
    sprints: z.array(sprint.extend({ tickets: z.array(backlogTicket), totals })),
    backlog: z.object({ tickets: z.array(backlogTicket), totals }).loose(),
    truncated: z.boolean(),
  })
  .loose()
  .meta({ id: 'Backlog' });

export const boardData = z
  .object({
    columns: z.array(
      z.object({ id: z.string(), name: z.string(), count: z.number().int() }).loose(),
    ),
    lanes: z.array(z.object({ id: z.string(), name: z.string() }).loose()),
    cards: z.array(
      z
        .object({
          id,
          key: z.string(),
          summary: z.string(),
          columnId: z.string(),
          laneId: z.string(),
          rank: z.string(),
          version: z.number().int(),
        })
        .loose(),
    ),
    truncated: z.boolean(),
  })
  .loose()
  .meta({ id: 'BoardData' });

export const release = z
  .object({
    id,
    trackId: id,
    name: z.string(),
    description: z.string(),
    startDate: nullable(day),
    releaseDate: nullable(day),
    shipped: z.boolean(),
    archived: z.boolean(),
    progress: z
      .object({ tickets: z.number().int(), closed: z.number().int(), open: z.number().int() })
      .loose(),
    overdue: z.boolean(),
  })
  .loose()
  .meta({ id: 'Release' });

export const priority = z
  .object({ id, name: z.string(), description: z.string(), order: z.number().int() })
  .loose()
  .meta({ id: 'Priority' });

export const status = z
  .object({ id, name: z.string(), description: z.string(), stage, order: z.number().int() })
  .loose()
  .meta({ id: 'Status' });

export const field = z
  .object({ id, name: z.string(), type: z.string() })
  .loose()
  .meta({ id: 'Field' });

export const signedInUser = z
  .object({
    id,
    email: z.string(),
    name: z.string(),
    isSiteAdmin: z.boolean(),
    timeZone: nullable(z.string()),
    locale: nullable(z.string()),
  })
  .loose()
  .meta({ id: 'SignedInUser' });

export const queryCheck = z
  .union([
    z
      .object({
        ok: z.literal(true),
        fields: z.array(z.object({ name: z.string() }).loose()),
        orderBy: z.array(z.object({ field: z.string(), direction: z.string() }).loose()),
      })
      .loose(),
    z
      .object({
        ok: z.literal(false),
        error: z
          .object({
            message: z.string(),
            position: z.number().int(),
            length: z.number().int(),
          })
          .loose(),
      })
      .loose(),
  ])
  .meta({ id: 'QueryCheck' });
