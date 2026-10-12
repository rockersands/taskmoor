# Installing Tracksmith

One image runs every role (ADR-021). Pick a kit:

| Kit | For | Where |
|---|---|---|
| Compose with bundled PostgreSQL | A server of your own, up to a few hundred users | [`compose/`](compose/README.md) |
| Compose with an external PostgreSQL | A managed or shared database | [`compose/`](compose/README.md) |
| All-in-one container | Trials and single-box installs: PostgreSQL inside, one `/data` volume | [`allinone/`](allinone/Dockerfile) |

Every kit ends the same way: the backend logs a line like

```
{"msg":"first-run setup","link":"http://localhost:8080/#/setup?token=..."}
```

Open that link (`docker compose logs tracksmith` shows it) to create the first administrator.
The token works once and expires after 24 hours; restarting the backend prints a new one. Set
`PUBLIC_URL` (for example `https://tracker.example.com`) so the link and the session cookies
match the address people use, and `TRACKSMITH_SETUP_TOKEN` to choose the token yourself, as an
installer or a test does.

The Builder (M1) generates these files with fresh secrets and a reverse proxy with HTTPS; until
then, copy the examples and fill them by hand.
