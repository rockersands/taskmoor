/**
 * Duplicate suggestion eval corpus (M1-133; AI-016; ADR-107): clusters of tickets that describe
 * the same problem in different words, and near misses that share the words of a cluster but
 * describe another problem.
 *
 * Provenance: synthetic. Written for Taskmoor on 2026-11-01 by the M1-133 task, in our own
 * words; no real ticket or product text. English only, as the bundled embedding model is
 * (M1-078, all-MiniLM-L6-v2).
 *
 * Every member of a cluster is a query once: the rest of the pool is searched, and the other
 * members are its true duplicates. To add a case: add a cluster of two or three tickets that a
 * person would close as duplicates of each other, and at least one near miss that a person
 * would not, then run the eval tests.
 */
export interface DuplicateTicket {
  id: string;
  summary: string;
  description: string;
  /** The cluster it belongs to (the same problem). */
  cluster?: string;
  /** The cluster it looks like but is not (a near miss). */
  nearMissOf?: string;
}

type Cluster = [id: string, members: [string, string][], nearMisses: [string, string][]];

const CLUSTERS: Cluster[] = [
  [
    'D01',
    [
      [
        'Login fails after resetting the password',
        'I reset my password and now the sign-in page says the credentials are wrong.',
      ],
      [
        'Cannot sign in following a credential change',
        'Since changing my password yesterday every attempt to log in is refused.',
      ],
      [
        'Password reset leaves me locked out',
        'After choosing a new password the account cannot be opened at all.',
      ],
    ],
    [
      [
        'Password reset email arrives late',
        'The reset link reaches the inbox about an hour after asking for it.',
      ],
    ],
  ],
  [
    'D02',
    [
      [
        'Invoice PDF shows the wrong VAT total',
        'The VAT line on the PDF does not add up to the sum of the items.',
      ],
      [
        'Tax amount on downloaded invoices is miscalculated',
        'Downloaded invoices charge more tax than the order did.',
      ],
    ],
    [
      [
        'Add a VAT number field to invoices',
        'Business customers want their VAT number printed on the invoice.',
      ],
    ],
  ],
  [
    'D03',
    [
      [
        'App crashes when uploading a photo on Android',
        'Choosing a picture from the gallery closes the app immediately.',
      ],
      [
        'Android client closes itself while attaching an image',
        'Attaching an image to a ticket on Android quits the application.',
      ],
    ],
    [
      [
        'Photo upload is slow on Android',
        'Uploading one picture takes almost a minute on a good connection.',
      ],
    ],
  ],
  [
    'D04',
    [
      [
        'Search returns nothing for words with accents',
        'Searching for café or München finds no tickets, though they exist.',
      ],
      [
        'Queries containing é or ü never match',
        'Any search term with an accented letter gives an empty result list.',
      ],
    ],
    [
      [
        'Search results show accented letters as question marks',
        'Summaries with accents are displayed wrongly in the result list.',
      ],
    ],
  ],
  [
    'D05',
    [
      [
        'Dark mode text is unreadable in settings',
        'With the dark theme on, the labels in settings can hardly be read.',
      ],
      [
        'Settings labels are black on dark grey in the dark theme',
        'The settings page keeps black text when the dark theme is chosen.',
      ],
    ],
    [
      [
        'Add dark mode to the email templates',
        'Notification emails should follow the dark theme too.',
      ],
    ],
  ],
  [
    'D06',
    [
      ['Webhook deliveries are sent twice', 'Every webhook event reaches our endpoint two times.'],
      [
        'Partners receive every event duplicated',
        'Our partner sees each notification from the API arrive in pairs.',
      ],
    ],
    [
      [
        'Webhook deliveries are not retried after a timeout',
        'When our endpoint is slow the event is dropped instead of retried.',
      ],
    ],
  ],
  [
    'D07',
    [
      [
        'CSV export cuts off after 1000 rows',
        'Exporting a search with 5000 tickets gives a file with exactly 1000.',
      ],
      [
        'Exported spreadsheet is missing everything past the thousandth line',
        'Big exports stop at line one thousand without a warning.',
      ],
      [
        'Large exports are truncated',
        'Only part of the results ends up in the downloaded file when there are many.',
      ],
    ],
    [
      [
        'CSV export uses the wrong date format',
        'Dates in the exported file are month first, we expect day first.',
      ],
    ],
  ],
  [
    'D08',
    [
      [
        'Notifications arrive hours late on iOS',
        'Push notifications on iPhone show up long after the event happened.',
      ],
      [
        'Push messages on iPhone are delayed by a long time',
        'Alerts reach my iPhone three or four hours late.',
      ],
    ],
    [
      [
        'Notifications show the wrong sender name on iOS',
        'Push messages on iPhone name the app instead of the person.',
      ],
    ],
  ],
  [
    'D09',
    [
      [
        'Session expires while typing a long comment',
        'I write a long comment, press save, and I am signed out with the text gone.',
      ],
      [
        'Logged out in the middle of writing and my text is lost',
        'Halfway through a reply the app asks me to sign in again and the draft disappears.',
      ],
    ],
    [
      [
        'Comments lose formatting when pasted from a document',
        'Bold and lists vanish when I paste text from a word processor.',
      ],
    ],
  ],
  [
    'D10',
    [
      [
        'Checkout button stays disabled after removing a coupon',
        'Once I remove a coupon the pay button cannot be clicked any more.',
      ],
      [
        'Cannot pay once a discount code has been deleted',
        'Deleting the discount code blocks the payment step completely.',
      ],
    ],
    [['Coupon codes are case sensitive', 'Typing the code in small letters says it is not valid.']],
  ],
  [
    'D11',
    [
      [
        'Calendar shows events one day early for users in Asia',
        'People in Singapore and Tokyo see every event on the previous day.',
      ],
      [
        'Due dates are off by a day in the Tokyo time zone',
        'A ticket due on Friday shows Thursday for our team in Japan.',
      ],
    ],
    [
      [
        'Calendar view is slow with many events',
        'A month with two hundred events takes ten seconds to show.',
      ],
    ],
  ],
  [
    'D12',
    [
      [
        'Two-factor codes are rejected as invalid',
        'The six-digit code from my phone is always refused at sign-in.',
      ],
      [
        'Authenticator app codes never work',
        'Codes from the authenticator app fail every time, even fresh ones.',
      ],
    ],
    [
      [
        'Add backup codes for two-factor sign-in',
        'People who lose their phone need a way to get in.',
      ],
    ],
  ],
  [
    'D13',
    [
      [
        'Backup job fails when the disk is nearly full',
        'The nightly backup stops with an error when the volume has little space.',
      ],
      [
        'Nightly backup aborts with no space left on device',
        'Last night the backup ended early, the log says the device is full.',
      ],
    ],
    [['Backups take longer every week', 'The backup window grows by about ten minutes each week.']],
  ],
  [
    'D14',
    [
      [
        'Profile picture upload ignores the crop',
        'I crop my photo but the saved picture is the full original.',
      ],
      [
        'Avatar is saved uncropped after adjusting the frame',
        'Moving the crop frame has no effect on the avatar that is stored.',
      ],
    ],
    [['Allow GIFs as profile pictures', 'Animated pictures should be accepted for avatars.']],
  ],
  [
    'D15',
    [
      [
        'Keyboard focus is lost after closing a dialog',
        'When a dialog closes, focus does not return to the button that opened it.',
      ],
      [
        'Tabbing starts from the top of the page after a modal closes',
        'Keyboard users are sent back to the first link whenever a modal is dismissed.',
      ],
    ],
    [
      [
        'Dialogs cannot be closed with the Escape key',
        'Pressing Escape does nothing in the edit dialog.',
      ],
    ],
  ],
  [
    'D16',
    [
      [
        'Rate limiter blocks requests from the office network',
        'Our whole office gets refused by the API during the morning.',
      ],
      [
        'Everyone behind our company IP gets 429 errors',
        'All requests from the shared company address answer too many requests.',
      ],
    ],
    [
      [
        'Show the remaining rate limit in API responses',
        'Clients want a header with the requests left in the window.',
      ],
    ],
  ],
  [
    'D17',
    [
      [
        'Offline edits are lost when the app reconnects',
        'Changes made in airplane mode vanish once the phone is online.',
      ],
      [
        'Changes made without network disappear after sync',
        'Whatever I edit offline is overwritten by the server copy.',
      ],
    ],
    [
      [
        'Show an offline banner when the connection drops',
        'People do not notice that the app is offline.',
      ],
    ],
  ],
  [
    'D18',
    [
      [
        'Report charts render blank in Safari',
        'The charts on the reports page are empty in Safari, fine in Firefox.',
      ],
      [
        'Safari shows empty boxes where the graphs should be',
        'On a Mac with Safari every graph area stays white.',
      ],
    ],
    [
      [
        'Report charts use colours that are hard to tell apart',
        'Two of the series are nearly the same green.',
      ],
    ],
  ],
  [
    'D19',
    [
      [
        'Email digest is sent to deactivated users',
        'People whose accounts were deactivated still receive the weekly digest.',
      ],
      [
        'People who left the company still get the weekly summary mail',
        'Former staff keep getting our summary email every Monday.',
      ],
    ],
    [
      [
        'Let users choose the day of the weekly digest',
        'Some teams want the digest on Friday instead of Monday.',
      ],
    ],
  ],
  [
    'D20',
    [
      [
        'Sorting by priority puts urgent tickets last',
        'Ordering the list by priority shows low first and urgent at the bottom.',
      ],
      [
        'Priority order is reversed in the list view',
        'The most important tickets end up at the end when sorting by priority.',
      ],
    ],
    [['Add a priority filter to the list view', 'Let people show only urgent and high tickets.']],
  ],
  [
    'D21',
    [
      [
        'Refund endpoint returns 500 for partial refunds',
        'Refunding part of an order fails with a server error.',
      ],
      [
        'Partial refunds fail with an internal server error',
        'Giving back only some of the money gives an error page in the API.',
      ],
    ],
    [
      [
        'Refunds take five days to appear on statements',
        'Customers ask why the money is not back yet.',
      ],
    ],
  ],
  [
    'D22',
    [
      [
        'Memory use keeps growing until the worker restarts',
        'The background worker uses more memory every hour until it is restarted.',
      ],
      [
        'Background worker leaks memory and is killed every few hours',
        'The job runner is stopped by the system for running out of memory.',
      ],
    ],
    [
      [
        'Worker logs are too verbose',
        'The background worker writes a line for every job, which fills the disk.',
      ],
    ],
  ],
];

