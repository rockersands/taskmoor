// What makes the sweep's pages worth looking at (tools/sweep/routes.mjs): a Scrum board with a
// finished and a running sprint, dated tickets, an outcome, a release, a plan, a dashboard, a track
// group, a workflow draft and so on, added through the API with the administrator's session, in
// the private demo only. It looks before it adds, so a later run on the same data adds nothing.
const STAMP = 'Sweep';

/**
 * Every row of a list the API answers a page at a time (`next`, sent back as `?after=`), such as
 * teams since T-286. `get` reads one path; `key` names the rows in each answer.
 */
export async function everyPage(get, path, key) {
  const rows = [];
  const seen = new Set();
  let after = null;
  do {
    const joiner = path.includes('?') ? '&' : '?';
    const page = await get(
      after === null ? path : `${path}${joiner}after=${encodeURIComponent(after)}`,
    );
    rows.push(...(page?.[key] ?? []));
    seen.add(after);
    after = page?.next ?? null;
  } while (after !== null && !seen.has(after));
  return rows;
}

/** A day this many days from today, as the API writes one. */
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export async function seedDemo(request, url) {
  const problems = [];
  const call = async (method, path, data) => {
    const answer = await request[method](`${url}/api/v1${path}`, data ? { data } : {});
    if (!answer.ok()) {
      const text = await answer.text().catch(() => '');
      throw new Error(`${method} ${path}: ${answer.status()} ${text.slice(0, 200)}`);
    }
    return answer.status() === 204 ? null : answer.json().catch(() => null);
  };
  const get = (path) => call('get', path);
  const post = (path, data) => call('post', path, data ?? {});
  /** One piece of data; a failure is reported, and the routes that need it say so. */
  const step = async (what, work) => {
    try {
      return await work();
    } catch (error) {
      problems.push(`${what}: ${error.message}`);
      return null;
    }
  };

  const ids = {};
  const { tracks } = await get('/tracks');
  const mobile = tracks.find((t) => t.key === 'MOB') ?? tracks[0];
  const web = tracks.find((t) => t.key === 'WEB') ?? tracks[1] ?? tracks[0];
  ids.track = mobile.key;
  ids.trackId = mobile.id;
  ids.kanbanTrack = web.key;
  ids.kanbanTrackId = web.id;

  const search = async (q, limit = 50) =>
    (await get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`)).tickets ?? [];

  // The Scrum board, with its sprints.
  const boards = (await get('/boards')).boards;
  const inTrack = (id) => boards.find((b) => b.location?.track?.id === id);
  ids.kanbanBoard = inTrack(web.id)?.id ?? null;
  let scrum = inTrack(mobile.id);
  if (!scrum) {
    scrum = await step(
      'scrum board',
      async () =>
        (
          await post('/boards', {
            name: mobile.name,
            kind: 'scrum',
            trackId: mobile.id,
            source: { query: `track = "${mobile.key}"` },
          })
        ).board,
    );
  }
  ids.board = scrum?.id ?? null;

  const typesOf = await step(
    'ticket types',
    async () => (await get(`/tracks/${mobile.key}/ticket-types`)).ticketTypes,
  );
  const typeNamed = (name) => typesOf?.find((t) => t.name === name)?.id;

  // Dated tickets, a feature under an outcome, a subticket, a rich description and a comment.
  const own = await step('find own tickets', () =>
    search(`track = "${mobile.key}" AND summary ~ "${STAMP}"`),
  );
  const made = {};
  const ticket = async (name, data) => {
    const summary = `${STAMP}: ${name}`;
    const found = own?.find((t) => (t.summary ?? t.fields?.summary) === summary);
    if (found) return found;
    return (await post('/tickets?format=markdown', { track: mobile.key, summary, ...data })).ticket;
  };
  await step('tickets', async () => {
    made.outcome = await ticket('Reach the app stores before the holidays', {
      ticketTypeId: typeNamed('Outcome'),
      description: 'Everything the first public release needs.',
    });
    made.feature = await ticket('Offline sign-in on both phones', {
      ticketTypeId: typeNamed('Feature'),
      parent: made.outcome.key,
      startDate: day(-6),
      dueDate: day(8),
      description:
        '## What this is\n\nPeople **sign in once** and stay signed in without a connection. See [the notes](https://example.com/notes).\n\n- First point of the list\n- Second point, a little longer than the first so it wraps on a phone\n\n```\nconst retries = 3;\n```',
    });
    made.dated = await ticket('Crash report when the camera is refused', {
      startDate: day(-2),
      dueDate: day(3),
      description: 'A short description.',
    });
    made.later = await ticket(
      'A rather long summary, to see how a title of many words wraps on every page that shows one',
      { startDate: day(4), dueDate: day(20) },
    );
    made.sub = await ticket('Keep the token in the safe store of the phone', {
      ticketTypeId: typeNamed('Subticket'),
      parent: made.feature.key,
    });
    ids.ticket = made.feature.key;
    ids.ticketId = made.feature.id;
    ids.outcome = made.outcome.key;
  });
  if (ids.ticket) {
    await step('comment', async () => {
      const { comments } = await get(`/tickets/${ids.ticket}/comments`);
      if (!comments?.length) {
        await post(`/tickets/${ids.ticket}/comments?format=markdown`, {
          body: 'A comment with **some weight** and a [link](https://example.com).',
        });
      }
    });
    await step('checklist', async () => {
      const { checklists } = await get(`/tickets/${ids.ticketId}/checklists`);
      if (!checklists?.length) {
        await post(`/tickets/${ids.ticketId}/checklists`, {
          name: 'Before it ships',
          items: ['Tried on an old phone', 'Tried with no connection'],
        });
      }
    });
  }

  // A sprint that finished, one that runs and one to come.
  if (ids.board) {
    await step('sprints', async () => {
      const sprints = (await get(`/boards/${ids.board}/sprints`)).sprints ?? [];
      const tickets = await search(`track = "${mobile.key}"`, 30);
      const tids = tickets.map((t) => t.id);
      let closed = sprints.find((s) => s.state === 'closed');
      let active = sprints.find((s) => s.state === 'active');
      if (!closed) {
        closed = active ?? (await post(`/boards/${ids.board}/sprints`, {})).sprint;
        active = null;
        if (closed.state !== 'active') {
          if (tids.length) {
            await post(`/sprints/${closed.id}/tickets`, { tickets: tids.slice(0, 6) });
          }
          await post(`/sprints/${closed.id}/start`, {
            endAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        await post(`/sprints/${closed.id}/complete`, { moveTo: { type: 'backlog' } });
      }
      ids.closedSprint = closed.id;
      if (!active) {
        active = (await post(`/boards/${ids.board}/sprints`, {})).sprint;
        if (tids.length)
          await post(`/sprints/${active.id}/tickets`, { tickets: tids.slice(6, 14) });
        await post(`/sprints/${active.id}/start`, { endAt: `${day(10)}T17:00:00Z` });
      }
      ids.activeSprint = active.id;
      if (sprints.length < 3) {
        const next = (await post(`/boards/${ids.board}/sprints`, {})).sprint;
        if (tids.length > 14) {
          await post(`/sprints/${next.id}/tickets`, { tickets: tids.slice(14, 18) });
        }
      }
    });
  }

  // A release that is coming, beside what the sample data has.
  await step('release', async () => {
    const { releases } = await get(`/tracks/${mobile.id}/releases`);
    let release = releases.find((r) => r.name === `${STAMP} 3.0`);
    if (!release) {
      release = (
        await post(`/tracks/${mobile.id}/releases`, { name: `${STAMP} 3.0`, releaseDate: day(30) })
      ).release;
    }
    ids.release = release.id;
  });

  await step('saved search', async () => {
    const { savedSearches } = await get('/saved-searches');
    let saved = savedSearches.find((s) => s.name === `${STAMP} search`);
    if (!saved) {
      saved = (
        await post('/saved-searches', {
          name: `${STAMP} search`,
          query: `track = "${mobile.key}"`,
        })
      ).savedSearch;
    }
    ids.savedSearch = saved.id;
  });

  await step('dashboard', async () => {
    const { dashboards } = await get('/dashboards');
    let dashboard = dashboards.find((d) => d.name === `${STAMP} dashboard`);
    if (!dashboard) {
      dashboard = (
        await post('/dashboards', {
          name: `${STAMP} dashboard`,
          layout: 'two',
          widgets: [
            { kind: 'introduction', column: 0, config: { text: 'What this team is working on.' } },
            {
              kind: 'pie',
              column: 1,
              config: { query: `track = "${mobile.key}"`, field: 'status' },
            },
          ],
        })
      ).dashboard;
    }
    ids.dashboard = dashboard.id;
  });

  await step('plan', async () => {
    const { plans } = await get('/plans');
    let plan = plans.find((p) => p.name === `${STAMP} plan`);
    if (!plan) {
      plan = (
        await post('/plans', {
          name: `${STAMP} plan`,
          sources: [mobile.id, web.id].map((trackId) => ({ kind: 'track', trackId })),
        })
      ).plan;
    }
    ids.plan = plan.id;
  });

  await step('track group', async () => {
    const { groups } = await get('/track-groups');
    if (!groups.some((g) => g.name === `${STAMP} group`)) {
      await post('/track-groups', { name: `${STAMP} group`, trackIds: [mobile.id, web.id] });
    }
  });

  // A second workflow next to the default, which no track uses (created published, version 1).
  await step('workflow draft', async () => {
    const { workflows } = await get('/workflows');
    ids.workflow = workflows.find((w) => w.isDefault)?.id ?? workflows[0]?.id;
    let draft = workflows.find((w) => w.name === `${STAMP} draft`);
    if (!draft) {
      const { workflow } = await get(`/workflows/${ids.workflow}`);
      const definition =
        workflow.draft?.definition ?? workflow.published?.definition ?? workflow.definition;
      draft = (
        await post('/workflows', {
          name: `${STAMP} draft`,
          description: 'A second workflow, which no track uses.',
          definition,
        })
      ).workflow;
    }
    ids.workflowDraft = draft.id;
  });

  await step('layout set', async () => {
    const { layoutSets } = await get('/layout-sets');
    const own =
      layoutSets.find((l) => l.name === `${STAMP} layouts`) ??
      (await post('/layout-sets', { name: `${STAMP} layouts`, layouts: [] })).layoutSet;
    ids.layoutSet = own.id;
  });

  // A track run on its own (local mode) for the pages only such a track has.
  await step('local track', async () => {
    const local =
      tracks.find((t) => t.key === 'SWEEPL') ??
      (await post('/tracks', { key: 'SWEEPL', name: `${STAMP} local track`, mode: 'local' })).track;
    ids.localTrack = local.key;
    ids.localTrackId = local.id;
  });

  await step('bulk operation', async () => {
    const { bulkOperations } = await get('/bulk-operations');
    let bulk = bulkOperations[0];
    if (!bulk && ids.ticket) {
      bulk = (
        await post('/bulk-operations', {
          action: 'edit',
          tickets: [ids.ticket, `${mobile.key}-999999`],
          edit: { labels: ['sweep'] },
        })
      ).bulkOperation;
    }
    ids.bulk = bulk?.id;
  });

  await step('team', async () => {
    // Teams come a page at a time (T-286): the name narrows them, and every page is read.
    const teams = await everyPage(
      get,
      `/teams?query=${encodeURIComponent(`${STAMP} team`)}`,
      'teams',
    );
    if (!teams.some((t) => t.name === `${STAMP} team`)) {
      await post('/teams', { name: `${STAMP} team` });
    }
  });
  await step('service account', async () => {
    const { serviceAccounts } = await get('/service-accounts');
    if (!serviceAccounts.some((s) => s.name === `${STAMP} robot`)) {
      await post('/service-accounts', {
        name: `${STAMP} robot`,
        description: 'Posts build results.',
      });
    }
  });
  await step('ticket template', async () => {
    const { templates } = await get(`/ticket-templates?track=${mobile.key}`);
    if (!templates.some((t) => t.name === `${STAMP} template`)) {
      await post('/ticket-templates', {
        name: `${STAMP} template`,
        track: mobile.key,
        summary: 'A new crash report',
      });
    }
  });
  await step('something in the trash', async () => {
    const { tickets } = await get('/trash');
    if (!tickets.length) {
      const thrown = (
        await post('/tickets', { track: mobile.key, summary: `${STAMP}: thrown away` })
      ).ticket;
      await call('delete', `/tickets/${thrown.key}`);
    }
  });

  return { ids, problems };
}
