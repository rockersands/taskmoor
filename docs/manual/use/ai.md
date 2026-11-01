---
title: "Using AI features"
audience: users
sources: apps/web/src/ai/SummaryPanel.tsx, apps/web/src/ai/AskQuery.tsx, apps/web/src/ai/DraftFromText.tsx, apps/web/src/ai/BreakdownAction.tsx, apps/web/src/ai/FirstUse.tsx, apps/web/src/ai/AiNotice.tsx, apps/web/src/ai/AiFeature.tsx, apps/web/src/ai/client.ts, apps/web/src/tickets/DuplicateSuggestions.tsx, apps/web/src/tickets/CreateTicketPage.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/ai-features.ts, apps/server/src/routes/similar.ts, apps/server/src/ai/features/summary.ts, apps/server/src/ai/features/query.ts, apps/server/src/ai/features/drafts.ts, apps/server/src/ai/features/duplicates.ts, apps/server/src/ai/context.ts, docs/adr/0108-ai-v1-features.md, docs/specs/02c-platform-api-and-integrations.md
accessed: 2026-11-01
attestation: own-words
---
# Using AI features

When an administrator has set up an AI provider, Taskmoor can summarise a ticket, turn a
question into a search, draft tickets from text and break a ticket into smaller ones. Each AI
control appears only where your administrator has AI switched on for that track and that
feature; with AI off you see none of them, and everything else works the same.

AI only ever uses what you can see yourself. A comment restricted to a group you are not in is
never sent, a ticket you cannot open is never read, and fields your administrator marked as
sensitive are replaced before anything leaves the server. Nothing an AI feature writes is saved
or changes a ticket unless you confirm it.

## The first time

The first time you use an AI feature, Taskmoor shows what leaves the server and where it goes:
the provider, where it runs, and what is removed first. Press **I understand** to go on; the
feature then does what you asked. You see this once.

## Summaries

On a ticket, under its description, **AI summary** has two buttons:

- **Summarise ticket**: what the ticket is for, where it stands, who worked on it, what changed
  lately, what blocks it and what comes next.
- **Summarise comments**: what the discussion raised and agreed, and what is still open.

The summary appears as it is written. Press **Cancel** to stop it; what was written so far stays,
marked as cancelled. Numbers in brackets are the comments the summary draws on: select one to
jump to that comment. A summary that links to other sites names them, so you can check a link
before you follow it. A very long thread keeps its first comment and the latest ones, and the
summary says how many it left out.

If the AI provider declines a request, the page says "AI could not help with this request" and
shows nothing it wrote. If a limit is reached, it says until when.

## Asking in plain language

On the **Search** page, **Ask in plain language** turns a question into a query, in any language
Taskmoor supports: "my open bugs updated this week", "meine offenen Tickets",
"今週更新された自分のバグ".

1. Type the question and press **Ask**.
2. The query appears in a box you can edit, with what it means underneath.
3. Press **Run**. Nothing runs before that.

The server checks the query before showing it. If it does not work, the page says why and
**Run** waits until you have edited it; the search then checks your edit like any typed query.
The query uses only the tracks, people and fields you can see.

## Drafting a ticket from text

In the create dialog, **Draft from text** takes pasted notes, an email or a bug report:

1. Paste the text and press **Draft**.
2. Taskmoor proposes one or more tickets with a summary, a description and, where it can tell,
   the type, priority and labels.
3. Press **Use this draft** on the one you want. It fills in the form.
4. Check the form and press **Create**. Nothing is created before that.

## Breaking a ticket down

On a ticket, **Break down** proposes child tickets of the types that may sit under it (for an
outcome, standard tickets; for a standard ticket, subtickets).

1. Edit each proposal's summary, description and type, and clear the ones you do not want.
2. Press **Create N tickets**. Only the ones still ticked are created, as children of the
   ticket, by you and with your own rights.

## Likely duplicates

While you type a summary in the create dialog, **Possible duplicates** lists tickets close in
meaning to it, so you can open one instead of writing it again. These come from a model that
runs inside Taskmoor and need no AI provider: they work even with AI off. With a provider set up
and the AI notice read, AI also orders them and says why each may be the same; those reasons are
marked as written by AI. You only ever see tickets you may open.
