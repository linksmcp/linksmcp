import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildTools, SERVER_INSTRUCTIONS, type ToolContext } from './tools/index.js';
import { VERSION } from './version.js';

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'linksmcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const t of buildTools(ctx)) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }, t.handler as any);
  }
  return server;
}

export async function serveStdio(ctx: ToolContext): Promise<McpServer> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  return server;
}
