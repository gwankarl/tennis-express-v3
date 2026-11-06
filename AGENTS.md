# Tennis Xpress — Agent Instructions

## 1. Project and Stack

- Lawn tennis marketplace launching in Yaoundé, Cameroon. Individual and commercial sellers list new and used equipment. Buyers place orders or send inquiries.
- Buyers and sellers share one account. Seller access requires approval. Administrators have separate permissions and MFA. Listings require moderation, and sellers handle fulfillment.
- Frontend uses React, TypeScript, and React Router Framework Mode with Vite and SSR. Backend uses Node.js, TypeScript, Fastify, PostgreSQL, and Drizzle in a modular monolith with a REST API under `/api/v1`.
- Use npm workspaces `backend/` and `frontend/` with one root `package-lock.json`. Check repository configuration, manifests, and the lockfile for runtime and dependency versions.

## 2. Working Mode and Permissions

- Give manual instructions by default. Read-only inspection is allowed. Edit files, install dependencies, or run applications or checks only when explicitly authorized for the current task.
- Work one agreed task at a time. Clarify gaps that affect behavior before coding. For features, agree on requirements and contracts, implement the backend and its tests, then the frontend and its tests, then verify the complete flow.
- Explain why a new dependency is needed before proposing installation. Run npm installs from the repository root. Declare workspace dependencies in each workspace that uses them and repo-wide tooling at the root.
- Keep changes focused. Preserve unrelated work and avoid speculative abstractions, unsolicited documents, and file moves outside the task.

## 3. Manual Implementation Instructions

- Inspect the current files first. Give numbered steps for Windows 11, VS Code, and Git Bash. State the working directory for commands and distinguish Git Bash paths from Windows editor paths.
- For existing files, give a clickable absolute file-and-line link using the inspected location, such as `[file.ts:42](D:/project/path/file.ts:42)`. Include a stable code anchor, the exact insertion or replacement point, and the code to add or replace. Give the path and line in plain text if the link format is unsupported.
- For new files, give the path, any required `mkdir -p` command, the `touch` command, a clickable absolute link to open the file in VS Code, and the complete contents.
- Prefer a complete replacement for substantial or scattered edits. Use actual inspected paths, anchors, and line numbers. Briefly explain why each step is needed and what the important code or configuration does.

## 4. Repository Structure and File Placement

Paths below are planned conventions. Create directories as features need them. Keep shared tooling and the lockfile at the repository root and workspace-specific tool configuration at the workspace root.

### Backend

| Path | Contents |
| --- | --- |
| `backend/src/app.ts` | Compose dependencies, register plugins and routes, and return the Fastify app without starting a listener. |
| `backend/src/server.ts` | Load configuration, start the server, and handle shutdown. |
| `backend/src/config/env.ts` | Load and validate backend environment settings. |
| `backend/src/http/` | Shared HTTP contracts, error handling, request context, route mounting, and reusable guards. |
| `backend/src/modules/<module>/` | Feature routes, schemas, services, repositories, Drizzle tables, and types. |
| `backend/src/infrastructure/` | Database client and technical adapters for logging, email, storage, and payment providers. |
| `backend/src/jobs/` | Schedule and run jobs. Business behavior lives in the owning module. |
| `backend/src/shared/` | Small cross-module utilities and value types, such as errors, money, and pagination. |
| `backend/migrations/` | Reviewed, versioned SQL migrations. |
| `backend/scripts/` | Development and maintenance entry points. |
| `backend/tests/unit/` | Isolated business rules and utilities. Mirror the relevant source paths. |
| `backend/tests/integration/` | API wiring with Fastify injection and database-backed behavior. Keep database-dependent suites separately runnable. |
| `backend/tests/helpers/` | Test app factories, synthetic fixtures, and guarded test database setup. |

