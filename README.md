English | [Français](README.fr.md)

# local-llm-mcp

An MCP server connecting **Claude Code** to **LM Studio**, to offload token-expensive
work to a local model — without giving up the cloud model's agentic capabilities.

## The idea

Claude keeps the driving seat; only the **bulk work** goes local.

The saving doesn't come from "use a cheaper model." It comes from **keeping raw
content out of the cloud context**: the tools read the files themselves, on the
server side, and only return the processed result.

```
Claude Code  ──(MCP call: "summarize src/**/*.cs")──►  local-llm-mcp
                                                              │
                                                              ├─ reads the files from disk
                                                              ├─ chunks if beyond local context
                                                              └─ queries LM Studio :1234
                                                                       │
Claude Code  ◄────────(≈700 tokens of summary)────────────────────────┘
```

Without this intermediary, reading a source tree burns tens of thousands of
context tokens. With it, the cost shrinks to the size of the response.

## Measurements

Recorded on a real Godot/C# project, with `qwen3-coder-30b`:

| Target | Tokens read locally | Tokens returned | Duration |
|---|---:|---:|---:|
| One 886-line file (46 KB) | 13,462 | 757 | 49 s |
| 8 JSON data files | 35,537 | 674 | 50 s |

The ratio depends entirely on the task: a summary compresses a lot, an
exhaustive extraction much less.

## Requirements

