#!/usr/bin/env node
/**
 * Proxima TCP Daemon — Long-running relay between IDE clients and Electron Agent Hub
 * 
 * Listens on port 19223 (TCP) for IDE client connections
 * Forwards requests to Electron Agent Hub on port 19222
 * Returns responses back to IDE clients
 * 
 * Single persistent process — managed by systemd with Restart=always
 * 
 * Usage: node proxima-tcp-daemon.js
 */

import net from 'net';
import { Readable } from 'stream';

const LISTEN_PORT = process.env.PROXIMA_DAEMON_PORT || 19223;
const HUB_HOST = process.env.PROXIMA_HUB_HOST || '127.0.0.1';
const HUB_PORT = process.env.PROXIMA_HUB_PORT || 19222;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '20', 10);
const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '120000', 10); // 2 min idle before forced close
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '180000', 10); // 3 min per request

// Active connections counter
let activeConnections = 0;
let totalRequests = 0;
let totalErrors = 0;

// ─── Logging ───────────────────────────────────────────────
function log(level, msg) {
    const ts = new Date().toISOString().substring(11, 23);
    console.error(`[${ts}] [${level}] ${msg}`);
}

// ─── Handle individual client connections ───────────────────
function handleClient(clientSocket, clientId) {
    activeConnections++;
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    log('INFO', `Client #${clientId} connected (active: ${activeConnections})`);

    let hubSocket = null;
    let requestId = 0;
    const pendingRequests = new Map();
    let clientBuffer = '';
    let clientClosed = false;

    // Per-client timeout — close if no activity
    const idleTimer = setTimeout(() => {
        if (!clientClosed) {
            log('WARN', `Client #${clientId} idle timeout, closing`);
            cleanup();
        }
    }, IDLE_TIMEOUT);

    function resetIdleTimer() {
        clearTimeout(idleTimer);
        if (!clientClosed) {
            idleTimer.refresh();
        }
    }

    function cleanup() {
        if (clientClosed) return;
        clientClosed = true;
        clearTimeout(idleTimer);
        activeConnections--;
        if (hubSocket) {
            try { hubSocket.destroy(); } catch(e) {}
            hubSocket = null;
        }
        try { clientSocket.destroy(); } catch(e) {}
        // Reject any pending requests
        for (const [rid, { reject }] of pendingRequests) {
            reject(new Error('Connection closed'));
        }
        pendingRequests.clear();
        log('INFO', `Client #${clientId} disconnected (active: ${activeConnections})`);
    }

    // Connect to Agent Hub
    function connectToHub() {
        return new Promise((resolve, reject) => {
            if (hubSocket && !hubSocket.destroyed && hubSocket.writable) {
                resolve();
                return;
            }

            if (hubSocket) {
                try { hubSocket.destroy(); } catch(e) {}
                hubSocket = null;
            }

            hubSocket = net.createConnection({ host: HUB_HOST, port: HUB_PORT }, () => {
                log('DEBUG', `Client #${clientId} connected to Agent Hub`);
                resolve();
            });

            hubSocket.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const response = JSON.parse(line);
                        if (response.requestId && pendingRequests.has(response.requestId)) {
                            const { resolve: res, timer } = pendingRequests.get(response.requestId);
                            clearTimeout(timer);
                            pendingRequests.delete(response.requestId);
                            res(response);
                        }
                    } catch(e) {
                        log('ERROR', `Client #${clientId} parse error: ${e.message}`);
                    }
                }
                resetIdleTimer();
            });

            hubSocket.on('error', (err) => {
                log('ERROR', `Client #${clientId} hub error: ${err.message}`);
                for (const [rid, { reject }] of pendingRequests) {
                    reject(err);
                }
                pendingRequests.clear();
            });

            hubSocket.on('close', () => {
                log('DEBUG', `Client #${clientId} hub disconnected`);
            });

            hubSocket.setTimeout(REQUEST_TIMEOUT, () => {
                log('WARN', `Client #${clientId} hub timeout`);
                if (hubSocket) { try { hubSocket.destroy(); } catch(e) {} }
                cleanup();
            });

            hubSocket.once('error', (err) => {
                reject(err);
            });
        });
    }

    // Process messages from client
    async function processMessage(rawMsg) {
        if (clientClosed) return;

        let request;
        try {
            request = JSON.parse(rawMsg);
        } catch(e) {
            log('ERROR', `Client #${clientId} invalid JSON: ${e.message}`);
            return;
        }

        const rid = ++requestId;
        request.requestId = rid;

        // Ensure we have hub connection
        if (!hubSocket || hubSocket.destroyed) {
            try {
                await new Promise((resolve, reject) => {
                    hubSocket = net.createConnection({ host: HUB_HOST, port: HUB_PORT }, () => resolve());
                    hubSocket.once('error', reject);
                    hubSocket.on('data', (data) => {
                        const lines = data.toString().split('\n');
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const response = JSON.parse(line);
                                if (response.requestId && pendingRequests.has(response.requestId)) {
                                    const { resolve: res, timer } = pendingRequests.get(response.requestId);
                                    clearTimeout(timer);
                                    pendingRequests.delete(response.requestId);
                                    res(response);
                                }
                            } catch(e) {
                                log('ERROR', `Client #${clientId} parse error: ${e.message}`);
                            }
                        }
                        resetIdleTimer();
                    });
                    hubSocket.on('close', () => {
                        log('DEBUG', `Client #${clientId} hub disconnected`);
                    });
                    hubSocket.setTimeout(REQUEST_TIMEOUT, () => {
                        log('WARN', `Client #${clientId} hub timeout in connect`);
                        try { hubSocket.destroy(); } catch(e) {}
                    });
                    log('DEBUG', `Client #${clientId} connecting to Agent Hub...`);
                });
                log('DEBUG', `Client #${clientId} connected to Agent Hub`);
            } catch(e) {
                log('ERROR', `Client #${clientId} cannot connect to hub: ${e.message}`);
                try { clientSocket.write(JSON.stringify({ requestId: rid, error: e.message }) + '\n'); } catch(err) {}
                return;
            }
        }

        // Send to hub
        try {
            hubSocket.write(JSON.stringify(request) + '\n');
            log('DEBUG', `Client #${clientId} sent request #${rid} to hub`);
        } catch(e) {
            log('ERROR', `Client #${clientId} send error: ${e.message}`);
            return;
        }

        // Wait for response with timeout
        const timer = setTimeout(() => {
            if (pendingRequests.has(rid)) {
                pendingRequests.delete(rid);
                log('WARN', `Client #${clientId} request #${rid} timed out`);
                try { clientSocket.write(JSON.stringify({ requestId: rid, error: 'Request timeout' }) + '\n'); } catch(err) {}
            }
        }, REQUEST_TIMEOUT);

        pendingRequests.set(rid, {
            resolve: (response) => {
                clearTimeout(timer);
                try {
                    if (!clientClosed && !clientSocket.destroyed) {
                        clientSocket.write(JSON.stringify(response) + '\n');
                        log('DEBUG', `Client #${clientId} sent response #${rid} to client`);
                    }
                } catch(e) {
                    log('ERROR', `Client #${clientId} write error: ${e.message}`);
                }
            },
            reject: (err) => {
                clearTimeout(timer);
                try {
                    if (!clientClosed && !clientSocket.destroyed) {
                        clientSocket.write(JSON.stringify({ requestId: rid, error: err.message }) + '\n');
                    }
                } catch(e) {}
            },
            timer
        });

        resetIdleTimer();
    }

    // Client data handler
    clientSocket.on('data', (data) => {
        clientBuffer += data.toString();
        resetIdleTimer();

        // Process complete JSON messages (newline-delimited)
        let newlineIdx;
        while ((newlineIdx = clientBuffer.indexOf('\n')) !== -1) {
            const msg = clientBuffer.substring(0, newlineIdx);
            clientBuffer = clientBuffer.substring(newlineIdx + 1);
            if (msg.trim()) {
                totalRequests++;
                processMessage(msg);
            }
        }
    });

    clientSocket.on('error', (err) => {
        log('ERROR', `Client #${clientId} socket error: ${err.message}`);
        totalErrors++;
        cleanup();
    });

    clientSocket.on('close', () => {
        log('DEBUG', `Client #${clientId} connection closed`);
        cleanup();
    });

    clientSocket.setTimeout(IDLE_TIMEOUT + 30000, () => {
        log('WARN', `Client #${clientId} socket timeout`);
        cleanup();
    });

    // Handle urgent data
    clientSocket.on('end', () => {
        log('DEBUG', `Client #${clientId} sent FIN`);
        cleanup();
    });
}

