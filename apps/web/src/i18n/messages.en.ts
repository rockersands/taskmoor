/**
 * English source strings in ICU MessageFormat. Every user-visible string in the app lives here
 * under a stable ID; other locales are keyed the same way. Keep IDs grouped by screen.
 */
export const messagesEn = {
  'app.name': 'Tracksmith',
  'shell.skipToContent': 'Skip to content',
  'shell.openNavigation': 'Open navigation',
  'shell.closeNavigation': 'Close navigation',
  'shell.collapseSidebar': 'Collapse sidebar',
  'shell.expandSidebar': 'Expand sidebar',
  'shell.mainNavigation': 'Main',
  'shell.navigationDialog': 'Navigation',
  'nav.home': 'Home',
  'nav.projects': 'Projects',
  'nav.boards': 'Boards',
  'nav.search': 'Search',
  'nav.dashboards': 'Dashboards',
  'nav.settings': 'Settings',
  'page.underConstruction': 'This area is under construction.',
  'page.itemCount': '{count, plural, =0 {No items} one {# item} other {# items}}',
} as const;

export type MessageId = keyof typeof messagesEn;
