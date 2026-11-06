# Tennis Xpress

Tennis Xpress is a lawn tennis equipment marketplace launching in Yaoundé, Cameroon. Individual and commercial sellers can list new and used equipment. Buyers can place orders or send inquiries.

## Repository

| Path                | Purpose                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `frontend/`         | Web application built with React, TypeScript, React Router Framework Mode, and Vite, with server-side rendering. |
| `backend/`          | Versioned REST API built with Node.js, TypeScript, Fastify, PostgreSQL, and Drizzle.                             |
| `package.json`      | npm workspace configuration and repository-wide scripts.                                                         |
| `package-lock.json` | Shared dependency lockfile for the root and both workspaces.                                                     |
| `AGENTS.md`         | Repository conventions and instructions for Codex.                                                               |

The repository is in the foundation stage. This setup covers installing dependencies and checking the workspace configuration. Application startup and PostgreSQL setup will be documented as those pieces are added.

## Prerequisites

- Git and a terminal. The commands below are written for Git Bash on Windows.
- Node.js and npm. Use the versions specified in the repository’s runtime configuration.

Check which versions your terminal uses:

```bash
git --version
node --version
npm --version
```

Compare the Node.js and npm output with the repository’s configured versions before installing dependencies.

## Local setup

Clone the repository using the HTTPS URL shown on GitHub. Replace `YOUR_GITHUB_OWNER` and `YOUR_REPOSITORY` with the values from that URL.

```bash
git clone https://github.com/gwankarl/tennis-express-v3.git tennis-xpress
cd tennis-xpress
npm ci
```

Run `npm ci` from the repository root. It installs dependencies for both workspaces using the root lockfile.

## Verify the foundation

From the repository root, list the scripts available in the root and each workspace:

```bash
npm run
npm run --workspace=backend
npm run --workspace=frontend
```

Use the names shown by those listings. With the planned Section 2 script names, the checks are:

```bash
npm run lint
npm run format:check
npm run typecheck --workspace=backend
npm run typecheck --workspace=frontend
```

Successful checks should exit with code zero. If a workspace has no source files yet, TypeScript or ESLint may report that it found no matching inputs. The corresponding check becomes meaningful once source files are added.

## Local environment variables

- Keep local backend settings in `backend/.env` and frontend settings in `frontend/.env` as those settings are introduced. Keep both files out of Git.
- If a workspace includes a tracked `.env.example`, copy it to `.env` in that workspace and fill in your local values. Keep examples free of credentials.
- Keep secrets in server-only settings. Frontend variables prefixed with `VITE_` can be exposed to the browser.
