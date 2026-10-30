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
| `list_projects` | read | List projects, optionally by `projectId` or `externalUrl` |
| `get_project` | read | One project by `id` |
| `list_cards` | read | Kanban cards across boards by `key`, `externalUrl`, `projectId`, `teamId`, `assignee`, `tag`, `source` or `decision: "open"`. Archived cards appear only with `archived: "include"` or `"only"`. |
| `get_card_by_key` | read | One card by its stable `key` |
| `get_board` | read | A team's board (`teamId`; the first team's board if omitted) |
| `get_activity` | read | The activity feed (`since`, `limit`) |
| `list_teams` | read | Teams with capacity and assignments |
| `status_export` | read | The project status export as CSV |
| `upsert_project` | write | Create, or update by `key` (`projectId` or `externalUrl`) |
| `move_project` | write | Set impact and urgency (1–10), with an optional comment |
| `upsert_card` | write | Create, or update the card matched by `externalUrl` (default) or, with `key: "key"`, by its own card key |
| `archive_card`, `restore_card` | write | Archive a card or bring it back |
| `add_card_note` | write | Add a note to a card |
| `decide_card` | write | Set a card decision's chosen option |
| `set_team` | write | Create a team or set its capacity |

Inputs are checked against the same limits the API enforces before anything is sent. An API error
comes back as the tool result (`Northstar returned HTTP <status>: <message>`), never as a stack trace.

## Tests

From the repository root, after installing both packages:

```sh
node --test 'mcp/tests/*.spec.mjs'
```

The tests start a real Northstar on a free port with a temporary data directory, and drive every
tool through an in-memory MCP client.
