#!/usr/bin/env node
// Proxima Web Chat UI - HTTP Server with MCP Tool Execution
import { createServer } from 'http';
import { createConnection } from 'net';
import { readFile, existsSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const readFileAsync = promisify(readFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MCP TCP Daemon port (already running on 19224)
const MCP_PORT = 19224;

// MIME types
const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// MCP uses different parameter names than what the web UI sends.
// Map web-ui "message" to the correct tool parameter.
const PARAM_MAP = {
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
    compare: 'item1',  // compare has item1/item2, web UI sends message as item1
    verify: 'question',
    solve: 'problem',
    how_to: 'question',
    analyze_document: 'question',
    analyze_file: 'question',
    explain_error: 'error_message',
    fix_error: 'code',
    convert_code: 'code',
    ask_selected: 'question',
    get_ui_reference: 'description',
    analyze_code_file: 'question',
};

// Execute MCP tool via TCP to stdio daemon
function executeMCPTool(tool, args) {
    return new Promise((resolve, reject) => {
        const client = createConnection({ port: MCP_PORT, host: '127.0.0.1' }, () => {
            let response = '';
            let initialized = false;
            let requestId = 2;

            const sendJSON = (obj) => {
                client.write(JSON.stringify(obj) + '\n');
            };

            const timeout = setTimeout(() => {
                client.destroy();
                reject(new Error('Request timeout (60s)'));
            }, 60000);

            client.on('data', (data) => {
                response += data.toString();
                
                // Process line by line
                const lines = response.split('\n').filter(l => l.trim());
                response = '';
                
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        
                        // Initialize response
                        if (msg.id === 1 && msg.result && !initialized) {
                            initialized = true;
                            // Send tools/call
                            sendJSON({
                                jsonrpc: '2.0',
                                method: 'tools/call',
                                params: { name: tool, arguments: args || {} },
                                id: requestId
                            });
                        }
                        
                        // Tool result
                        if (msg.id === requestId && msg.result) {
                            clearTimeout(timeout);
                            client.destroy();
                            resolve(msg.result);
                        }
                        
                        // Error
                        if (msg.id === requestId && msg.error) {
                            clearTimeout(timeout);
                            client.destroy();
                            reject(new Error(msg.error.message || 'Tool error'));
                        }
                    } catch (e) {
                        // Continue accumulating
                    }
                }
            });

            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            // Send initialize
            sendJSON({
                jsonrpc: '2.0',
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    clientInfo: { name: 'proxima-web-ui', version: '1.0.0' }
                },
                id: 1
            });
        });
    });
}

// Parse HTTP request pathname
function parsePathname(reqUrl, host) {
    try {
        return new URL(reqUrl, `http://${host}`).pathname;
    } catch {
        return '/';
    }
}

// HTTP server
const server = createServer(async (req, res) => {
    const pathname = parsePathname(req.url, req.headers.host || 'localhost');
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    try {
        // API endpoint
        if (pathname === '/api/execute' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const { tool, args } = JSON.parse(body);
                    if (!tool) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing tool name' }));
                        return;
                    }
                    
                    // Remap "message" to the correct parameter name for this tool
                    let normalizedArgs = { ...args };
                    
                    // Special case: compare uses item1|item2 format (must come before general mapping)
                    if (tool === 'compare' && normalizedArgs.message) {
                        const parts = normalizedArgs.message.split('|');
                        normalizedArgs.item1 = parts[0]?.trim() || '';
                        normalizedArgs.item2 = parts[1]?.trim() || '';
                        delete normalizedArgs.message;
                    } else if (normalizedArgs.message !== undefined) {
                        const mappedParam = PARAM_MAP[tool];
                        if (mappedParam) {
                            normalizedArgs[mappedParam] = normalizedArgs.message;
                            delete normalizedArgs.message;
                        }
                    }
                    
                    console.log('[Web UI] Executing:', tool, normalizedArgs);
                    const result = await executeMCPTool(tool, normalizedArgs);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, result }));
                } catch (err) {
                    console.error('[Web UI] Error:', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }
        
        // Serve static files
        let filePath = pathname === '/' ? '/index.html' : pathname;
        filePath = path.join(PUBLIC_DIR, filePath);
        
        // Security: prevent directory traversal
        if (!filePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        
        if (existsSync(filePath)) {
            const ext = path.extname(filePath);
            const mimeType = MIME[ext] || 'application/octet-stream';
            const content = await readFileAsync(filePath);
            res.writeHead(200, { 'Content-Type': mimeType });
            res.end(content);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    } catch (err) {
        console.error('[Server] Error:', err.message);
        res.writeHead(500);
        res.end('Internal server error');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════╗');
    console.log('║  PROXIMA WEB UI                               ║');
    console.log('║  http://0.0.0.0:' + PORT + '                               ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log('');
    console.log('  Minimal UI — type a message or / for commands');
    console.log('');
});