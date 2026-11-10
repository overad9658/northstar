// "All boards": several team boards shown as one. Shared by the API, which merges the boards,
// and the page, which maps a merged column back to one team's column when a card moves.

export const ALL_BOARDS = 'all';

// Columns with the same name (ignoring case and surrounding spaces) are one merged column.
export function columnKey(name) {
  return String(name ?? '').trim().toLocaleLowerCase();
}

// boards: [{ team: { id, name }, columns: [{ id, name }], cards: [{ id, columnId, ... }] }] in team
// order. Merged columns keep the order of the first team that has them; each later team's extra
// columns are appended in its own order. Every card keeps its own column and team, and gains
// teamName and the key of the merged column it shows in.
export function mergeBoards(boards) {
  const columns = [];
  const byKey = new Map();
  const keyOfColumn = new Map();
  for (const { team, columns: teamColumns } of boards) {
    for (const column of teamColumns) {
      const key = columnKey(column.name);
      let merged = byKey.get(key);
      if (!merged) {
        merged = { key, name: column.name, columns: [] };
        byKey.set(key, merged);
        columns.push(merged);
      }
      if (!merged.columns.some((item) => item.teamId === team.id)) merged.columns.push({ teamId: team.id, id: column.id });
      keyOfColumn.set(column.id, key);
    }
  }
  const cards = boards.flatMap(({ team, cards: teamCards }) => teamCards.map((card) => ({
    ...card, teamId: team.id, teamName: team.name, columnKey: keyOfColumn.get(card.columnId),
  })));
  return { teams: boards.map(({ team }) => ({ id: team.id, name: team.name })), columns, cards };
}

// The column a card lands in when dropped on a merged column: the same-named column on the
// card's own team, or null when that team has no such column (cards never change team).
export function targetColumn(mergedColumn, teamId) {
  return mergedColumn?.columns.find((item) => item.teamId === teamId)?.id ?? null;
}
