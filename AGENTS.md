# AGENTS.md — OOU Attendance System

This file tells AI coding agents how to work in this codebase. Read it before making any changes.

## Project Summary

- **Name:** OOU Attendance System
- **Purpose:** University attendance management for Olabisi Onabanjo University (OOU)
- **Stack:** React + TypeScript + Vite (frontend), Express.js + TypeScript (backend), PostgreSQL (database), Playwright (E2E testing), npm (package manager)
- **API style:** REST
- **Locations:**
  - `frontend/` — React client
  - `backend/` — Express API server
  - `database/migrations/` — SQL migration files (7 existing migrations)
  - `tests/e2e/` — Playwright end-to-end tests
  - `docs/` — Project documentation

---

## Development Rules

### 1. Inspect Before Changing
- Read the existing codebase before making any changes. Understand the current architecture, file layout, conventions, and data flow.
- Trace symbols to their definitions and usages. Do not guess at types, imports, or module boundaries.

### 2. Do Not Assume
- Do not assume frameworks, libraries, databases, or architecture without inspecting the project first.
- The backend uses Express.js 5 + TypeScript + `pg` (PostgreSQL driver via connection pool). The frontend uses React 19 + React Router 7 + Vite. The database is PostgreSQL with hand-written SQL migrations. These are facts from the existing code — verify, do not assume.

### 3. Manual Dependency Installation
- Do not install dependencies automatically.
- If a dependency is required, tell the user the exact package name and the exact installation command (e.g. `cd backend && npm install <package>`).
- Wait for the user to install it before proceeding.

### 4. No Automatic Git Operations
- Do not commit, push, reset, force-push, or rewrite Git history unless the user explicitly requests it.
- The user controls version control. You may stage files for review only if the user asks.

### 5. Small, Focused Changes
- Make small, focused changes. One concern per change.
- Do not modify unrelated files. If a change touches a route, do not also reformat a CSS file.

### 6. Preserve Existing Functionality
- Do not break what already works. Verify existing behavior is preserved after changes.

### 7. No Unnecessary Rewrites
- Do not perform unnecessary rewrites or refactors. If the code works and the task is about adding a feature or fixing a bug, leave working code alone unless it directly blocks the task.

### 8. No Hardcoded Secrets
- Never hardcode passwords, API keys, tokens, or other secrets in source code, configuration files, or tests.
- Secrets belong in environment variables (`backend/.env`) or a secrets manager. The `.env` file is already gitignored.

### 9. Never Ask for Secrets in Chat
- Never ask the user to paste secrets into the chat. If credentials are needed, instruct the user to add them to the appropriate `.env` file or secrets store.

### 10. Enforce Authentication and Authorization on the Server
- All authenticated endpoints must verify the user's session or token on the server side. Do not rely on the frontend to enforce access control.
- Role-based access (admin, lecturer, student) must be checked server-side for every protected route.

### 11. Protect Attendance Data — Authorization Checks
- Users must not be able to access another user's attendance records by manipulating IDs, URLs, or request parameters.
- Every request that reads or modifies attendance data must verify that the requesting user is authorized to see or act on that specific record (ownership check, role check, or both).

### 12. Treat Attendance Records as Important Data
- Do not silently delete or modify attendance records. Attendance data is important — changes should be intentional, auditable, and preferably non-destructive.
- Prefer soft deletes or explicit admin actions over silent data loss. If a deletion or bulk modification is required, ask the user first.

### 13. Validate User Input on the Server
- All user input must be validated on the server, even if the frontend performs validation.
- Use the project's existing validation layer (`backend/src/validation/`) or a comparable approach. Reject invalid input with clear error responses.

### 14. Do Not Invent Business Rules
- Do not invent business rules when requirements are unclear. Ask before implementing behavior that affects attendance records (marking, overriding, deleting, eligibility, reporting).
- When a requirement is ambiguous, state the ambiguity and ask for clarification rather than guessing.

