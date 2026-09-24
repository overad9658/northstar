# Northstar

A lightweight, persistent priority matrix for engineering portfolios. Projects are plotted by impact and urgency, ranked with confidence and effort, and saved to SQLite. An optional project ID can be shown on the matrix; when omitted, Northstar falls back to the project's initials.

Projects can include an optional external source link, such as a Jira epic or GitHub project. Source links appear beside the project name and open in a new browser tab.

Planning rooms let a manager select up to 50 projects and share one participant link for collaborative scoring. Teammates move through the room’s project queue and submit impact, urgency, confidence, and effort independently. Scores stay private until the leader reveals each project’s round; the leader can then save a participant’s scores, the rounded group average, a custom placement, or cancel the update to keep the project’s current scores. Placements remain tentative until every project is placed, then the room updates the portfolio together.

Projects can be Scheduled, Active, On hold, Blocked, or Complete. Scheduled work has a To plan or Planning stage with distinct matrix colors. People can be assigned to Scheduled projects only after they reach Planning; delivery statuses retain their normal capacity behavior. Completed projects are hidden from the matrix by default, and collision-aware placement keeps projects with identical scores from covering one another. Projects can also be archived without deleting their history and restored from the archived view; both actions require a saved note explaining the change.

Moving a project into Blocked opens a note prompt. The blocker note is stored while the project remains blocked and included in the Active and Blocked status CSV export.

Focus Now allows one non-complete, non-archived project per team. Dragging, editing, or creating a second project for the same team in that quadrant is rejected until that team’s current project is moved out. Planning rooms apply the same per-team rule to tentative placements and reopen conflicting projects for adjustment. Project fill colors show status, and the Team menu filters the portfolio by one or several responsible teams.

Every impact or urgency change is saved with its date, previous position, new position, and source. Open a project and choose **View history** to review its movement timeline. Selecting the Complete filter also enables completed projects on the matrix automatically.

Moves can include an optional comment explaining why the priority changed. Comments can be added during a matrix drag, a project edit, or a planning-room placement and appear in the movement timeline.

Completed projects include a retrospective area for recording outcomes, lessons learned, and improvements for future work. Retrospectives remain attached if a project is reopened or archived.

Use the **Teams** configuration page to add teams, rename them, and set a whole-person capacity for each one. Assign people from that capacity to projects. Northstar totals available capacity across all teams by default and recalculates it for the teams selected on the portfolio page; completed and archived projects do not consume capacity. Planning rooms show the project’s current matrix position as a baseline before the team’s votes are revealed.

Northstar prevents project allocations from exceeding their responsible team’s capacity and prevents a team’s capacity from being lowered below its current assignments.

Use **Data** in the header to export a complete JSON backup or restore one later. Backups include projects, capacity, movement history, retrospectives, and planning-room data. A separate CSV status export includes only current Active and Blocked projects for concise reporting. Restoring validates the file before atomically replacing the current portfolio, so a failed restore leaves existing data unchanged.

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

Node.js 22.13 or later is sufficient; there are no packages to install.

```sh
npm start
```

Run the automated tests with `npm test`, or run syntax checks and tests together with
`npm run check`.

The SQLite file is created at `data/northstar.db`. Set `DATA_DIR` or `PORT` to override the defaults.

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

## Bulk project API

Generate a token from **Menu → API access** to enable the token-protected bulk project endpoints.
Northstar shows the token once and stores only its SHA-256 hash in SQLite. Generating a replacement
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
projects; delete returns `{ count, projectIds }`. If `API_TOKEN` is unset, these endpoints return
`503` while the existing browser-facing API remains available.

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
