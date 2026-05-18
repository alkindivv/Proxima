import { NextRequest } from 'next/server';
import { createConnection } from 'net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MCP_PORT = 19224;
const MCP_HOST = '127.0.0.1';

// Map web-ui "message" to the correct tool parameter name.
const PARAM_MAP: Record<string, string> = {
  brainstorm: 'topic',
  generate_article: 'topic',
  fact_check: 'topic',
  find_stats: 'topic',
  debate: 'topic',
  generate_code: 'description',
  optimize_code: 'code',
  review_code: 'code',
  explain_code: 'code',
  writing_help: 'text',
  verify: 'question',
  verify_code: 'code',
  compare_ais: 'question',
  solve: 'task',
  how_to: 'question',
  analyze_document: 'question',
  analyze_file: 'question',
  explain_error: 'error_message',
  fix_error: 'code',
  convert_code: 'code',
  ask_selected: 'question',
  get_ui_reference: 'description',
  analyze_code_file: 'question',
  review_code_file: 'question',
  build_architecture: 'description',
  write_tests: 'code',
  security_audit: 'code',
  summarize_url: 'url',
  extract_data: 'text',
  deep_search: 'query',
  internet_search: 'query',
  reddit_search: 'query',
  github_search: 'query',
  news_search: 'query',
  math_search: 'query',
  academic_search: 'query',
  // ask_*, council, smart_query, ask_all_ais, chain_query → default "message"
};

interface MCPResult {
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

function normalizeMCPText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  // Some Proxima MCP tools return a structured JSON object as a text block,
  // e.g. smart_query → { success, provider, response, attempts, timestamp }.
  // The chat UI should render the human answer, not the transport envelope.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;

        if (typeof obj.response === 'string') return obj.response.trim();
        if (typeof obj.answer === 'string') return obj.answer.trim();
        if (typeof obj.result === 'string') return obj.result.trim();
        if (typeof obj.text === 'string') return obj.text.trim();
        if (typeof obj.message === 'string') return obj.message.trim();
        if (typeof obj.error === 'string') return `Error: ${obj.error}`;

        if (typeof obj.review === 'string') {
          const meta = [
            typeof obj.filePath === 'string' ? `**File:** ${obj.filePath}` : null,
            typeof obj.provider === 'string' ? `**Provider:** ${obj.provider}` : null,
          ].filter(Boolean).join('\n');
          return meta ? `${meta}\n\n${obj.review}` : obj.review.trim();
        }
      }
    } catch {
      // Not JSON; render as-is.
    }
  }

  return text;
}

function executeMCPTool(tool: string, args: Record<string, unknown>): Promise<MCPResult> {
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
        reject(new Error('Request timeout (180s)'));
      }, 180_000);

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
                method: 'tools/call',
                params: { name: tool, arguments: args || {} },
                id: requestId,
              });
            }

            if (msg.id === requestId && msg.result) {
              clearTimeout(timeout);
              client.destroy();
              resolve(msg.result as MCPResult);
              return;
            }

            if (msg.id === requestId && msg.error) {
              clearTimeout(timeout);
              client.destroy();
              reject(new Error(msg.error.message || 'Tool error'));
              return;
            }
          } catch {
            // continue accumulating
          }
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { tool, message, args: extraArgs } = body as {
      tool: string;
      message?: string;
      args?: Record<string, unknown>;
    };

    if (!tool) {
      return Response.json({ error: 'Missing tool name' }, { status: 400 });
    }

    // Normalize args
    const normalizedArgs: Record<string, unknown> = { ...(extraArgs ?? {}) };

    if (tool === 'compare' && message) {
      const parts = message.split('|');
      normalizedArgs.item1 = parts[0]?.trim() || '';
      normalizedArgs.item2 = parts[1]?.trim() || '';
    } else if (message !== undefined) {
      const mappedParam = PARAM_MAP[tool] ?? 'message';
      normalizedArgs[mappedParam] = message;
    }

    console.log('[v2/api/chat] →', tool, JSON.stringify(normalizedArgs).slice(0, 200));

    const result = await executeMCPTool(tool, normalizedArgs);

    // Extract text from MCP content blocks
    const text = normalizeMCPText(
      (result.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n'),
    );

    return Response.json({
      success: true,
      text,
      raw: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[v2/api/chat] ✗', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
