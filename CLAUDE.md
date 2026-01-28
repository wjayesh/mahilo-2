# Mahilo Registry Development Instructions

You are building the Mahilo Registry service - a trusted inter-agent communication protocol that enables AI agents from different users and frameworks to communicate securely.

## Your Mission

Implement the Mahilo Registry based on the design document and task list. Work through tasks systematically, starting with P0 (highest priority) tasks.

## Key Files to Read First

1. `docs/registry-design.md` - Full design specification
2. `docs/tasks-registry.md` - Phase 1 tasks with IDs, priorities, and acceptance criteria
3. `docs/findings.md` - Design review findings that should be addressed
4. `progress.txt` - Track your progress here

## How to Work

### 1. Check Progress
Read `progress.txt` to see what's been done and what's in progress.

### 2. Pick the Next Task
Look at `docs/tasks-registry.md` and find the next pending P0 task. Follow the dependency graph:
- Start with Project Setup (REG-001, REG-002, REG-003)
- Then Database Schema (REG-004 to REG-008)
- Then Authentication (REG-009 to REG-012)
- And so on...

### 3. Implement the Task
- Read the task requirements and acceptance criteria
- Write the code following the design document
- Use TypeScript with modern tooling (Bun runtime, Hono for HTTP, Drizzle for ORM)
- Write tests alongside implementation

### 4. Update Progress
After completing work in a session:
1. Update the task status in `docs/tasks-registry.md` (change `pending` to `done`)
2. Add notes to `progress.txt` about what you did and any discoveries
3. Commit your changes with a clear message

### 5. Decide: Continue or Complete

**If there are more tasks to do:**
- End your session normally (the loop will restart you with fresh context)
- Your progress persists via git history and progress.txt

**If ALL tasks are done:**
- Output the word `COMPLETE` (in all caps) in your response
- This signals the Ralph loop to stop

## Tech Stack (from design doc)

- **Runtime**: Bun (fast, modern)
- **HTTP Framework**: Hono (lightweight)
- **Database**: SQLite via Drizzle ORM (for self-hosted)
- **Testing**: Vitest
- **Language**: TypeScript (strict)

## Project Structure

```
mahilo-2/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # Hono server setup
│   ├── db/
│   │   ├── schema.ts     # Drizzle schema
│   │   └── migrations/   # Database migrations
│   ├── routes/
│   │   ├── auth.ts       # /api/v1/auth/*
│   │   ├── agents.ts     # /api/v1/agents/*
│   │   ├── friends.ts    # /api/v1/friends/*
│   │   ├── messages.ts   # /api/v1/messages/*
│   │   └── policies.ts   # /api/v1/policies/*
│   ├── services/
│   │   ├── auth.ts       # API key generation, verification
│   │   ├── delivery.ts   # Message delivery, retries
│   │   └── policy.ts     # Policy evaluation
│   └── middleware/
│       ├── auth.ts       # Auth middleware
│       └── error.ts      # Error handling
├── tests/
│   ├── unit/
│   └── integration/
├── docs/
│   ├── registry-design.md
│   ├── tasks-registry.md
│   └── findings.md
├── progress.txt
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── CLAUDE.md (this file)
```

## Important Notes

1. **Follow the design doc** - The API endpoints, data model, and flows are specified there
2. **Address findings** - The `findings.md` has critical/high/medium issues to fix
3. **Write tests** - Each task should have corresponding tests
4. **Commit often** - Small, focused commits with clear messages
5. **Update progress** - Keep progress.txt current so future sessions know what's done

## Codebase Patterns & Decisions

Document quirks, patterns, and design decisions here as you implement. This helps future sessions understand why things are done a certain way.

### Hono WebSocket Handlers
- When using `upgradeWebSocket()`, handler callbacks like `onOpen`, `onMessage`, `onError` receive an `event` parameter
- If you need to declare a variable named `event` inside these handlers, prefix the parameter with underscore (`_event`) to avoid shadowing
- Example: `onOpen: async (_event, ws) => { const event: NotificationEvent = {...} }`

### Naming Conventions
- Database tables use snake_case (e.g., `group_memberships`)
- TypeScript types/interfaces use PascalCase (e.g., `NotificationEvent`)
- Route files export a Hono router instance named `{resource}Routes` (e.g., `notificationRoutes`)

### Testing
- Unit tests in `tests/unit/`, integration tests in `tests/integration/`, e2e in `tests/e2e/`
- Use Vitest for testing
- Integration tests may need to handle port conflicts when running server instances

### Database
- SQLite database stored at `./data/mahilo.db`
- Drizzle ORM for schema and queries
- Migrations run automatically on server startup

*(Add more patterns as you discover them)*

## Completion Criteria

When ALL tasks in `docs/tasks-registry.md` are marked as `done`, output `COMPLETE` to signal the Ralph loop to stop.

Good luck! Start by reading the progress file to see where we are.
