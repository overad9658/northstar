# Northstar HTTP API

Every endpoint lives under `/api/` and speaks JSON unless noted. Errors are returned as
`{ "error": "message" }` with a 4xx or 5xx status.

## Authentication

| Kind | How | Who gets it |
| --- | --- | --- |
| Session | The `northstar_session` cookie set by login, setup, signup or SSO | Browser users. Role is `admin`, `team_manager` or `read_only`; team members are listed under `/api/teams/:id/members`. |
| API token, write scope | `Authorization: Bearer <token>` | A named write token, the token from **Menu → API access**, or `API_TOKEN`. Acts as an admin on token endpoints, on every team's board. Belongs to no team and cannot manage team members. |
| API token, read scope | `Authorization: Bearer <token>` | A named read token. `GET` only on token endpoints; sees what a read-only user sees. |
| Planning-room link | The room token in the URL, plus `leaderKey` for leader actions | Anyone with the link while guest access is on. |

The **Auth** column below uses these values:

- **public**: no credentials.
- **session**: any signed-in user. Read-only users do not see projects marked hidden from read-only.
- **admin session**: a signed-in admin. Tokens are not accepted.
- **token endpoint**: `GET` takes any session or any token; other methods take an admin session or a write token. A read token gets `403` on writes.
- **write token**: a write-scoped token only (no session).

**Team roles (sessions only).** A `team_manager` manages the teams they belong to: their projects,
board columns, members, and the team's name and capacity. Any member of a team, including a
read-only user, can add, edit, move and delete cards on that team's board. Admins can do all of
this on every team. Tokens are never team members or managers.

### Failed token limit

When one client address sends more than `TOKEN_AUTH_FAILURES_PER_MINUTE` (default `10`) unknown
bearer tokens within a minute, every bearer request from that address gets `429` with a
`Retry-After` header (seconds) until the minute ends. Session requests are not affected. The count
is kept in memory and resets on restart.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42

{ "error": "Too many failed API token attempts. Try again later." }
```

## Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auth/status` | public | Setup state, whether the caller is signed in, SSO providers, whether signup is open. |
| `POST` | `/api/auth/setup` | public, first run only | Create the first admin and sign in. `409` once any user exists. |
| `POST` | `/api/auth/signup` | public, when signup is allowed | Create a read-only account and sign in. |
| `POST` | `/api/auth/login` | public | Sign in with a username and password. Failed attempts are limited (see below). |
| `POST` | `/api/auth/logout` | public | Clear the session. |
| `GET` | `/api/auth/me` | session | The signed-in user. |
| `GET` | `/api/auth/sso/:provider/login` | public | Start an OIDC or SAML sign-in (redirect). |
| `GET`, `POST` | `/api/auth/sso/:provider/callback` | public | Identity-provider callback (redirect). |
| `GET` | `/api/auth/sso/:provider/metadata` | public | SAML service-provider metadata (XML). |

After `LOGIN_FAILURES_PER_MINUTE` (default `5`) failed passwords for one username from one address,
or `LOGIN_IP_FAILURES_PER_MINUTE` (default `20`) from one address across usernames, sign-in from
that address returns `429` with `Retry-After` until the minute ends. A successful sign-in clears the
username's count.

```sh
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"owner","password":"correct horse battery staple"}'
```

```json
{ "id": 1, "username": "owner", "role": "admin", "createdAt": "2026-01-05 10:00:00", "authType": "local" }
```

`GET /api/auth/status` returns:

```json
{ "setupRequired": false, "authenticated": true, "ssoProviders": [{ "id": "okta", "name": "Okta", "type": "oidc" }], "signupAllowed": false }
```