- Planned modules include health, identity, seller-onboarding, sellers, catalog, listings, inventory, inquiries, orders, payments, fulfillment, complaints, reviews, notifications, and audit.
- Use `<feature>.routes.ts`, `.schemas.ts`, `.service.ts`, `.repository.ts`, `.table.ts`, and `.types.ts` as needed. Routes handle HTTP and runtime schemas define boundary validation. Services own business rules, resource-level authorization, and transaction coordination. Repositories own queries. Add a controller layer only when complexity justifies it.
- Modules own their Drizzle tables. `backend/src/infrastructure/database/schema.ts` collects table exports for tooling. Admin endpoints belong to the relevant business module. Use explicit interfaces across modules and one transaction for operations that must succeed or fail together.

### Frontend

| Path | Contents |
| --- | --- |
| `frontend/app/root.tsx` | Root document, application shell, and root error boundary. |
| `frontend/app/routes.ts` | React Router route configuration. |
| `frontend/app/routes/` | Route modules for pages and layouts, including their loaders, actions, and error boundaries. |
| `frontend/app/features/<feature>/` | Feature-specific components, hooks, and UI logic shared within a feature. |
| `frontend/app/components/` | Reusable components shared across features. |
| `frontend/app/.server/` | Server-only environment validation, backend API transport, and shared session or request-protection helpers. |
| `frontend/app/styles/` | Shared styles and design tokens as needed. |
| `frontend/public/` | Static assets served directly to browsers. |
| `frontend/tests/unit/` | Isolated helpers, server utilities, and component tests. |
| `frontend/tests/integration/` | Loader, action, and route behavior with controlled dependencies. |
| `frontend/tests/helpers/` | Shared render utilities, test setup, synthetic fixtures, and API mocks. |
| `frontend/tests/e2e/` | Browser workflow tests when scheduled. |

- Mirror relevant `app/` paths in frontend unit and integration tests. Use `*.test.ts` or `*.test.tsx` for workspace tests and `*.spec.ts` for browser tests. Keep browser specs outside Vitest discovery.
- Use the versioned backend API through the frontend’s server-side transport. Keep backend models, services, and infrastructure outside the frontend import graph. Return only safe page data from loaders and actions.

## 5. Code Style and Documentation

- Use strict TypeScript and the repo’s ESLint and Prettier settings. Preserve type safety and keep checks enabled.
- Use concise JSDoc where an exported contract needs explanation. Document important inputs, return values, errors, and side effects. Explain non-obvious business rules, security decisions, transaction boundaries, and concurrency behavior in code and snippets.
- Keep comments current. Update API documentation and secret-free environment examples when contracts or configuration change.

## 6. Security and Data Handling

- Validate boundary inputs and return consistent, safe errors. Enforce authentication, permissions, ownership, and state transitions on the backend. Apply session, origin, and CSRF protections as appropriate.
- Use reviewed migrations, database constraints, transactions, concurrency controls, idempotency, and bounded resource limits where required. Track order, payment, and fulfillment states independently.
- Keep credentials server-only and supporting documents private. Exclude secrets and sensitive data from source, browser data, logs, fixtures, and reports. Use synthetic test data.
- Keep `backend/.env` and `frontend/.env` untracked. Treat `VITE_` variables as public. Track secret-free `.env.example` values for settings the application uses.

## 7. Testing and Verification

- Provide exact verification commands and expected results. Test relevant success, validation, authorization, failure, retry, and concurrency paths. Use a dedicated test database and reject unsafe targets before setup or cleanup.
- Run focused checks when authorized. At feature completion, verify applicable lint, formatting, typecheck, build, unit, integration, and browser checks. Distinguish checks you ran from user-reported and unrun checks.
- Confirm acceptance criteria, required tests, applicable loading/empty/error/success UI states, and documentation. Report changes, verification, and any remaining blockers or limitations concisely.

## 8. Git and Commit Conventions

- Commit, push, merge, deploy, or perform destructive operations only on explicit instruction.
- When asked to commit or suggest a message, use `type(scope): concise imperative summary`, for example `feat(health): add database readiness endpoint`. Add a body when it explains why or records a breaking change.
