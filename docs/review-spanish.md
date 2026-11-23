# Reviewing the Spanish translation

Everything Taskmoor shows comes from two catalogues: `apps/web/src/i18n/messages.en.ts` (English)
and `apps/web/src/i18n/messages.es.ts` (Spanish, written as a draft). `pnpm demo` runs the whole
product on your own computer, in Spanish, with sample people, tracks, releases and tickets, so you
can read every screen where it is used.

## Start it

You need Git and Node.js 22 (nodejs.org). No Docker, no database to install: the demo brings its
own PostgreSQL.

```
git clone https://github.com/Rockersands/taskmoor
cd taskmoor
corepack enable
corepack pnpm install
corepack pnpm demo
```

The first start builds the frontend and adds the sample data (a few minutes). A later start builds
the frontend again only when a pull changed it (its files, the packages it uses or its version), so
you always review the strings of the checkout you have. It then prints the address,
http://localhost:8080, and a one-time link per person to set a password. Open the site
administrator's link first: it can see and change everything. The other links sign you in as
ordinary people, who see less. Each start prints new links.

`Ctrl+C` stops it. The tickets stay in the database under `.cache/pg-test/demo` and the attachments
in `.cache/demo`. `corepack pnpm demo --fresh` removes only the attachments and keeps the database,
and `--port 9090` uses another port. Sample tickets move freely between statuses; why one moved goes
in a comment.

## What to look at

- Every page in the menu (Inicio, Bandeja de entrada, Tracks, Tableros, Buscar, Paneles,
  Configuración) and the administration pages under Configuración.
- Dialogs, error messages, empty states and confirmations: create a ticket, a board and a saved
  search; try to save a form with a field missing; delete something and restore it from the trash.
- Plurals and numbers ("1 ticket", "3 tickets"), dates and times.
- The sample tickets' own text is English on purpose (it is data, not the interface).
- A release's notes: **Copiar como Markdown** and **Descargar en Markdown** on a shipped release
  write Spanish too. That text is written by the server, in
  `apps/server/src/releases/notes-text.ts` (the dating sentence and the seeded types' names).

## Telling us what to change

The simplest is a list: the English text or the screen, and the Spanish you want. Or edit
`apps/web/src/i18n/messages.es.ts` directly: each line is an ID and its Spanish text, and the
English one with the same ID is in `messages.en.ts`. Placeholders in braces (`{count}`, `{name}`)
must stay as they are.
