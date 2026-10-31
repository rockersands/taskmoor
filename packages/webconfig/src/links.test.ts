import { describe, expect, it } from 'vitest';
import { importedLinkOf, importedLinkRoute, importedTargetRoute } from './links';

describe('links from the tracker an import came from (M1-128)', () => {
  it('[IMP-011] reads issue and project links as ticket and track routes', () => {
    expect(importedLinkRoute('/browse/ABC-42', '?focusedCommentId=10101')).toBe('#/tickets/ABC-42');
    expect(importedLinkRoute('browse/abc-42/', '')).toBe('#/tickets/ABC-42');
    expect(importedLinkRoute('/browse/ABC', '')).toBe('#/tracks/ABC');
    expect(importedLinkRoute('/projects/ABC/issues/ABC-7', '?filter=allissues')).toBe(
      '#/tickets/ABC-7',
    );
    expect(importedLinkRoute('/browse/ABC-42/extra', '')).toBeNull();
    expect(importedLinkRoute('/browse/<script>', '')).toBeNull();
  });

  it('[IMP-011] reads filter, query, board and dashboard links', () => {
    expect(importedLinkRoute('/issues/', '?filter=10010')).toBe('#/imported/saved-search/10010');
    expect(importedLinkRoute('/issues', 'filter=10010')).toBe('#/imported/saved-search/10010');
    expect(importedLinkRoute('/secure/IssueNavigator.jspa', '?mode=hide&requestId=10010')).toBe(
      '#/imported/saved-search/10010',
    );
    expect(importedLinkRoute('/issues/', '?jql=project%20%3D%20ABC')).toBe(
      '#/search?q=project+%3D+ABC',
    );
    expect(importedLinkRoute('/issues/', '?filter=-1')).toBe('#/search');
    expect(importedLinkRoute('/secure/RapidBoard.jspa', '?rapidView=12&view=planning')).toBe(
      '#/imported/board/12',
    );
    expect(importedLinkRoute('/secure/Dashboard.jspa', '?selectPageId=10100')).toBe(
      '#/imported/dashboard/10100',
    );
    expect(importedLinkRoute('/secure/RapidBoard.jspa', '')).toBe('#/boards');
    expect(importedLinkRoute('/search', '')).toBeNull();
    expect(importedLinkRoute('/boards/7', '')).toBeNull();
  });

  it('[IMP-011] reads the app route of an imported link and of its target', () => {
    expect(importedLinkOf('#/imported/board/12')).toEqual({ kind: 'board', id: '12' });
    expect(importedLinkOf('#/imported/ticket/12')).toBeNull();
    expect(importedTargetRoute('saved-search', 41)).toBe('#/search?savedSearch=41');
    expect(importedTargetRoute('board', 7)).toBe('#/boards/7');
    expect(importedTargetRoute('dashboard', 3)).toBe('#/dashboards/3');
  });
});