### 15. Follow Existing Conventions
- After inspecting the project, follow the existing frontend, backend, database, and API conventions.
- Conventions observed in this project:
  - Backend: Express.js 5 with TypeScript, `pg` connection pool, hand-written SQL migrations, route files in `backend/src/routes/`, services in `backend/src/services/`, middleware in `backend/src/middleware/`, validation in `backend/src/validation/`.
  - Frontend: React 19 functional components, React Router 7 for routing, Vite as dev server and bundler, plain CSS (`frontend/src/index.css`), TypeScript strict mode.
  - Database: PostgreSQL with sequential numbered SQL migration files in `database/migrations/`. No ORM (e.g. Prisma) is currently used — the `pg` driver is used directly.
  - API: REST, JSON request/response, session-cookie authentication backed by a database Session table (not JWT).
  - Testing: Playwright for E2E tests in `tests/e2e/`, backend unit tests in `backend/tests/` using Node's native test runner with `tsx`.

### 16. Database Changes — Careful and Non-Destructive
- Make database changes carefully. Use the migration file pattern already established in `database/migrations/`.
- Avoid destructive operations (DROP, irreversible ALTERs) unless explicitly requested. Add new tables/columns through new migration files rather than editing existing ones.

### 17. Verify After Changes
- Run relevant type checks, tests, builds, or other verification after making changes.
- For backend changes: `cd backend && npm run build` (TypeScript compilation) and/or `cd backend && npm test` (unit tests).
- For frontend changes: `cd frontend && npm run build` (TypeScript + Vite build) and/or `cd frontend && npm run lint` (oxlint).
- For E2E changes: `npm run test:e2e` from the project root (requires the backend and frontend to be running).

### 18. Never Claim Without Verifying
- Do not claim something works without verifying it. Run the relevant checks and report the actual results.

### 19. No Fake or Placeholder Implementations
- Do not create fake or placeholder implementations that pretend a feature is complete. If a feature cannot be fully implemented, leave it clearly incomplete (e.g. a logged error, a stub that returns 501, or a TODO comment explaining what is missing) — never pretend it works.

### 20. Stay Inside the Project
- Keep the work strictly inside this Attendance System project unless the user explicitly instructs otherwise. Do not reach into other directories or create files outside the project tree.

---

## Workflow

Use this workflow for every task:

1. **Inspect** — read the relevant files and understand the current state.
2. **Explain the plan** — tell the user what you intend to do and why, before making changes.
3. **Make focused changes** — apply the smallest change that accomplishes the goal.
4. **Verify** — run the relevant checks (build, typecheck, tests) and confirm they pass.
5. **Report** — give a concise summary.
6. **Wait** — pause and wait for the next instruction. Do not continue autonomously.

---

## Report Format

Keep reports concise and include:

- **What changed** — a brief description of the change.
- **Why** — the reason for the change.
- **Files changed** — list of files, with paths relative to the project root.
- **Checks run** — what verification was performed (build, typecheck, tests, etc.).
- **Results** — pass/fail and any relevant output.
- **Remaining issues or decisions** — anything that still needs attention, or choices that were made and may need review.

---

## Hermes-Specific Preferences

This section is for Hermes Agent (the coding agent running in this session). It reflects the user's working style:

- **Step-by-step development.** Work in small, verifiable steps. Do one focused task at a time. Do not batch unrelated changes into a single step.
- **One focused task at a time.** Complete and verify one task before moving to the next. Do not start multiple independent changes in parallel unless the user explicitly asks.
- **Manual dependency installation.** Never install npm packages, run `npm install`, or add dependencies automatically. Tell the user the exact command and wait for them to run it.
- **No automatic Git operations.** Do not commit, push, or manipulate Git history. The user controls version control.
- **Clear explanations before significant changes.** Before making a change that affects architecture, API contracts, database schema, or multiple files, explain what will change and why. Wait for acknowledgment.
- **Simple, maintainable, production-quality code.** Write code that is clear, readable, and production-ready. Avoid over-engineering. Prefer straightforward solutions that follow the existing patterns in the project. Do not add abstractions unless they are justified by a real, current need.