## Users and SSO settings

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/users` | admin session | List users. |
| `POST` | `/api/users` | admin session | Create a user: `{ "username", "password", "role" }`. |
| `PUT` | `/api/users/:id` | admin session | Change `username`, `role` or `password`. The last admin cannot be demoted. |
| `DELETE` | `/api/users/:id` | admin session | Delete a user (not yourself, not the last admin). `204`. |
| `GET`, `PUT` | `/api/admin/sso` | admin session | Read or save SSO settings. Secrets are never returned; each shows as `has<Field>: true`. See [sso.md](sso.md). |

```sh
curl -b cookies.txt -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"username":"viewer","password":"a long passphrase here","role":"read_only"}'
```

## API tokens

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/api-token` | admin session | Whether the single UI token or `API_TOKEN` is configured. |
| `POST` | `/api/api-token` | admin session | Generate the single UI token, revoking the previous one. Returned once. |
| `GET` | `/api/api-tokens` | admin session | List named tokens (never the token or its hash), each with `createdBy: { id, username }` or `null`. |
| `POST` | `/api/api-tokens` | admin session | Create a named token: `{ "name", "scope": "read" \| "write" }`. Returned once. |
| `DELETE` | `/api/api-tokens/:id` | admin session | Revoke a named token. `204`. |
| `GET` | `/api/token/self` | any token | The calling token's `{ name, scope, createdBy }`. `createdBy` is `null` for the **API access** / `API_TOKEN` token, or when the creating user was deleted. A session alone gets `401`. |

Admins can also create and revoke named tokens in the app under **Menu → API tokens**.

```sh
curl -b cookies.txt -X POST http://localhost:3000/api/api-tokens \
  -H "Content-Type: application/json" -d '{"name":"Reporting agent","scope":"read"}'
```

```json
{ "id": 3, "name": "Reporting agent", "scope": "read", "createdAt": "2026-01-05 10:00:00", "lastUsedAt": null, "revokedAt": null, "token": "northstar_…" }
```

