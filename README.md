# Northstar

A lightweight, persistent priority matrix for engineering portfolios. Projects are plotted by impact and urgency, ranked with confidence and effort, and saved to SQLite by default, with optional PostgreSQL support. An optional project ID can be shown on the matrix; when omitted, Northstar falls back to the project's initials.

## Screenshots

<p align="center">
  <img src="docs/screenshots/priority-matrix.jpg" alt="Northstar priority matrix with projects plotted by impact and urgency" width="31%">
  <img src="docs/screenshots/project-editor.jpg" alt="Northstar project editor" width="31%">
  <img src="docs/screenshots/team-capacity.jpg" alt="Northstar team capacity configuration" width="31%">
</p>

Projects can include an optional external source link, such as a Jira epic or GitHub project. Source links appear beside the project name and open in a new browser tab.

Planning rooms let a manager select up to 50 projects and share one participant link for collaborative scoring. Teammates move through the room’s project queue and submit impact, urgency, confidence, and effort independently. Scores stay private until the leader reveals each project’s round; the leader can then save a participant’s scores, the rounded group average, a custom placement, or cancel the update to keep the project’s current scores. Placements remain tentative until every project is placed, then the room updates the portfolio together.

Projects can be Scheduled, Active, On hold, Blocked, or Complete. Scheduled work has a To plan or Planning stage with distinct matrix colors. People can be assigned to Scheduled projects only after they reach Planning; delivery statuses retain their normal capacity behavior. Completed projects are hidden from the matrix by default, and collision-aware placement keeps projects with identical scores from covering one another. Projects can also be archived without deleting their history and restored from the archived view; both actions require a saved note explaining the change.

Moving a project into Blocked opens a note prompt. The blocker note is stored while the project remains blocked and included in the Active and Blocked status CSV export.

Focus Now allows one non-complete, non-archived project per team. Dragging, editing, or creating a second project for the same team in that quadrant is rejected until that team’s current project is moved out. Planning rooms apply the same per-team rule to tentative placements and reopen conflicting projects for adjustment. Project fill colors show status, and the Team menu filters the portfolio by one or several responsible teams.

The **Kanban board** in the main menu holds general to dos and project work. Admins can add and rename columns, create cards, optionally link cards to projects, add tags, and move cards between columns by dragging or editing. Use **Filter by project** and **Filter by tag** together to narrow the board; the project filter also offers **General to dos** for cards without a project. Each card can hold multiple notes that admins can add or delete. Opening a card shows its column history and time spent in each column; **Download time in column** exports the same history as CSV, including time in the current column as of export. The matrix hover preview and project editor show how many cards link to each project. Cards remain when a linked project is deleted; the project link is cleared. Read-only users can view the board, notes, and history but cannot change them.

Every impact or urgency change is saved with its date, previous position, new position, and source. Open a project and choose **View history** to review its movement timeline. Selecting the Complete filter also enables completed projects on the matrix automatically.

Moves can include an optional comment explaining why the priority changed. Comments can be added during a matrix drag, a project edit, or a planning-room placement and appear in the movement timeline.

Completed projects include a retrospective area for recording outcomes, lessons learned, and improvements for future work. Retrospectives remain attached if a project is reopened or archived.

Use the **Teams** configuration page to add teams, rename them, and set a whole-person capacity for each one. Assign people from that capacity to projects. Northstar totals available capacity across all teams by default and recalculates it for the teams selected on the portfolio page; completed and archived projects do not consume capacity. Planning rooms show the project’s current matrix position as a baseline before the team’s votes are revealed.

Northstar prevents project allocations from exceeding their responsible team’s capacity and prevents a team’s capacity from being lowered below its current assignments.

Use **Data** in the header to export a complete JSON backup or restore one later. Backups include projects, capacity, movement history, retrospectives, planning-room data, and kanban columns, cards, tags, notes, and column history. A separate CSV status export includes only current Active and Blocked projects for concise reporting. Restoring validates the file before atomically replacing the current portfolio, so a failed restore leaves existing data unchanged.

