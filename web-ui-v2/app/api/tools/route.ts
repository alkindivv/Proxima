import { createConnection } from 'net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MCP_PORT = 19224;
const MCP_HOST = '127.0.0.1';

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function listMCPTools(): Promise<MCPTool[]> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ port: MCP_PORT, host: MCP_HOST }, () => {
      let buf = '';
      let initialized = false;
      const requestId = 2;

      const sendJSON = (obj: unknown) => {
        client.write(JSON.stringify(obj) + '\n');
      };

      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error('Tools list timeout (15s)'));
      }, 15_000);

      client.on('data', (data: Buffer) => {
        buf += data.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1 && msg.result && !initialized) {
              initialized = true;
              sendJSON({
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: requestId,
              });
            }
            if (msg.id === requestId && msg.result?.tools) {
              clearTimeout(timeout);
              client.destroy();
              resolve(msg.result.tools);
              return;
            }
          } catch {}
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      sendJSON({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: 'proxima-web-ui-v2', version: '2.0.0' },
        },
        id: 1,
      });
    });
  });
}

export async function GET() {
  try {
    const tools = await listMCPTools();
    return Response.json({ tools });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: message, tools: [] }, { status: 500 });
  }
}