// ─── Main server ──────────────────────────────────────────
let clientIdCounter = 0;

const server = net.createServer((clientSocket) => {
    if (activeConnections >= MAX_CONCURRENT) {
        log('WARN', `Max connections (${MAX_CONCURRENT}) reached, rejecting`);
        clientSocket.write(JSON.stringify({ error: 'Server busy, max concurrent connections reached' }) + '\n');
        clientSocket.destroy();
        return;
    }

    const clientId = ++clientIdCounter;
    handleClient(clientSocket, clientId);
});

server.on('error', (err) => {
    log('ERROR', `Server error: ${err.message}`);
    process.exit(1);
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
    log('INFO', `Proxima TCP Daemon listening on 127.0.0.1:${LISTEN_PORT}`);
    log('INFO', `Proxying to Agent Hub at ${HUB_HOST}:${HUB_PORT}`);
    log('INFO', `Max concurrent clients: ${MAX_CONCURRENT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('INFO', 'Received SIGTERM, shutting down...');
    server.close(() => {
        log('INFO', 'Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    log('INFO', 'Received SIGINT, shutting down...');
    server.close(() => {
        process.exit(0);
    });
});

// Stats reporting (every 5 minutes)
setInterval(() => {
    if (process.env.REPORT_STATS === 'true') {
        log('INFO', `Stats: active=${activeConnections} total_req=${totalRequests} errors=${totalErrors}`);
    }
}, 300000);

// Keepalive
process.on('uncaughtException', (err) => {
    log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
    totalErrors++;
});
