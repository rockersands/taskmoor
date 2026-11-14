// The top of measurements.json (tools/sweep/routes.mjs): counts over every capture, and the worst
// routes and findings of each kind, so a reader starts from what matters.

const top = (map, n = 30) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, n)
    .map(([what, count]) => ({ what, count }));
const add = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

/**
 * Counts and the worst of each finding. Small controls are counted on phone captures in the light
 * skin (the dark skin repeats them), and names that leave out visible words at 1280 in the light
 * skin; sideways scroll is kept per width, at 360 from the phone's extra measurement.
 */
export function summarise(captures) {
  const sideways375 = new Map();
  const sideways360 = new Map();
  const sidewaysDesktop = new Map();
  const small = new Map();
  const smallPages = new Map();
  const axeRules = new Map();
  const axePages = new Map();
  const consoleErrors = new Map();
  const failed = new Map();
  const names = new Map();
  const namePages = new Map();
  const uniqueSmall = new Set();
  const uniqueNames = new Set();
  for (const c of captures) {
    if (c.sideways?.over > 0) {
      const byWidth = c.width === 375 ? sideways375 : sidewaysDesktop;
      byWidth.set(c.slug, Math.max(byWidth.get(c.slug) ?? 0, c.sideways.over));
    }
    if (c.sideways360?.over > 0) {
      sideways360.set(c.slug, Math.max(sideways360.get(c.slug) ?? 0, c.sideways360.over));
    }
    for (const s of c.small ?? []) {
      if (c.skin !== 'light') continue;
      add(smallPages, c.slug);
      add(small, `${s.role} "${s.name}" ${s.width}x${s.height}`);
      uniqueSmall.add(`${s.role}|${s.name}`);
    }
    for (const v of c.axe ?? []) {
      add(axeRules, `${v.id} (${v.impact})`, v.nodes);
      add(axePages, c.slug, v.nodes);
    }
    for (const line of c.console ?? []) add(consoleErrors, line);
    for (const line of c.failed ?? []) add(failed, line);
    for (const n of c.names ?? []) {
      if (c.skin !== 'light' || c.width !== 1280) continue;
      add(names, `${n.role} named "${n.name}" shows "${n.visible}"`);
      add(namePages, c.slug);
      uniqueNames.add(`${n.role}|${n.name}|${n.visible}`);
    }
  }
  return {
    captures: captures.length,
    errors: captures.filter((c) => c.error).length,
    statesThatFailed: captures.filter((c) => c.stateFailed).length,
    notSettled: captures.filter((c) => c.settled === false).length,
    picturesNotAsAPhone: captures.filter((c) => c.pictureProblem).length,
    counts: {
      sidewaysAt375: sideways375.size,
      sidewaysAt360: sideways360.size,
      sidewaysAt1280: sidewaysDesktop.size,
      smallControlsDistinct: uniqueSmall.size,
      axeRules: axeRules.size,
      axeNodes: [...axeRules.values()].reduce((a, b) => a + b, 0),
      consoleErrorsDistinct: consoleErrors.size,
      failedRequestsDistinct: failed.size,
      namesLeavingOutWordsDistinct: uniqueNames.size,
    },
    worst: {
      sidewaysAt375: top(sideways375),
      sidewaysAt360: top(sideways360),
      sidewaysAt1280: top(sidewaysDesktop),
      smallControlsByPage: top(smallPages),
      smallControls: top(small),
      axeByRule: top(axeRules),
      axeByPage: top(axePages),
      consoleErrors: top(consoleErrors),
      failedRequests: top(failed),
      namesLeavingOutWords: top(names),
      namesByPage: top(namePages),
    },
  };
}
