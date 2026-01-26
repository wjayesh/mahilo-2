# Mahilo Registry

A trusted inter-agent communication protocol that enables AI agents from different users and frameworks to communicate securely.

## Project Status

This project uses a **Ralph Wiggum loop** for autonomous development. Claude Code runs in iterations, tracking progress in `progress.txt` and task status in `docs/tasks-registry.md`.

## Quick Start

### Run the Ralph Loop

```bash
# Run with default 50 iterations
./scripts/ralph.sh

# Run with custom iteration limit
./scripts/ralph.sh 100
```

The loop will:
1. Start Claude Code with instructions from `CLAUDE.md`
2. Claude works on the next pending task
3. Progress is tracked in `progress.txt`
4. Task status is updated in `docs/tasks-registry.md`
5. Loop repeats until `COMPLETE` is output or max iterations reached

### Check Progress

```bash
# View current progress
cat progress.txt

# View task status
cat docs/tasks-registry.md
```

## Project Structure

```
mahilo-2/
├── CLAUDE.md              # Instructions for Claude Code
├── README.md              # This file
├── progress.txt           # Progress tracking (append-only log)
├── docs/
│   ├── registry-design.md # Full design specification
│   ├── tasks-registry.md  # Phase 1 tasks with status
│   └── findings.md        # Design review findings
├── scripts/
│   └── ralph.sh           # Ralph Wiggum loop script
└── src/                   # Source code (created during development)
```

## Documentation

- **Design Document**: `docs/registry-design.md` - Complete specification
- **Tasks**: `docs/tasks-registry.md` - Phase 1 implementation tasks
- **Findings**: `docs/findings.md` - Design review issues to address

## Tech Stack

- **Runtime**: Bun
- **HTTP Framework**: Hono
- **Database**: SQLite via Drizzle ORM
- **Testing**: Vitest
- **Language**: TypeScript

## How It Works

The Ralph Wiggum pattern:
1. Each iteration spawns a fresh Claude Code instance
2. Memory persists via git history, `progress.txt`, and task files
3. Tasks are sized to fit in a single context window
4. Loop exits when `COMPLETE` is detected in output

## Related Projects

- **Clawdbot Mahilo Plugin**: Built in the [clawdbot](../clawdbot) repo at `extensions/mahilo/`
- **Plugin Design**: `clawdbot/docs/mahilo/plugin-design.md`
- **Plugin Tasks**: `clawdbot/docs/mahilo/tasks-plugin.md`
