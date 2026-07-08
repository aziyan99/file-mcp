# file-mcp

A tiny local MCP server that reads, writes, updates, and searches files
**anywhere on disk** — not just inside the currently open editor
workspace. Useful as a workaround for Kiro IDE's built-in file tools,
which are unreliable on files outside the open workspace (the Kiro CLI
doesn't have this problem, but the IDE does).

## Tools

| Tool | What it does |
|---|---|
| `read_file` | Read a file's full contents |
| `write_file` | Create or overwrite a file (auto-creates parent dirs) |
| `append_file` | Append text to a file |
| `update_file` | Exact find/replace — `old_str` must match exactly once, or it fails safely and tells you how many matches it found |
| `search_files` | Regex search across a directory tree, returns `file:line: text` |
| `list_directory` | List a directory, optionally recursively |

All paths can be absolute (`/Users/you/project/file.txt`) or `~`-relative
(`~/project/file.txt`). There's no sandboxing — it can reach anywhere
the OS user running it can reach, by design, since the whole point is
to escape the workspace boundary.

## Install

```bash
cd file-mcp
npm install
```

Note where you put this folder — you'll need the absolute path to
`index.js` in the config below.

## Configure in Kiro

Kiro loads MCP servers from a JSON file at:
- **Workspace-only:** `<project-root>/.kiro/settings/mcp.json`
- **All workspaces (global):** `~/.kiro/settings/mcp.json`

Since the whole point is working with files outside any one workspace,
put it in the **global** file: `~/.kiro/settings/mcp.json`.

```json
{
  "mcpServers": {
    "file-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/file-mcp/index.js"],
      "disabled": false,
      "autoApprove": ["read_file", "search_files", "list_directory"]
    }
  }
}
```

Notes:
- Use the **absolute path** to `index.js` — Kiro doesn't expand `~` or
  relative paths in `args`.
- Kiro runs servers with a minimal environment (no inherited shell
  `PATH`). If `node` isn't found, replace `"command": "node"` with the
  full path from `which node` (e.g. `/opt/homebrew/opt/node@22/bin/node`
  on an Apple Silicon Mac with Homebrew).
- `autoApprove` above only auto-approves the read-only tools
  (`read_file`, `search_files`, `list_directory`) so Kiro won't prompt
  for those every time. Writes (`write_file`, `append_file`,
  `update_file`) are left requiring approval on purpose — remove them
  from `autoApprove` if you want a confirmation prompt every time
  something on disk actually changes, or add them if you trust it fully.
- After editing the file, reload/reconnect MCP servers in Kiro (MCP
  panel → refresh, or restart Kiro).

## Configure elsewhere (Claude Desktop, etc.)

Same `command`/`args` shape works in `claude_desktop_config.json` and
most other MCP clients:

```json
{
  "mcpServers": {
    "file-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/file-mcp/index.js"]
    }
  }
}
```

## Test it standalone

```bash
node index.js
```

It should print `file-mcp server running on stdio` to stderr and then
wait for JSON-RPC messages on stdin — that's normal; it's meant to be
driven by an MCP client, not run interactively.
