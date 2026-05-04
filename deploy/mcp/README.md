# Proxima MCP deployment notes for the next AI agent

This folder exists so another agent can update a VPS that is already running Proxima from the `main` branch.

## What changed in the latest work

These recent changes are the important ones:

- `64b63db` Fix DOM response capture fallback for MiMo and provider audit
- `e40e757` Improve Gemini send flow and tighten provider login heuristics
- `31ed4b1` Add MCP action aliases and tighten Qwen send validation
- `32f6969` Add network response fallback for Qwen and DeepSeek
- `d2e6af0` Fix Z.ai send flow and network response capture
- `e72b738` Fix MiniMax submit flow and response capture
- `14b7f01` Add MCP stdio daemon for IDE clients

## Why this matters

The old fix only solved the zombie leak for one-shot raw requests.
Real IDE MCP clients like Cursor, VS Code MCP, Windsurf, or Inspector CLI need a full stdio MCP session, not a single JSON request/response shim.

The important architecture now is:

1. `proxima-mcp` wrapper in `/usr/local/bin/proxima-mcp`
2. raw TCP daemon on `127.0.0.1:19223` for legacy one-shot requests
3. MCP stdio daemon on `127.0.0.1:19224` for real IDE MCP sessions
4. child `node /Proxima/src/mcp-server-v3.js` per IDE session
5. Electron Agent Hub on port `19222`

This keeps IDE compatibility while still preventing orphaned MCP server processes.

## Files in this folder

- `proxima-mcp`
- `proxima-tcp-daemon.service`
- `proxima-mcp-stdio-daemon.service`

These are the canonical deploy artifacts copied from the working machine.

## What the next AI agent should do on the other VPS

### 1. Update the repo on `main`

Inside the Proxima checkout:

```bash
git checkout main
git pull origin main
```

If the target server is pinned to an older main and cannot fast-forward cleanly, inspect the commits above and merge carefully.

### 2. Deploy the non-repo runtime files

Copy these files into their live system locations:

```bash
install -m 755 deploy/mcp/proxima-mcp /usr/local/bin/proxima-mcp
install -m 644 deploy/mcp/proxima-tcp-daemon.service /etc/systemd/system/proxima-tcp-daemon.service
install -m 644 deploy/mcp/proxima-mcp-stdio-daemon.service /etc/systemd/system/proxima-mcp-stdio-daemon.service
```

### 3. Check path assumptions before enabling services

These files assume:

- repo path is `/Proxima`
- node binary is `/usr/local/bin/node`
- Electron Agent Hub is reachable on `127.0.0.1:19222`

If the target VPS uses different paths, edit the service files before starting them.

Important fields to verify:

- `WorkingDirectory=/Proxima/src`
- `ExecStart=/usr/local/bin/node /Proxima/src/proxima-tcp-daemon.js`
- `ExecStart=/usr/local/bin/node /Proxima/src/proxima-mcp-stdio-daemon.js`
- `Environment=NODE_PATH=/Proxima/node_modules`
- `Environment=MCP_SERVER_PATH=/Proxima/src/mcp-server-v3.js`

### 4. Reload and enable both daemons

```bash
systemctl daemon-reload
systemctl enable --now proxima-tcp-daemon.service
systemctl enable --now proxima-mcp-stdio-daemon.service
systemctl status proxima-tcp-daemon.service --no-pager
systemctl status proxima-mcp-stdio-daemon.service --no-pager
```

### 5. Make sure the Electron app side is alive

These daemons are not standalone.
They depend on the Proxima app or Agent Hub process being alive and listening on port `19222`.

Before deeper testing, confirm the app service is healthy.

## Validation checklist

### A. Raw one-shot path

This checks the legacy request path through `19223`.

```bash
python3 - <<'PY'
import subprocess, json
req={"requestId":1,"action":"getSettings","provider":None,"data":{}}
p=subprocess.run(['/usr/local/bin/proxima-mcp'], input=json.dumps(req)+'\n', text=True, capture_output=True, timeout=60)
print(p.returncode)
print(p.stdout)
print(p.stderr)
PY
```

Expected: JSON result with settings and exit code `0`.

### B. Real MCP stdio client path

Use MCP Inspector CLI as a neutral real client:

```bash
npx -y @modelcontextprotocol/inspector --cli python3 /usr/local/bin/proxima-mcp --method tools/list
```

Expected: tool list succeeds.

### C. Provider validation over the wrapper path

Qwen should succeed directly:

```bash
npx -y @modelcontextprotocol/inspector --cli python3 /usr/local/bin/proxima-mcp \
  --method tools/call --tool-name ask_qwen \
  --tool-arg 'message=Reply with exactly: TEST_QWEN_MARKER'
```

MiniMax should be tested after starting a fresh conversation first:

```bash
npx -y @modelcontextprotocol/inspector --cli python3 /usr/local/bin/proxima-mcp \
  --method tools/call --tool-name new_conversation

npx -y @modelcontextprotocol/inspector --cli python3 /usr/local/bin/proxima-mcp \
  --method tools/call --tool-name ask_minimax \
  --tool-arg 'message=Reply with exactly: TEST_MINIMAX_MARKER'
```

Why fresh conversation matters:

- MiniMax can stay in a stale "still typing" state from a previous task
- that can cause a false timeout in validation even when the wrapper transport is healthy

### D. Zombie/process cleanup check

Run a few repeated MCP calls, then confirm no leftover `mcp-server-v3.js` children remain:

```bash
ps -eo stat=,cmd= | grep 'mcp-server-v3.js' | grep -v grep
ps -eo stat=,cmd= | awk '$1 ~ /^Z/ && $0 ~ /mcp-server-v3.js/ {print}'
```

Expected after sessions exit:

- no lingering child `mcp-server-v3.js` processes
- no zombies for that command

## SSH alias note

On the source machine, `proxima-vps` was intentionally configured to point to localhost only for self-validation.
Do **not** blindly copy that alias to another VPS unless the goal is the same kind of local loopback test.

If you want to test literal SSH launch syntax on the target server, create a host entry that makes sense for that server's own environment.

## Short version

If you only need the minimum safe implementation steps:

1. pull latest `main`
2. copy the 3 files from this folder into `/usr/local/bin` and `/etc/systemd/system`
3. `systemctl daemon-reload`
4. enable both MCP daemon services
5. validate with Inspector CLI
6. use `new_conversation` before MiniMax validation
7. confirm no zombie `mcp-server-v3.js` processes remain
