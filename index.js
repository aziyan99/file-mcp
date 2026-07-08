#!/usr/bin/env node
/**
 * file-mcp — a local MCP server for reading, writing, updating, and
 * searching files ANYWHERE on disk (not limited to the current
 * editor/IDE workspace). Built to work around IDEs (e.g. Kiro) whose
 * built-in file tools misbehave on files outside the open workspace.
 *
 * Tools exposed:
 *   - read_file
 *   - write_file
 *   - append_file
 *   - update_file      (exact string find/replace, must match exactly once)
 *   - search_files      (regex search across a directory tree)
 *   - list_directory
 */

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
  { name: "file-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- helpers ----------

function resolvePath(p) {
  // Expand ~ and resolve to absolute path. No sandboxing: this server
  // is meant to reach the whole filesystem the user runs it under.
  if (p.startsWith("~")) {
    p = path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return path.resolve(p);
}

async function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

async function walk(dir, opts, results, depth = 0) {
  const { maxDepth, exclude } = opts;
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return; // permission denied / not a dir — skip
  }
  for (const entry of entries) {
    if (exclude.some((ex) => entry.name === ex)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, opts, results, depth + 1);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
}

const DEFAULT_EXCLUDES = ["node_modules", ".git", ".hg", ".svn", "dist", "build", ".venv"];

// ---------- tool definitions ----------

const TOOLS = [
  {
    name: "read_file",
    description:
      "Read the full contents of a file at an absolute or ~-relative path, anywhere on disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or ~/...) to the file to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file or completely overwrite an existing file with the given content. Creates parent directories if needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or ~/...) to write." },
        content: { type: "string", description: "Full text content to write to the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description: "Append text to the end of an existing file (creates the file if it doesn't exist).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or ~/...) of the file." },
        content: { type: "string", description: "Text to append." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "update_file",
    description:
      "Find-and-replace a unique exact substring in a file. old_str must match exactly one location in the file, or the call fails with the number of matches found (0 or 2+) so you can adjust. Use this for precise edits instead of rewriting the whole file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or ~/...) of the file to edit." },
        old_str: { type: "string", description: "Exact text to find (must be unique in the file)." },
        new_str: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  {
    name: "search_files",
    description:
      "Recursively search a directory tree for files whose contents match a regular expression. Returns matching file paths with line numbers and the matching line text.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Absolute path (or ~/...) of directory to search." },
        pattern: { type: "string", description: "Regular expression to search for (JS regex syntax)." },
        file_glob: {
          type: "string",
          description: "Optional simple filename filter, e.g. '*.js' or '*.py'. Matches by extension/substring.",
        },
        case_sensitive: { type: "boolean", description: "Default false." },
        max_results: { type: "number", description: "Cap on number of matching lines returned. Default 200." },
        max_depth: { type: "number", description: "Max directory recursion depth. Default 10." },
      },
      required: ["directory", "pattern"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at a given path, optionally recursively.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or ~/...) of directory to list." },
        recursive: { type: "boolean", description: "Default false." },
        max_depth: { type: "number", description: "Max recursion depth when recursive. Default 5." },
      },
      required: ["path"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "read_file": {
        const p = resolvePath(args.path);
        const content = await fs.readFile(p, "utf-8");
        return { content: [{ type: "text", text: content }] };
      }

      case "write_file": {
        const p = resolvePath(args.path);
        await ensureDir(p);
        await fs.writeFile(p, args.content, "utf-8");
        return {
          content: [{ type: "text", text: `Wrote ${Buffer.byteLength(args.content, "utf-8")} bytes to ${p}` }],
        };
      }

      case "append_file": {
        const p = resolvePath(args.path);
        await ensureDir(p);
        await fs.appendFile(p, args.content, "utf-8");
        return { content: [{ type: "text", text: `Appended ${Buffer.byteLength(args.content, "utf-8")} bytes to ${p}` }] };
      }

      case "update_file": {
        const p = resolvePath(args.path);
        const original = await fs.readFile(p, "utf-8");
        const matches = countOccurrences(original, args.old_str);
        if (matches === 0) {
          return {
            content: [{ type: "text", text: `No match found for old_str in ${p}. File unchanged.` }],
            isError: true,
          };
        }
        if (matches > 1) {
          return {
            content: [
              {
                type: "text",
                text: `old_str matched ${matches} times in ${p} — it must be unique. Add more surrounding context and try again. File unchanged.`,
              },
            ],
            isError: true,
          };
        }
        const updated = original.replace(args.old_str, args.new_str);
        await fs.writeFile(p, updated, "utf-8");
        return { content: [{ type: "text", text: `Updated ${p} (1 replacement).` }] };
      }

      case "search_files": {
        const dir = resolvePath(args.directory);
        const flags = args.case_sensitive ? "g" : "gi";
        let re;
        try {
          re = new RegExp(args.pattern, flags);
        } catch (e) {
          return { content: [{ type: "text", text: `Invalid regex: ${e.message}` }], isError: true };
        }
        const maxResults = args.max_results || 200;
        const maxDepth = args.max_depth || 10;

        const files = [];
        await walk(dir, { maxDepth, exclude: DEFAULT_EXCLUDES }, files);

        const globFilter = args.file_glob
          ? args.file_glob.replace("*", "").toLowerCase()
          : null;

        const results = [];
        for (const file of files) {
          if (globFilter && !file.toLowerCase().endsWith(globFilter)) continue;
          let text;
          try {
            text = await fs.readFile(file, "utf-8");
          } catch (e) {
            continue; // binary or unreadable, skip
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              results.push(`${file}:${i + 1}: ${lines[i].trim()}`);
              if (results.length >= maxResults) break;
            }
          }
          if (results.length >= maxResults) break;
        }

        const text =
          results.length === 0
            ? `No matches for /${args.pattern}/ under ${dir}`
            : results.join("\n");
        return { content: [{ type: "text", text }] };
      }

      case "list_directory": {
        const p = resolvePath(args.path);
        if (!args.recursive) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
        } else {
          const maxDepth = args.max_depth || 5;
          const results = [];
          await walk(p, { maxDepth, exclude: DEFAULT_EXCLUDES }, results);
          return { content: [{ type: "text", text: results.join("\n") || "(no files found)" }] };
        }
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("file-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
