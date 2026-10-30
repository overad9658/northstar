import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from './client.mjs';
import { tools, validate } from './tools.mjs';

const READ_ONLY_MESSAGE = 'This API token is read-only.';

// scope: 'read' hides write tools; 'auto' (default) offers them until the API refuses one as
// read-only, then hides them and tells the client the tool list changed.
export function createNorthstarServer({ baseUrl, token, scope = 'auto', fetchImpl }) {
  const api = createClient({ baseUrl, token, fetchImpl });
  let readOnly = scope === 'read';
  const server = new Server({ name: 'northstar', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  const available = () => tools.filter((tool) => !(readOnly && tool.write));
  const reply = (value, isError = false) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = available().find((item) => item.name === request.params.name);
    if (!tool) return reply(`Unknown tool: ${request.params.name}.`, true);
    const args = request.params.arguments ?? {};
    const invalid = validate(tool.inputSchema, args);
    if (invalid) return reply(`Invalid input: ${invalid}`, true);
    try {
      return reply(await tool.run(api, args));
    } catch (error) {
      const status = error?.status ?? 0;
      const message = api.redact(error instanceof Error ? error.message : 'Request failed.');
      if (tool.write && status === 403 && message === READ_ONLY_MESSAGE && !readOnly) {
        readOnly = true;
        void server.sendToolListChanged().catch(() => {});
      }
      return reply(status ? `Northstar returned HTTP ${status}: ${message}` : message, true);
    }
  });

  return server;
}