/** Tickets unlike any cluster, so the pool is not only pairs. */
const OTHERS: [string, string][] = [
  [
    'Translate the onboarding screens into Spanish',
    'New users in Spain and Mexico see English only.',
  ],
  ['Upgrade the database driver', 'The current version is no longer maintained.'],
  ['Add a link to the changelog in the footer', 'People ask where to read what changed.'],
  ['Write docs for the public API pagination', 'Explain cursors with an example.'],
  ['Remove the old feature flag for new boards', 'The flag has been on for everyone for months.'],
  [
    'Show the ticket count in each board column',
    'Teams want to see how much work sits in a column.',
  ],
  ['Allow emoji reactions on comments', 'A quick way to agree without writing a reply.'],
  ['Make the sidebar collapsible', 'Small screens need more room for the ticket list.'],
];

export const DUPLICATE_POOL: readonly DuplicateTicket[] = [
  ...CLUSTERS.flatMap(([cluster, members, misses]) => [
    ...members.map(([summary, description], i) => ({
      id: `${cluster}-${i + 1}`,
      summary,
      description,
      cluster,
    })),
    ...misses.map(([summary, description], i) => ({
      id: `${cluster}-n${i + 1}`,
      summary,
      description,
      nearMissOf: cluster,
    })),
  ]),
  ...OTHERS.map(([summary, description], i) => ({
    id: `X${String(i + 1).padStart(2, '0')}`,
    summary,
    description,
  })),
];