## Run with Docker

Docker is the only prerequisite.

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Project data lives in the `northstar-data` Docker volume and remains available when the container restarts.

To stop the app:

```sh
docker compose down
```

`docker compose down -v` also removes the saved database.

## Run without Docker

Use Node.js 22.13 or later and pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Run the automated tests with `npm test`, or run syntax checks and tests together with
`npm run check`.

The SQLite file is created at `data/northstar.db`. Set `DATA_DIR` or `PORT` to override the defaults.

### Optional PostgreSQL

SQLite remains the default, even when `DATABASE_URL` is present. To use an existing PostgreSQL
database, explicitly select the backend and supply its connection URL:

```sh
DATABASE_CLIENT=postgres DATABASE_URL='postgresql://northstar:password@localhost:5432/northstar' pnpm start
```

Northstar creates its tables on startup. Use a dedicated database; the database user must have
permission to create tables and install the trusted `citext` extension, which preserves
case-insensitive usernames and team names. If your provider restricts extension installation,
have an administrator install `citext` first. TLS options can be supplied in the connection URL,
for example `?sslmode=verify-full` with a trusted server certificate. `DATA_DIR` applies only to SQLite.

For Docker Compose with a bundled PostgreSQL service:

```sh
POSTGRES_PASSWORD=change-me docker compose -f compose.yaml -f compose.postgres.yaml up --build
```

Use a strong password containing URL-safe characters (or percent-encode it in `DATABASE_URL`
when connecting to an external database). PostgreSQL data persists in the `northstar-postgres`
volume. Use the same Compose files when stopping this deployment. The plain `docker compose up`
command continues to use SQLite unless `DATABASE_CLIENT` is explicitly set in the environment.

Changing backends does not move existing records. Export a JSON backup from **Data** and restore
it after switching to transfer portfolio data; accounts, sign-in sessions, API tokens, and SSO
settings are not part of that backup and must be configured separately.

PostgreSQL integration tests run when `TEST_DATABASE_URL` points to a dedicated empty test
database. They replace portfolio data, so never use a production database:

```sh
TEST_DATABASE_URL='postgresql://northstar:password@localhost:5432/northstar_test' pnpm test
```

## Releases and semantic versioning