- [LM Studio](https://lmstudio.ai/) with its local server running (port 1234 by default)
- Node.js 18 or later
- [Claude Code](https://claude.com/claude-code)
- A loaded model — see *Model choice* below

Tested on Windows 11. `server.js` has no Windows-specific dependency (the LM
Studio CLI path is resolved per platform), but the helper script
`start-local.ps1` is PowerShell-specific.

## Installation

```sh
git clone https://github.com/drangoht/local-llm-mcp.git
cd local-llm-mcp
npm ci
```

Then register the server with Claude Code, giving the **absolute path** to
`server.js`:

```sh
claude mcp add local-llm --scope user -- node /absolute/path/to/local-llm-mcp/server.js
```

`--scope user` makes it available across all your projects. Use `--scope project`
to limit it to the current repo.

Verification: `claude mcp list` should show `local-llm: ✔ Connected`.

## Exposed tools

| Tool | Role | Savings |
|---|---|---|
| `local_digest` | Reads files (globs), applies an instruction, returns only the result. Automatic map-reduce beyond local context. | **High** — the main tool |
| `local_map` | Applies the same instruction to each file separately, one result per file. Batch processing. | **High** |
| `local_ask` | Free-form question, no file reading. Boilerplate, rewording, commit messages, regex. | Low |
| `local_status` | Diagnostics: models, aliases, context actually loaded. | — |

## Model choice

Two aliases are exposed:

| Alias | Default model | Note |
|---|---|---|
| `code` *(default)* | `qwen/qwen3-coder-30b` | Answers directly, no reasoning phase. |
| `light` | `google/gemma-4-e4b` | Lighter on VRAM, but **always reasons**. |

The chosen default is the **larger** model, which deserves an explanation since
it's counter-intuitive. On the same short task, measured:

| | Raw throughput | Tokens produced | Of which discarded internal reasoning |
|---|---:|---:|---:|
| `gemma-4-e4b` | 67 tok/s | 347 | ~85% |
| `qwen3-coder-30b` | 13.5 tok/s | 19 | 0 |

The smaller model is five times faster *per token*, but produces eighteen times
more of them for an equivalent result. In **useful output**, the larger model
wins. Also, the `enable_thinking: false` parameter has no effect on this model,
and a `max_tokens` set too low makes it return an **empty** `content` — the
server detects this case and reports it explicitly instead of silently
returning an empty string.

Adjust to your hardware via `LOCAL_MODEL_CODE` / `LOCAL_MODEL_LIGHT`.

## Automatic model loading

On startup, the server checks via `lms ps --json` that the model is loaded with
sufficient context, and reloads it if not.

This check exists for a specific reason: LM Studio's `defaultContextLength`
setting is **4096 tokens**. Its just-in-time loading (`justInTimeModelLoading`)
therefore brings the model back down to 4096 as soon as the TTL expires or the
application restarts — and `local_digest` then breaks **silently**: truncated
responses, no error raised. It's the most painful failure mode because it's
invisible.

The check is **non-blocking** (the MCP handshake stays around 0.4 s) and costs
nothing when the configuration is already correct. Disable it with
`LOCAL_AUTOLOAD=0`.

`start-local.ps1` (Windows) does the same thing from a terminal, useful for
preloading the model before opening Claude Code to avoid waiting on the first
call.

## Configuration

All environment variables are optional.

| Variable | Default | Role |
|---|---|---|
| `LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio endpoint |
| `LOCAL_MODEL_CODE` | `qwen/qwen3-coder-30b` | Model for the `code` alias |
| `LOCAL_MODEL_LIGHT` | `google/gemma-4-e4b` | Model for the `light` alias |
| `LOCAL_CONTEXT` | `32768` | Context required at startup |
| `LOCAL_AUTOLOAD` | `1` | `0` disables automatic reloading |
| `LOCAL_TTL_SECONDS` | `28800` | Unload the model after 8 h of inactivity |
| `LOCAL_TIMEOUT_MS` | `600000` | Max call duration (10 min) |
| `LOCAL_ALLOWED_ROOTS` | *(none)* | Roots allowed for reading, separated by `;` |
| `LMS_CLI` | `~/.lmstudio/bin/lms[.exe]` | Path to the LM Studio CLI |

### Restricting reads

By default the server can read any file accessible to the user. To confine it
to your code folders:

```sh
claude mcp add local-llm --scope user \
  --env LOCAL_ALLOWED_ROOTS="/path/to/projects" \
  -- node /absolute/path/to/local-llm-mcp/server.js
```

### Timeouts on the Claude Code side

In `~/.claude/settings.json`:

```json
"env": {
  "MCP_TIMEOUT": "60000",
  "MCP_TOOL_TIMEOUT": "900000"
}
```

A generous `MCP_TOOL_TIMEOUT` is necessary: a `local_map` over several dozen
files takes several minutes.

## When to delegate locally, when to stay in the cloud

| Delegate locally | Keep in the cloud |
|---|---|
| Summarizing a large file or a directory tree | Deciding on an architecture |
| Extracting a list (methods, TODOs, dependencies) | Writing code that must be right the first time |
| Classifying or sorting files by criteria | Debugging a subtle issue |
| First pass over unfamiliar code | Multi-step reasoning |
| Boilerplate, commit messages, regex | Anything that commits to functional correctness |

Short rule: **local is for reducing volume, not for settling a question.**

## Limitations

- **The local model makes mistakes.** It misses edge cases and sometimes
  invents method names. Its output is a starting point to verify, never a
  conclusion on anything critical.
- **Modest throughput** on a GPU that doesn't fully fit the model in VRAM. On
  the reference setup (Radeon RX 9070, 16 GB), a 30B model in Q4 overflows by
  about 3.5 GB and runs at ~13.5 tok/s. A `local_map` over 40 files takes
  several minutes.
- **No streaming**: results arrive as a single block.
- **A single resident model** if VRAM is limited; switching between aliases
  forces a reload (~16 s for an 18 GB model).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `LM Studio unreachable` | Application closed or server stopped | Open LM Studio, or `lms server start` |
| Truncated or inconsistent responses | Context dropped back to 4096 | `local_status` to confirm, then restart the MCP server |
| Empty response + message about reasoning | `light` alias with `max_tokens` too low | Switch to `model: "code"` or raise `max_tokens` |
| First call very slow (~20-30 s) | Model loading | Normal; preload with `start-local.ps1` |
| Timeout on the Claude Code side | `MCP_TOOL_TIMEOUT` too low | See *Timeouts* above |

## License

MIT — see [LICENSE](LICENSE).
