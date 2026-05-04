#!/usr/bin/env node
/**
 * Proxima MCP STDIO Daemon
 *
 * Accepts TCP client connections and gives each one an isolated, managed
 * MCP stdio server child process. This preserves MCP stdio compatibility for
 * IDE clients while avoiding orphaned SSH-spawned Node processes.
 */

import net from 'net';
import { spawn } from 'child_process';

const LISTEN_HOST = process.env.PROXIMA_MCP_STDIO_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.PROXIMA_MCP_STDIO_PORT || '19224', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '10', 10);
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
const NODE_BIN = process.env.NODE_BIN || '/usr/local/bin/node';
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || '/Proxima/src/mcp-server-v3.js';

let activeConnections = 0;
let clientSeq = 0;

function log(level, msg) {
    const ts = new Date().toISOString().substring(11, 23);
    console.error(`[${ts}] [${level}] ${msg}`);
}

function createIdleTimer(onTimeout) {
    const timer = setTimeout(onTimeout, IDLE_TIMEOUT);
    return {
        refresh() {
            timer.refresh();
        },
        clear() {
            clearTimeout(timer);
        }
    };
}

function handleClient(socket) {
    const clientId = ++clientSeq;
    if (activeConnections >= MAX_CONCURRENT) {
        log('WARN', `Rejecting client #${clientId}, over limit (${MAX_CONCURRENT})`);
        socket.destroy();
        return;
    }

    activeConnections++;
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log('INFO', `Client #${clientId} connected from ${remote} (active: ${activeConnections})`);

    const child = spawn(NODE_BIN, [MCP_SERVER_PATH], {
        cwd: '/Proxima/src',
        env: {
            ...process.env,
            NODE_PATH: process.env.NODE_PATH || '/Proxima/node_modules'
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let closed = false;
    const idle = createIdleTimer(() => {
        log('WARN', `Client #${clientId} idle timeout, terminating child pid=${child.pid}`);
        cleanup('idle-timeout');
    });

    function refresh() {
        if (!closed) idle.refresh();
    }

    function cleanup(reason = 'cleanup') {
        if (closed) return;
        closed = true;
        idle.clear();

        try { socket.destroy(); } catch {}
        try { child.stdin.destroy(); } catch {}
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.kill('SIGTERM'); } catch {}

        activeConnections--;
        log('INFO', `Client #${clientId} closed (${reason}), child pid=${child.pid}, active: ${activeConnections}`);
    }

    socket.on('data', (chunk) => {
        refresh();
        if (!child.stdin.destroyed) {
            child.stdin.write(chunk);
        }
    });

    socket.on('end', () => {
        log('DEBUG', `Client #${clientId} socket ended`);
        try { child.stdin.end(); } catch {}
    });

    socket.on('close', () => {
        cleanup('socket-close');
    });

    socket.on('error', (err) => {
        log('ERROR', `Client #${clientId} socket error: ${err.message}`);
        cleanup('socket-error');
    });

    child.stdout.on('data', (chunk) => {
        refresh();
        if (!socket.destroyed) {
            socket.write(chunk);
        }
    });

    child.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
            for (const line of text.split('\n')) {
                if (line.trim()) log('CHILD', `#${clientId} ${line.trim()}`);
            }
        }
    });

    child.on('exit', (code, signal) => {
        log('INFO', `Child for client #${clientId} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (!socket.destroyed) {
            try { socket.end(); } catch {}
        }
        cleanup('child-exit');
    });

    child.on('error', (err) => {
        log('ERROR', `Child spawn error for client #${clientId}: ${err.message}`);
        cleanup('child-error');
    });
}

const server = net.createServer(handleClient);

server.on('error', (err) => {
    log('ERROR', `Server error: ${err.message}`);
    process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log('INFO', `Proxima MCP STDIO daemon listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
