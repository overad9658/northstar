# Northstar MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets an agent read and
update Northstar through its HTTP API. It runs over stdio, talks only to the API (never the
database), and acts with the permissions of the API token you give it.

## Setup

```sh
cd mcp
pnpm install --frozen-lockfile
```

Create a token in Northstar under **Menu → API access**. Use a **read** token for an agent that
only reports, and a **write** token for one that updates projects and cards.

| Variable | Default | Meaning |
|---|---|---|
| `NORTHSTAR_URL` | `http://127.0.0.1:3000` | The Northstar origin. It must be http or https, with no credentials in it. |
| `NORTHSTAR_TOKEN` | (none) | The API token. It is never logged or echoed in errors. |
| `NORTHSTAR_TOKEN_SCOPE` | `auto` | Set it to `read` to offer read tools only. With `auto`, write tools are dropped after the API first refuses one as read-only. |

### `.mcp.json`

The token comes from your environment, so it is not written into the file:

```json
{
  "mcpServers": {
    "northstar": {
      "command": "node",
      "args": ["/path/to/northstar/mcp/index.mjs"],
      "env": {
        "NORTHSTAR_URL": "http://127.0.0.1:3000",
        "NORTHSTAR_TOKEN": "${NORTHSTAR_TOKEN}"
      }
    }
  }
}
```

## Tools

| Tool | Access | What it does |
|---|---|---|
| `list_projects` | read | List projects, optionally by `projectId`, `externalUrl` or `stage` (`Idea` lists the ideas) |
| `get_project` | read | One project by `id` |
| `list_cards` | read | Kanban cards across boards by `key`, `externalUrl`, `projectId`, `teamId`, `assignee`, `tag`, `source` or `decision: "open"`. Archived cards appear only with `archived: "include"` or `"only"`. `sort: "rank"` orders by rank, unranked last. |
| `get_card_by_key` | read | One card by its stable `key` |
| `get_board` | read | A team's board (`teamId`; the first team's board if omitted), or every board with `team: "all"` |
| `audit_board` | read | Problems across every board, as a list. You name the active columns (`activeColumns`) and, optionally, assignee spellings to fix (`assigneeVariants: {"from": "to"}`). See [The board audit](#the-board-audit). |
| `export_board` | read | Every team, column, project and card, archived ones included, as one JSON document in a stable order |
| `get_activity` | read | The activity feed (`since`, `limit`) |
| `list_teams` | read | Teams with capacity and assignments |
| `status_export` | read | The project status export as CSV |
| `list_views` | read | Saved views of the projects table belonging to the token's user |
| `apply_view` | read | The projects a saved view shows (by `id` or `name`), in its order |
| `upsert_project` | write | Create, or update by `key` (`projectId` or `externalUrl`) |
| `move_project` | write | Set impact and urgency (1–10), with an optional comment |
| `upsert_card` | write | Create, or update the card matched by `externalUrl` (default) or, with `key: "key"`, by its own card key. Place it with `team` (name or id) and `column` (name), or a raw `card.columnId`. `card.rank`, `card.objective` and `card.blockedBy` (card ids) are stored too. |
| `set_ranks` | write | Set many cards' `rank` in one call (`ranks: [{id, rank}]`, `rank` null clears it); all are written or none |
| `move_card` | write | Move a card (by `id`, `key` or `externalUrl`) to a column on its own board, by name, and optionally record its project's status (`projectStatus`) |
| `archive_card`, `restore_card` | write | Archive a card or bring it back |
| `add_card_note` | write | Add a note to a card |
| `decide_card` | write | Set a card decision's chosen option |
| `set_team` | write | Create a team or set its capacity |
| `get_metrics` | read | Metric definitions and readings, by `keys`, `from` and `to` |
| `get_report` | read | One day's report (`date`): Markdown and bullets |
| `list_reports` | read | Report dates, newest first, with titles and bullets (`from`, `to`) |
| `list_milestones` | read | Milestones in date order (`from`, `to`, `metricKey`) |
| `get_needs_you` | read | The count and first three cards waiting on the reader |
| `get_sequence` | read | The order of work across boards: each step's owner, reason, what it unblocks and reaches, and what the last pass moved (`mine: true` for the caller's own) |
| `record_sequence_run` | write | Record one sequencing pass: every card's rank and reasons in one transaction (`skillVersion`, `scores`, `items: [{id, rank, rankReason?, reasonFull?, waitUntil?, outcome?}]`) |
| `set_sequence_design` | write | Set or clear (`url: ""`) the Sequence page's design link (https only) |
| `export_progress` | read | Every definition, reading, milestone and report as one JSON document in a stable order |
| `record_metrics` | write | One day's readings: `date` and `metrics: [{key, value, note?, rebuilt?}]` |
| `define_metric` | write | Create or update a metric definition by `key`; `hidden: true` keeps it recording without a tile |
| `remove_metric` | write | Remove a metric definition by `key`; its readings stay. Removing one that is gone changes nothing |
| `upsert_report` | write | Create or replace a day's report: `date`, `markdown`, optional `bullets: [{text, metric_key?}]` |
| `add_milestone` | write | Add a milestone: `date`, `label`, optional `metricKey` |
| `set_needs_you` | write | Choose the board column, by `team` and `column` name, whose cards are waiting on the reader |

