# Taskano

Taskano is a tool where AI agents lead people through their work, and people set tasks for people.
An agent (for example Claude) breaks the work into steps; each person gets exactly one clear step at a
time in a Telegram bot or in the Telegram Mini App, in their own language. The agent follows up, answers
questions and reviews the results. An MCP connector lets Claude (claude.ai, Claude Code) run a company's
work from a conversation.

## What it does

- One clear step at a time: each person has a "Now" queue (one active item), plus overdue and undated lists; time spent is tracked.
- Work starts by itself on the assignee's first action (a reply or a photo); no separate "Take" tap is needed.
- Tasks carry why, done criteria, a due date, a dossier of sources (quotes, links to Linear/CRM/mail, snapshots) and photos.
- A result can be required before an item is handed in; an optional reviewer accepts it or sends it back with a reason.
- Plans and steps: an agent builds a plan, proposes changes (accepted or vetoed by people), and logs decisions.
- Waiting items: the agent tracks what is expected from outside and checks on it on a date.
- Due-date requests and self-set dates, with a working calendar and time zone per person.
- MCP connector for Claude with 62 tools (tasks, people, plans, projects, review, time, announcements, groups, setup).
- Agent tokens (`tka_`) let a server-side program call the connector as one agent of one company; read tokens (`tkr_`)
  give a person's own program read-only access.
- Announcements with a "Read, confirm" button, and alerts: a repeating announcement by key that stops only when the event does.
- Several companies per person, with a personal space; closed and open boards (projects) with task keys such as `NOR-012`.
- Sign-in: email code or Google for the connector, Telegram for the bot and the Mini App; invitations by email.
- Telegram work groups: the bot reads the chat, files tasks from it and revises them hourly.
- Translation of tasks, questions and notifications into the reader's language: ru, en, tr, vi.
- Background timers: reminders, escalations of unanswered questions, auto-accept, due-date and stuck-item warnings,
  morning digest, weekly report on stalled plans, invitation and connector reminders, per-organization AI budget.
- Mini App: lists, task card with actions, company section (people, boards, agents), statistics, completed items.

## Stack

- Node 22, TypeScript, Express 5
- Telegram bot on grammY, plus a Mini App (React-compatible Preact, Vite) in `app/`
- PostgreSQL 16 with row-level security (one organization = one isolated slice of data)
- graphile-worker for background jobs and timers
- MCP SDK (Streamable HTTP, OAuth 2.1) for the Claude connector
- Anthropic SDK for translation, Resend for email
- Vitest + supertest for tests

## Repository layout

- `src/` server: `core/` domain logic, `bot/`, `mcp/`, `web/`, `worker/`, `db/migrations/`
- `app/` Telegram Mini App (Vite)
- `skill/` the Claude skill and plugin that teaches an agent to lead people through Taskano
- `deploy/` example single-server deployment (docker compose, nginx, backup and monitoring scripts)
- `test/` test suite (runs against a real PostgreSQL)

## Run locally

1. `npm ci`
2. Start PostgreSQL 16 on `127.0.0.1:55432` with the owner `taskano_owner` / `dev`
   (`docker compose -f docker-compose.dev.yml up -d` does exactly that).
3. Copy the variable names from `.env.example` into `.env.local` and fill them in
   (database URLs, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `ENCRYPTION_KEY`, `HMAC_SECRET`, ...).
4. `npm run migrate` creates the schema and the application roles.
5. `npm run dev` starts the server with reload.
6. `npm test` runs the tests. They create their own database (`taskano_test`; set `TASKANO_TEST_DB`
   to use another name) on the PostgreSQL from step 2.

Other scripts: `npm run typecheck`, `npm run build` (server and Mini App), `npm run admin` (admin CLI).

## Language

The product speaks Russian, English, Turkish and Vietnamese. Comments, tests and many internal texts in the
code are written mainly in Russian; the MCP tool descriptions, the skill and the public site are in English.
