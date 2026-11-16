# ADR-036: Skins and the soft visual language

- Status: Accepted
- Date: 2026-10-13
- Backlog: M1-122

## Context

On 2026-10-12 the user asked for the final interface to support skins, starting with a light
and a dark one, and for the base design to follow a reference they shared: a soft pastel
interface with cream, peach, blush and powder-blue tones on a warm lavender-grey canvas, large
rounded cards floating on soft layered shadows, pill-shaped fields and buttons, circular icon
controls, gentle gradients and organic wave shapes. The M0 design system (ADR-024) had one
neutral palette whose dark variant followed only the operating system.

## Decision

- **Skins** are named sets of design tokens. The first two are `light` ("Soft daylight") and
  `dark` ("Soft night"). The document root carries `data-skin`; components read only the
  tokens, never a colour. Adding a skin means one token block in `tokens.css`, one entry in
  `apps/web/src/skins/skins.ts` and its axe runs; the server only checks the shape of a skin
  name, so no migration or API change is needed.
- **Choosing a skin:** Account, Appearance offers System, Light and Dark. System follows
  `prefers-color-scheme` and changes with it. The choice applies at once, is remembered in the
  browser and is saved with the account (`app_user.appearance`, `PATCH /api/v1/account`), so it
  follows the person to other devices; the sign-in answer and `GET /api/v1/session` carry it.
  A small script in the page head (`public/skin-boot.js`, a file rather than inline code so a
  strict Content-Security-Policy stays possible) sets `data-skin` before the first paint, so a
  dark-skin person never sees a light flash. A skin name the frontend does not know reads as
  System.
- **Tokens are semantic and layered:** the canvas (page background, a soft gradient with
  pastel glows), surface, raised and sunken surfaces, text and muted text, a primary fill
  (peach) with its text colour, an accent for links and the current place, secondary tones
  (powder blue, blush, butter) each with a soft variant, focus, success, warning and danger
  with soft variants, hairline and field borders, three shadow levels plus an inset shadow for
  sunken controls, and radii of 10, 16, 24 and 32 pixels plus pill. The M0 token names stay as
  aliases (`--color-bg` is the canvas colour, `--color-accent` the accent), so older styles keep
  working while they move over.
- **Shapes:** cards, fieldsets and panels use the large radii and soft shadows and lose hard
  borders; the top bar and the sidebar float as rounded panels on the canvas; buttons and
  single-line fields are pills; icon buttons, avatars and toggles are circles; decoration uses
  original wave shapes drawn for Taskmoor, painted in the skin's soft tints through a CSS mask
  along the bottom of the stand-alone pages (sign-in, setup, password links) only; text keeps
  its contrast on those tints.
- **Contrast first:** pastel fills carry dark text. Measured with the WCAG formula: text on
  every surface is at least 12:1, muted text at least 5.6:1, accent, status and secondary
  texts on their soft fills at least 5.1:1, field borders and focus rings at least 3:1, in both
  skins. Every story runs its axe checks in both skins (two Vitest browser projects), so a skin
  cannot ship with a contrast failure.
- **Motion** is short (120 to 200 ms) and stops under `prefers-reduced-motion`.
- **Fonts** stay system fonts or self-hosted (no font CDN: installs may be air-gapped). A vendored
  font may be under SIL OFL 1.1, shipped unmodified with its licence and a note in
  `THIRD_PARTY_NOTICES` (Google Sans for Google's sign-in button, T-262).

## Options considered

| Option | For | Against |
|---|---|---|
| Tokens on `[data-skin]` with a boot script (chosen) | One block per skin; no flash; works with a strict CSP | A tiny extra request |
| Media query only (M0) | No script | No choice per person; not saved with the account |
| CSS-in-JS themes | Typed tokens | Runtime cost; a second styling system next to plain CSS |

## Consequences

Every component's CSS reads semantic tokens; the Storybook tests run twice. A third skin (for
example high contrast) is a token block, a list entry and its axe runs. The wave decoration is
a mask filled with token colours, so it follows the skin. Screens built later (boards, tickets)
start from the same tokens and shapes; the M0 token names remain as aliases until every style
has moved to the semantic names.