### Progress tools

The progress tools feed the Progress page: a few numbers each day, why they moved, and what is
waiting on the reader. Every write tool is idempotent, so an agent can repeat a day safely.

1. Define each metric once with `define_metric`: a `label`, a `question` its tile answers, a
   `direction` (`up_good`, `down_good` or `neutral`) and a `band` (`momentum`, `health` or `trust`).
   A metric that cannot be measured yet gets `startsWhen`.
2. Each day, call `record_metrics` with that day's readings. `value: null` means there was no reading.
   `rebuilt: true` marks a value estimated from history rather than read on the day.
3. Write the day's report with `upsert_report`. Give each bullet that explains a number its
   `metric_key`, so the page links the line and the tile.
4. Mark turning points with `add_milestone`.

### Placing and moving cards

A new card needs both `team` and `column`. A column the team doesn't have is an error that lists the
team's columns; the tool never falls back to another team or the first column. An existing card
always stays on its own team: `upsert_card` and `move_card` look the column up on that card's
board, and naming another team is refused. `archive_card`, `restore_card`, `add_card_note` and
`decide_card` work on a card of any team.

`move_card` with `projectStatus` writes one dated line into the linked project's description:

```text
Status 2026-10-30: Stage one is built; stage two starts Monday.
```

The line replaces any older status line. When there is none, it goes first, so the description's
1,000-character limit never cuts it off. If the column isn't a backlog column (`backlogColumns`,
default `["Backlog"]`), a Scheduled project becomes Active; an idea stays an idea. When the card
links no project, or a project on another team, name it with `project` (its projectId). Everything
is checked before anything is written.

### The board audit

`audit_board` reads every board and returns `{ problems, count }`. Each problem names its kind and
the cards and project involved:

| `problem` | Means |
|---|---|
| `scheduled_with_active_cards` | A Scheduled project (not an idea) has cards in an active column |
| `no_status_line` | A project with cards in an active column has no `Status YYYY-MM-DD:` line |
| `assignee_variant` | A card's assignee is one of the `assigneeVariants` keys |
| `duplicate_external_url` | More than one card has the same externalUrl (archived cards included) |

Nothing is hard-coded: the columns that count as active are the ones you pass in `activeColumns`.

### Exporting the board

`export_board` returns `{ teams, columns, projects, cards }`. Each list is in id order, every
object's keys are sorted, and per-request fields such as open-decision counts are left out. Two
exports of an unchanged board are identical, so a file kept in git shows only real changes.

Inputs are checked against the same limits the API enforces before anything is sent. An API error
comes back as the tool result (`Northstar returned HTTP <status>: <message>`), never as a stack trace.

## Tests

From the repository root, after installing both packages:

```sh
node --test 'mcp/tests/*.spec.mjs'
```

The tests start a real Northstar on a free port with a temporary data directory, and drive every
tool through an in-memory MCP client.
