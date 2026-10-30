#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseBaseUrl } from './client.mjs';
import { createNorthstarServer } from './server.mjs';

try {
  const baseUrl = parseBaseUrl(process.env.NORTHSTAR_URL || undefined);
  const scope = process.env.NORTHSTAR_TOKEN_SCOPE === 'read' ? 'read' : 'auto';
  if (!process.env.NORTHSTAR_TOKEN) console.error('northstar-mcp: NORTHSTAR_TOKEN is not set; every call will be refused.');
  const server = createNorthstarServer({ baseUrl, token: process.env.NORTHSTAR_TOKEN || '', scope });
  await server.connect(new StdioServerTransport());
} catch (error) {
  // stdout carries the protocol; diagnostics go to stderr and never include the token.
  console.error(`northstar-mcp: ${error instanceof Error ? error.message : 'failed to start'}`);
  process.exit(1);
}