Releases use [Release Please](https://github.com/googleapis/release-please-action) and
Conventional Commits on `main`. Use these commit messages (or squash-merge PR titles):

| Commit example | Version change from 1.2.3 |
| --- | --- |
| `fix: correct project sorting` | Patch: 1.2.4 |
| `feat: add a portfolio export` | Minor: 1.3.0 |
| `feat!: change the backup format` | Major: 2.0.0 |
| `docs: update setup instructions` or `chore: update tooling` | No release on its own |

A `BREAKING CHANGE:` footer also requests a major version bump. The largest change since the
previous release determines the next version. Treat incompatible API, configuration, or backup
format changes as breaking changes.

After checks pass on `main`, the **Release** workflow opens or updates a release PR containing
the next `package.json` version, `CHANGELOG.md`, and release manifest. Review and merge that PR
to publish the `vX.Y.Z` tag and GitHub release. Checks run again on the merged commit before
publication. This private application is distributed as a container; it is not published to npm.

The initial baseline is the existing `1.0.0` package version at commit `72a146e`. Earlier history
is excluded from the first changelog; the next `fix:` or `feat:` commit starts the first release
PR. Version updates do not change dependencies, so the pnpm lockfile stays unchanged.

Release containers are published to `ghcr.io/overad9658/northstar` for both amd64 and arm64,
with tags such as `v1.2.3`, `1.2.3`, `1.2`, `1`, and `latest`. `latest` follows stable releases;
the `main` and `sha-...` tags are available for development builds. Pin a full version in
deployments when you want controlled upgrades.

### One-time GitHub setup

Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create
and approve pull requests**. The workflows use the built-in `GITHUB_TOKEN`; no release secret
is needed. Repository or organization policies must allow the permissions declared in the
workflows and writes to the GHCR package.

PRs created by `GITHUB_TOKEN` do not automatically start PR workflows. If branch protection
requires checks on the release PR, run the **Test** workflow manually on its
`release-please--branches--main` branch before merging. Tests also gate release creation on
`main`. See [Release Please token behavior](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).

Container publishing is called directly from the release workflow because tags created with
`GITHUB_TOKEN` do not trigger another workflow. If image publishing fails after the GitHub
release succeeds, run **Build and publish container** manually and enter the existing tag in
**release-tag**. This rebuilds that tag's source without creating another release.

## Authentication and roles

On the first visit, Northstar asks you to create the first admin account. Passwords are stored as
scrypt hashes, and browser sessions use HTTP-only, same-site cookies that expire after seven days.
Admins can add and manage accounts from **Menu → Users**.

- **Admin** accounts can edit the portfolio, manage teams and users, create planning rooms, restore
  backups, and generate API tokens.
- **Read only** accounts can view the portfolio and team capacity but cannot make changes.
- An admin can select **Hide from read-only users** while creating or editing a project. Hidden
  projects and their history or capacity usage are omitted from read-only responses.

When creating a planning room, admins can allow guests to join from the participant link without a
Northstar account or require participants to sign in. Treat a guest participant URL as an invitation
and a leader URL as sensitive because the latter can finalize the room's placements.

For isolated automated tests only, authentication can be bypassed with `AUTH_DISABLED=true`. Do not
use that setting in a deployed environment.

### Single sign-on

Northstar supports Google, GitHub, and multiple OpenID Connect (OIDC) and SAML 2.0 providers alongside local accounts.
Configure AWS Cognito through OIDC, or connect directly to Okta, PingOne, and other compatible
identity providers through OIDC or SAML. Admins can configure providers in **Menu → Single sign-on**;
changes take effect immediately and persist across restarts. Provider buttons appear on the sign-in
page after initial admin setup. Set `SIGNUP_ALLOWED=true` or enable **Allow signup** in these settings
to allow new local and provider accounts with read-only access. Signup defaults to disabled; existing
users can still sign in. Saved settings override the environment variable. See [SSO setup](docs/sso.md) for callback URLs and provider examples.

## Software bill of materials

Generate a CycloneDX software bill of materials and scan the deployable container packages for
known vulnerabilities:

```sh
npm run sbom
```

The command builds the application image and writes these generated reports to `.sbom/`:

- `northstar.cdx.json` — the CycloneDX SBOM.
- `vulnerabilities.txt` — a human-readable package vulnerability list.
- `vulnerabilities.json` — the same findings in machine-readable form.

Docker is the only prerequisite. The first run downloads Trivy and its vulnerability database.
Set `IMAGE_REF` to override the tag assigned to the application image, or set `TRIVY_IMAGE` to use
a different pinned Trivy container version.

Northstar's pages send a `Content-Security-Policy` that allows only its own scripts, styles and
images, with no inline scripts or style attributes. Failed sign-ins are limited per address and
username (`LOGIN_FAILURES_PER_MINUTE`, default `5`) and per address (`LOGIN_IP_FAILURES_PER_MINUTE`,
default `20`); limited requests get `429` with `Retry-After`.

## HTTP API

Every endpoint, its authentication and examples are in [docs/api.md](docs/api.md). Signed-in users can also
read it, and the [MCP server guide](mcp/README.md), under **Menu → Docs**; the page renders these
same files.
Repeated unknown API tokens from one address get `429` with `Retry-After`; set the limit with
`TOKEN_AUTH_FAILURES_PER_MINUTE` (default `10`).

## Bulk project API

Generate a token from **Menu → API access** to enable the token-protected bulk project endpoints.
Northstar shows the token once and stores only its SHA-256 hash in the configured database. Generating a replacement
immediately revokes the previous UI-generated token. You can alternatively set `API_TOKEN`; for
Docker Compose, either export it in your shell or add it to a local `.env` file before starting the
service. A UI-generated token takes precedence over `API_TOKEN`.

All bulk requests use `POST`, require `Authorization: Bearer <API_TOKEN>`, accept at most 100
projects, and are atomic: if any project is invalid or missing, none of the changes are committed.

```sh
curl -X POST http://localhost:3000/api/projects/bulk/add \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projects":[{"name":"API migration","impact":9,"urgency":8,"confidence":7,"effort":6}]}'

curl -X POST http://localhost:3000/api/projects/bulk/archive \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectIds":[1,2]}'

curl -X POST http://localhost:3000/api/projects/bulk/delete \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectIds":[1,2]}'
```

The add response returns `{ count, projects }`; archive returns the same shape with the updated
projects; delete returns `{ count, projectIds }`. If no write token exists (no `API_TOKEN`, UI-generated
token or named write token), these endpoints return `503` while the existing browser-facing API remains available.

## Kanban API for agents and remote clients

The Kanban API accepts the same bearer token from **Menu → API access** or `API_TOKEN`. Use it in
`Authorization: Bearer <token>` on each request. A valid token grants Kanban read and write access
without a browser session; browser sessions retain their normal admin and read-only roles. Token
rotation revokes access immediately. The same token also grants project read and write access
(`GET`/`POST /api/projects`, `PUT`/`DELETE /api/projects/:id`, `GET /api/projects/:id/moves`) and
manages teams and capacity (`GET`/`POST /api/teams`, `PUT`/`DELETE /api/teams/:id`,
`GET`/`PUT /api/capacity`), and can download a backup (`GET /api/backup`) or the status CSV
(`GET /api/status-export`). It does not grant access to other admin endpoints such as users,
planning rooms, backup restore, or SSO.
Use HTTPS when calling a remote Northstar host.

### Named API tokens

Admins can also issue several named tokens, each with a `read` or `write` scope. A read token can
call only `GET` on the Kanban and project endpoints and the status CSV, and sees projects the way a
read-only user does. It cannot download backups, which include hidden projects and planning-room links.
A write token behaves like the token above. Northstar stores only each token's SHA-256 hash and
records when it was last used. Tokens are managed with an admin browser session, never with a token:

```sh
curl -X POST http://localhost:3000/api/api-tokens -b "$SESSION_COOKIE" \
  -H "Content-Type: application/json" -d '{"name":"Reporting agent","scope":"read"}'
curl http://localhost:3000/api/api-tokens -b "$SESSION_COOKIE"
curl -X DELETE http://localhost:3000/api/api-tokens/1 -b "$SESSION_COOKIE"
```

The create response includes the token once. The list returns each token's `id`, `name`, `scope`,
`createdAt`, `lastUsedAt` and `revokedAt`, never the token itself. Revoking a token takes effect
immediately. The token from **Menu → API access** and `API_TOKEN` keep working as write tokens.


### Lookup and upsert by external key

Clients that sync from another tracker can find and update records by their own key instead of
Northstar's numeric id. `GET /api/projects?projectId=OPS-12` and `GET /api/projects?externalUrl=<url>`
return the matching projects. `GET /api/kanban/cards?externalUrl=<url>` and
`GET /api/kanban/cards?projectId=<id>` return the matching cards. Cards also take an optional `key` (up to 120
characters, unique when set) chosen by the client, so a card can be found with `GET /api/kanban/cards?key=<key>`
even when it has no link. Sending an empty `key` clears it.

Cards can be archived with `PUT /api/kanban/cards/:id` and `{"archived": true}`, and restored with
`false`. Each card has `archived` and `archivedAt`. Archived cards are left off `GET /api/kanban` and
`GET /api/kanban/cards` unless you add `?archived=include` (all cards) or `?archived=only`; on the board,
**Show archived** brings them back. Cards also take an optional `source` (up to 80 characters, for
example `ipm-sync`), and `GET /api/kanban/cards` filters by `?tag=` and `?source=`.
`GET /api/kanban/cards?decision=open` returns cards with a decision that has no `decidedOption` yet.

A card's `nextStep` is free text (up to 1000 characters): the exact next action or command.
Its `decision` is `null` or `{ "options": [...], "recommendation": "...", "confidence": 0-100,
"decidedOption": "...", "decidedAt": "ISO time" }`. There are 1–10 distinct options, and
`recommendation` and `decidedOption` must each be one of them. `decidedAt` is set when
`decidedOption` is first set (or taken from the request). Writing `decision` replaces the whole
object, and `null` clears it. Both fields work through create, update and
`PUT /api/kanban/cards/upsert`.

`PUT /api/projects/upsert?key=projectId` (or `key=externalUrl`) and `PUT /api/kanban/cards/upsert`
(keyed by `externalUrl` by default, or `?key=key` for the card's own key) update the one record with that
key, or create it if none exists. The
response is `{ created, project }` or `{ created, card }`, with `201` when created and `200` when
updated, so repeating a request is safe. An update changes only the fields sent; a create needs the
same fields as `POST`. If more than one record already has the key, the request returns `409`.

```sh
curl -X PUT "http://localhost:3000/api/projects/upsert?key=projectId" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"projectId":"OPS-12","name":"API migration","impact":9,"urgency":8,"confidence":7,"effort":6}'
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/kanban` | List columns and cards, including tags and project links. |
| `GET` | `/api/kanban/projects` | List available project IDs and names for card links. |
| `POST` | `/api/kanban/columns` | Create a column with `{ "name": "To do" }`. |
| `PUT`, `DELETE` | `/api/kanban/columns/:id` | Rename or delete a column. Deleting also deletes its cards. |
| `POST` | `/api/kanban/cards` | Create a card with `columnId` and `title`; `description`, `assignee`, `externalUrl` (HTTP or HTTPS), `nextStep`, `decision`, `projectId`, and `tags` are optional. |
| `GET`, `PUT`, `DELETE` | `/api/kanban/cards/:id` | Read, partially update, or delete a card. `PUT` can move a card with `{ "columnId": 2 }`. |
| `GET`, `POST` | `/api/kanban/cards/:id/notes` | List notes or add one with `{ "body": "..." }`. |
| `DELETE` | `/api/kanban/cards/:id/notes/:noteId` | Delete one note. |
| `GET` | `/api/kanban/cards/:id/history` | Read time spent in each column. |
| `GET` | `/api/kanban/report` | Read all cards' column history and durations. |

Tags are an array of up to 20 names, each 1–40 characters. Use `projectId: null` to unlink a
card. `PUT` accepts only the fields you want to change, and returns the updated card. Successful
creates return `201`, reads and updates return `200`, and deletes return `204`.

```sh
curl https://northstar.example.com/api/kanban/projects \
  -H "Authorization: Bearer $API_TOKEN"

curl -X POST https://northstar.example.com/api/kanban/cards \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"columnId":1,"title":"Prepare release","projectId":3,"tags":["release"]}'

curl -X PUT https://northstar.example.com/api/kanban/cards/7 \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"columnId":2}'
```

### Activity feed

`GET /api/activity` returns recent events, newest first, as `{ items }`. It accepts a session or any
API token, read or write. Each item has a stable `id`, a `type` and an ISO 8601 `at`, plus the
fields for its type:

| `type` | Fields |
| --- | --- |
| `project.created` | `projectId`, `projectCode`, `projectName` |
| `project.moved` | project fields, `from` and `to` (`impact`, `urgency`), `source`, `comment` |
| `planning.decided` | project fields, final `scores`, `comment` |
| `card.created`, `card.moved` | `cardId`, `title`, `projectId`, `columnId`, `columnName` |
| `card.note` | `cardId`, `title`, `projectId`, `body` |
| `project.status` | project fields, `from`, `to`, `note` (the blocked note when `to` is `Blocked`), `actor` |
| `project.archived`, `project.restored` | project fields, `note` (the archive or restore note), `actor` |
| `project.team`, `project.capacity` | project fields, `from`, `to`, `actor` |
| `card.updated` | card fields, `fields` (which of `title`, `description`, `nextStep`, `externalUrl` changed), `actor` |
| `card.decided` | card fields, `option` (the decided option), `by` and `actor` (who decided) |
| `card.assigned` | card fields, `from`, `to` (assignee before and after; `''` is unassigned), `actor` |
| `card.archived`, `card.restored` | card fields, `actor` |

Status, archive, team and capacity events for projects, and update, decision, assignee and archive
events for cards, are recorded from the time this history was added; earlier changes are not
backfilled. `actor` is the username, or the API token's name.

`limit` (1–500, default 100) caps the number of items. `since` (an ISO 8601 timestamp) returns only
events at or after that time, compared to the whole second; to poll, pass the newest `at` you have seen and skip items whose `id`
you already hold. Read-only callers do not see events for projects hidden from read-only users.

### Live updates

The matrix, kanban and teams pages update by themselves when data changes in another tab, from a
teammate, or through the API. `GET /api/events` is a server-sent event stream (browser session
or any API token). After each committed write it sends `{ "version": N, "kinds": [...] }`, where
the kinds are those whose content changed (`projects`, `kanban`, `teams`). Every event has an `id`
for `Last-Event-ID`, and the stream sends a heartbeat every 25 seconds. Read-only viewers are
compared against what they can see, so a change to a hidden project sends them nothing. A page
waits to refresh while a dialog is open, a form field has focus or a drag is in progress. If the
stream is unavailable, pages poll `GET /api/version` every 10 seconds while the tab is visible.

The event emitter is in-process. Several Northstar servers sharing one PostgreSQL database would
need PostgreSQL `LISTEN`/`NOTIFY` to share events.

## MCP server for agents

`mcp/` holds a stdio [MCP](https://modelcontextprotocol.io) server, packaged separately, that wraps
this API for agents: reading projects, cards, teams and activity, and (with a write token) upserting
projects and cards, moving projects, adding notes, deciding cards and setting team capacity. See
[`mcp/README.md`](mcp/README.md).

## Code structure

- `server.mjs` owns process startup, shutdown, and static files.
- `api.mjs` maps HTTP requests to focused project, planning-room, and backup services.
- `data-api.mjs` owns API-token, bulk-operation, export, and backup HTTP endpoints.
- `database.mjs` owns schema initialization, legacy migrations, and transactions.
- `project-domain.mjs` contains persistence-independent validation and portfolio rules.
- `public/shared/project-rules.js` is the browser/server source of truth for shared portfolio constants and Focus Now eligibility.
- `public/portfolio-model.js` contains the portfolio page's pure filtering, selection, and presentation logic.
- `public/matrix-geometry.js` contains testable matrix coordinate and collision-placement calculations.
- `public/browser-utils.js` contains browser-safe API and formatting helpers shared by the pages.

The broad integration workflow is divided into named subtests, while domain, database, and browser
helpers have focused unit tests. When adding a rule, prefer placing it in a pure domain/helper module
and testing it there before wiring it into a route or renderer. `npm run check` syntax-checks every
JavaScript module outside generated and persisted-data directories before running the test suite.

## How ranking works

Northstar weights impact and urgency at 40% each and confidence at 20%, then applies a modest effort adjustment. The matrix itself always uses the unmodified impact and urgency scores so movement remains easy to interpret.

## License

Northstar is licensed under the [MIT License](LICENSE).