## Projects

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | token endpoint | List projects. Filter with `?projectId=` or `?externalUrl=`, and sort or filter like the projects table (below). |
| `POST` | `/api/projects` | token endpoint | Create a project. `name`, `impact`, `urgency`, `confidence` and `effort` are required, except for an idea (below). |
| `PUT` | `/api/projects/:id` | token endpoint | Partially update a project. |
| `DELETE` | `/api/projects/:id` | token endpoint | Delete a project. `204`. |
| `PUT` | `/api/projects/upsert?key=projectId` | token endpoint | Create or update by `projectId` (or `key=externalUrl`). Returns `{ created, project }`, `201` when created, `200` when updated. |
| `POST` | `/api/projects/:id/promote` | token endpoint (admin or the team's manager) | Promote an idea to a plan: its `scheduleStage` goes from `Idea` to `To plan`, and it joins the matrix. `409` if the project is not an idea. |
| `GET` | `/api/projects/:id/moves` | token endpoint | Matrix movement history for one project. |
| `POST` | `/api/projects/bulk/add` | write token | Create up to 100 projects atomically: `{ "projects": [...] }`. |
| `POST` | `/api/projects/bulk/archive` | write token | Archive projects: `{ "projectIds": [...] }`. |
| `POST` | `/api/projects/bulk/delete` | write token | Delete projects: `{ "projectIds": [...] }`. |

Optional project fields: `projectId`, `externalUrl`, `description`, `retrospective`, `blockedNote`,
`archiveNote`, `restoreNote`, `team`, `status` (`Scheduled`, `Active`, `On hold`, `Blocked`,
`Complete`), `scheduleStage` (`Idea`, `To plan` or `Planning`, for a `Scheduled` project), `capacity`, `archived`,
`hiddenFromReadOnly`.

**Ideas.** A `Scheduled` project with `scheduleStage: "Idea"` is a proposal that is not a plan yet. Its
scores are optional (each one left out is `5`) and the page shows them as provisional. Ideas stay
off the priority matrix and out of Focus Now unless the viewer turns on *Show ideas*. List them with
`f.stage=Idea`; promote one with `POST /api/projects/:id/promote`.

Table parameters, the same ones the projects table puts in its URL:

| Parameter | Example | Meaning |
| --- | --- | --- |
| `sort` | `sort=score:desc,name:asc` | Sort keys in order; `asc` or `desc`. Default `score:desc,updated:desc`. |
| `q` | `q=billing` | Text in the ID, name, team, description or source link. |
| `f.<column>` (text) | `f.name=api` | Contains, any case. Text columns: `id`, `name`. |
| `f.<column>` (choice) | `f.team=Platform&f.team=Design` | Any of the repeated values. Choice columns: `team`, `status`, `stage` (a Scheduled project's stage; empty for other statuses). |
| `f.<column>` (range) | `f.impact=5..`, `f.updated=2026-01-01..2026-01-31` | Inclusive `min..max`, either end optional; a single value means exactly it. Range columns: `impact`, `urgency`, `confidence`, `effort`, `people`, `score`, `cards`, `decisions`, `updated`. |

Unknown columns are ignored. A `cols=` parameter (shown columns) is accepted and ignored by the API.

Read-only fields on every listed project: `score`, `cardCount` (linked cards), `openDecisionCount`
(linked, unarchived cards with a decision that has no decided option), `createdAt`, `updatedAt`.

```sh
curl -X POST http://localhost:3000/api/projects \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"API migration","projectId":"OPS-12","impact":9,"urgency":8,"confidence":7,"effort":6}'
```

```json
{ "id": 7, "projectId": "OPS-12", "name": "API migration", "team": "Platform", "status": "Active", "impact": 9, "urgency": 8, "confidence": 7, "effort": 6, "archived": 0, "hiddenFromReadOnly": 0 }
```

The bulk endpoints return `503` when no write token is configured. Add and archive return
`{ count, projects }`; delete returns `{ count, projectIds }`.

## Saved views

A view is a name plus the projects table's parameters (the same `q`, `sort`, `cols` and `f.<column>`
the table puts in its URL and `GET /api/projects` accepts). Views belong to one person: the signed-in
user, or the user who created the API token in use. The token generated on the admin page belongs to
the admin who generated it (regenerate one made before views existed, which has no recorded creator).
The `API_TOKEN` environment variable belongs to nobody, so it gets `400` here. Read tokens may list
and read views but not change them.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/views` | token endpoint | Your views, by name. |
| `GET` | `/api/views/:id` | token endpoint | One view. |
| `POST` | `/api/views` | token endpoint | Save a view: `{ "name", "params" }`. `201`; `409` if you already have that name (any case). |
| `PUT` | `/api/views/:id` | token endpoint | Rename it or replace its `params`. |
| `DELETE` | `/api/views/:id` | token endpoint | Delete it. `204`. |

`params` is a query string or a table state object (`{ query, sort: [{ column, direction }], columns, filters }`).
It is stored in canonical form: unknown columns and empty filters are dropped. Each view comes back
with `params` and the parsed `state`. Apply a view by appending its `params` to `/api/projects?`
or to the page URL (`/?<params>`). Up to 100 views per user.

```sh
curl -X POST http://localhost:3000/api/views \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Blocked on Platform","params":"f.status=Blocked&f.team=Platform&sort=score:desc"}'
curl "http://localhost:3000/api/projects?f.status=Blocked&f.team=Platform&sort=score:desc" -H "Authorization: Bearer $TOKEN"
```

## Teams and capacity

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/teams` | token endpoint | List teams with their capacity, card and member counts (`cardCount` includes archived cards; `boardCardCount` is the unarchived cards on the board). |
| `POST` | `/api/teams` | token endpoint (admin) | Create a team: `{ "name", "capacity" }`. |
| `PUT` | `/api/teams/:id` | token endpoint (admin or the team's manager) | Rename or resize a team. |
| `DELETE` | `/api/teams/:id` | token endpoint (admin) | Delete a team with no projects or cards. |
| `GET` | `/api/teams/:id/members` | session | List a team's members. |
| `POST`, `DELETE` | `/api/teams/:id/members[/:userId]` | admin or the team's manager (session) | Add `{ "userId" }` or remove a member. |
| `GET` | `/api/capacity` | token endpoint | `{ "total", "occupied", "available" }`. |
| `PUT` | `/api/capacity` | token endpoint | Set total capacity: `{ "total" }` (not below what is assigned). |

```sh
curl http://localhost:3000/api/capacity -H "Authorization: Bearer $TOKEN"
```

```json
{ "total": 12, "occupied": 9, "available": 3 }
```

## Kanban

Each team has its own board. Pass `?teamId=<id>` to choose it. Without it, the board, report,
project and column calls use the first team's board, and calls on one card (`/cards/:id`, its notes
and history) use that card's own team. A card can only link to a project on its team. Creating,
editing and moving cards needs team membership (or an admin session or write token); columns need
the team's manager.

`PUT /api/kanban/cards/upsert` and `POST /api/kanban/cards` take the board from the card's
`columnId`, so the column must come from the board of the team the card belongs to (read it
from `GET /api/kanban?teamId=<id>`). Creating a column without
`?teamId` puts it on the first team's board. A column from another board is refused with `404`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/kanban` | token endpoint | Columns and cards, with tags and project links. In each column, ranked cards come first by `rank`, then unranked cards by `position`. Archived cards only with `?archived=include` or `?archived=only`. |
| `GET` | `/api/kanban/projects` | token endpoint | Project ids and names for card links. |
| `GET` | `/api/kanban/report` | token endpoint | Every card's column history and durations. |
| `POST` | `/api/kanban/columns` | token endpoint | Create a column: `{ "name" }`. |
| `PUT`, `DELETE` | `/api/kanban/columns/:id` | token endpoint | Rename (`name`) or reorder (`position`, 0-based on that team's board; the others shift so positions stay 0..n-1) a column, or delete it (and its cards). |
| `GET` | `/api/kanban/cards` | token endpoint | Each card includes `columnName`. Find cards by `?key=`, `?externalUrl=`, `?projectId=`, `?decision=open`, `?tag=` or `?source=`; add `?archived=include` or `?archived=only` for archived cards. `?sort=rank` lists ranked cards by rank (ties by id), then unranked ones by id. |
| `POST` | `/api/kanban/cards` | token endpoint | Create a card: `columnId` and `title` required. |
| `GET`, `PUT`, `DELETE` | `/api/kanban/cards/:id` | token endpoint | Read, partially update (including `columnId` to move and `archived: true/false` to archive or restore) or delete a card. |
| `PUT` | `/api/kanban/cards/upsert` | token endpoint | Create or update a card by `externalUrl` (default) or by its own `key` with `?key=key`. Returns `{ created, card }`. |
| `PUT` | `/api/kanban/cards/ranks` | token endpoint | Set many ranks at once: `{ "ranks": [{ "id", "rank" }] }` (1–1000 entries; `rank` null clears it). All are written or none. Returns `{ ranks: [{ id, rank, changed }] }`. |
| `GET` | `/api/kanban/cards/:id/history` | token endpoint | Time spent in each column. |
| `GET`, `POST` | `/api/kanban/cards/:id/notes` | token endpoint | List notes or add one: `{ "body" }`. |
| `DELETE` | `/api/kanban/cards/:id/notes/:noteId` | token endpoint | Delete a note. |

Optional card fields: `description`, `assignee`, `externalUrl`, `nextStep`, `decision`,
`projectId`, `tags`, `rank`, `objective`, `blockedBy`.

- `rank` is a whole number from 0 to 1000000, or null for none. It is a card's place in a
  sequence across boards and survives moves between columns. The board orders each column by it, and
  dragging a card within its column on the board sets it between its new neighbours. `position`, a card's order inside
  its column, is set by the board and cannot be sent.
- `objective` is short text (at most 300 characters).
- `blockedBy` is a list of other card ids (at most 50). Sending it replaces the stored list; a
  card cannot block itself, and deleting a card removes it from every list it was on.

```sh
curl -X PUT http://localhost:3000/api/kanban/cards/7 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"columnId":2}'
```

## Activity

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/activity` | token endpoint | Recent project, planning and card events, newest first. `?since=<ISO time>`, `?limit=` (1–500). |
| `GET` | `/api/events` | token endpoint | Server-sent event stream. Each committed write sends `{ "version", "kinds" }` (`projects`, `kanban`, `teams`) with an `id` for `Last-Event-ID`; a heartbeat every 25 seconds. |
| `GET` | `/api/version` | token endpoint | `{ "version" }`, the polling fallback when the stream is unavailable. |

Event types: `project.created`, `project.moved`, `project.status`, `project.archived`,
`project.restored`, `project.team`, `project.capacity`, `planning.decided`, `card.created`,
`card.moved`, `card.note`, `metrics.recorded`, `metric.defined`, `metric.removed`, `report.created`, `report.updated`,
`milestone.added`, `milestone.updated`, `milestone.deleted`. Field lists are in the README.

```text
id: 42
data: {"version":42,"kinds":["projects"]}
```

```json
{ "items": [{ "id": "project.created:7", "type": "project.created", "at": "2026-01-05T10:00:00.000Z", "projectId": 7, "projectCode": "OPS-12", "projectName": "API migration" }] }
```

## Progress

Daily numbers, one Markdown report per day, and milestones. The Progress page
shows them; [docs/progress-page.md](https://github.com/tsanford01/northstar/blob/main/docs/progress-page.md)
explains its design. Dates are `YYYY-MM-DD`; metric keys are slugs such as `prs_merged`. Anyone
signed in, and any token, can read. Writes take an admin session or a write token. Every write is
idempotent: repeating it changes nothing and adds nothing to the activity feed.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/progress/metrics` | token endpoint | Readings, sorted by key then date. `?keys=a,b`, `?from=`, `?to=` (inclusive). At most 10,000 rows, the newest. |
| `PUT` | `/api/progress/metrics` | admin or write token | Record readings: `{ "date", "metrics": [{ "key", "value", "note"?, "rebuilt"? }] }` (1–1000). An entry may carry its own `date`. `value` is a number or `null` (no reading); `rebuilt: true` marks a value estimated from history. Each entry replaces the stored row for its date and key. Returns `{ created, updated, unchanged, metrics }`. |
| `GET` | `/api/progress/metric-defs` | token endpoint | Metric definitions in `position` order. |
| `PUT` | `/api/progress/metric-defs/:key` | admin or write token | Create (`201`) or update (`200`) a definition: `label`, `unit`, `direction` (`up_good`, `down_good`, `neutral`), `band` (`momentum`, `health`, `trust`), `question` (the line its tile answers), `startsWhen`, `hidden` (keeps recording, shows no tile), `position`, `description`. Fields left out keep their values. |
| `DELETE` | `/api/progress/metric-defs/:key` | admin or write token | Remove a definition: `{ removed, key, readingsKept }`. Its readings stay, so defining the key again brings its history back. `404` when there is no definition. |
| `GET` | `/api/progress/reports` | token endpoint | Report dates, newest first, with `title` (the first line) and `bullets`. `?from=`, `?to=`. |
| `GET` | `/api/progress/reports/:date` | token endpoint | One report: `{ date, markdown, bullets }`. |
| `PUT` | `/api/progress/reports/:date` | admin or write token | Create (`201`) or replace (`200`) a report: `{ "markdown", "bullets"?: [{ "text", "metric_key"? }] }`. Bullets left out keep the stored ones. |
| `GET` | `/api/progress/milestones` | token endpoint | Milestones in date order. `?from=`, `?to=`, `?metricKey=`. |
| `PUT` | `/api/progress/milestones` | admin or write token | Add a milestone: `{ "date", "label", "metricKey"? }`. A milestone is named by its date and label. |
| `DELETE` | `/api/progress/milestones/:id` | admin or write token | Remove a milestone. |
| `GET`, `PUT` | `/api/progress/settings` | read: token endpoint; write: admin or write token | `{ "needsYou": { "teamId", "columnId" } }`: the board column whose cards are waiting on the reader. Both `null` clears it. |
| `GET` | `/api/progress/needs-you` | token endpoint | `{ configured, count, items }`: the count and first three cards of that column. |
| `GET` | `/api/progress/export` | token endpoint | Every definition, reading, milestone and report in a stable order with sorted keys. |

```json
{ "date": "2026-11-03", "metrics": [{ "key": "prs_merged", "value": 9 }, { "key": "queue_open", "value": 37, "note": "Six items closed after planning" }] }
```

The full backup (`GET /api/backup`) includes the progress tables. Restoring a backup made before
they existed leaves the current progress data in place.

## Planning rooms

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/planning-sessions` | admin session | Open a room: `{ "projectIds": [...], "guestAccess": true }`. |
| `POST` | `/api/projects/:id/sessions` | admin session | Open a room starting with one project. |
| `GET` | `/api/sessions/:token` | room link; session when guest access is off | Room state. `?voterToken=` includes your own votes. |
| `POST` | `/api/sessions/:token/votes` | room link | Vote: `projectId` and the four scores, optional `voterToken` and `voterName`. |
| `POST` | `/api/sessions/:token/reveal` | room link + `leaderKey` | Reveal votes for a project. |
| `POST` | `/api/sessions/:token/decide` | room link + `leaderKey` | Record final scores (or `keepCurrent: true`) and an optional `moveComment`. |

```json
{ "token": "x8Yq…", "leaderKey": "k3Pz…", "guestAccess": true }
```

## Backup and export

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/backup` | admin session or write token | Download the full JSON backup. A read token gets `403`: backups hold hidden projects and planning-room links. |
| `POST` | `/api/backup` | admin session | Restore a backup, replacing all portfolio data atomically. Tokens are not accepted. |
| `GET` | `/api/status-export` | admin session or any token | CSV of current Active and Blocked projects. A read token gets the read-only view, without hidden projects. |

```sh
curl -b cookies.txt -o northstar-backup.json http://localhost:3000/api/backup
```
