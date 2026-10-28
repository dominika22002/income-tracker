# Income Tracker (Stage 0 prototype)

This repository contains Stage 0 implementation for a desktop prototype based on:

- Electron (desktop shell)
- React (renderer UI)
- TypeScript (main, preload, renderer, tests)
- Firebase Auth + Firestore (development-oriented configuration with emulator support)

## Stage 0 scope implemented

- Secure Electron architecture: `main` / `preload` / `renderer` split.
- Secure defaults in `BrowserWindow`:
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
- Typed and limited preload API exposed to renderer via `window.electronApi`.
- Native file picker via Electron dialog (`Select local file`).
- Safe write test action into app data directory (`Write test file into app data`).
- OAuth prototype starts in **system browser** (no embedded webview) and handles callback state.
- Firebase emulator-backed Firestore security rules and automated access tests.
- Repeatable scripts for formatting, linting, type checks, unit tests, rules tests, and builds.
- CI pipeline with separate macOS and Windows build jobs.

## Architecture and Stage 0 design decisions

1. **Minimal IPC surface**  
   Only four actions are exposed (`ping`, `selectLocalFile`, `writeTestFile`, `startGoogleOAuth`) plus callback subscription for OAuth result. Renderer has no direct Node.js or file-system access.

2. **OAuth prototype with explicit manual setup**  
   Live Google OAuth + Firebase session exchange requires environment values and provider configuration not stored in this repository. Stage 0 provides:
   - secure external browser start,
   - callback parsing and state validation,
   - user-visible error/success messages.

3. **Firestore rules aligned to DBML intent (Stage 0 subset, extended in Stage 1)**  
   DBML is the source of truth. Stage 0 uses a reduced subset for access-rule verification:
   - `users`
   - `budgets`
   - `memberships`
   - `budget_records` (test-protected budget data)

   The full budget model from `wymagania.dbml` is intentionally deferred to Stage 1+.

## Stage 1: budget data model and access

Details and design decisions: [docs/etap-1-mapowanie.md](./docs/etap-1-mapowanie.md) (DBML → Firestore mapping, indexes, rules, transactions).

- **Trusted server logic** lives in `src/server/` and is exposed as callable Cloud Functions by `functions/` (bundled with `npm run build:functions`). It uses the Admin SDK only on the server side; the client never contains admin credentials (checked by `tests/unit/clientSecrets.test.ts` and an ESLint rule).
- **Firestore rules** (`firestore.rules`) make identity, budget, membership and invitation data read-only for clients. Access to budget data requires an existing `budgets/{id}/active_members/{uid}` document, which the server creates and deletes in the same transaction as the membership.
- **Domain rules** (status transitions, 7-day invitations, deterministic admin succession) are plain functions in `src/shared/domain/` with unit tests.
- **UI** (`src/renderer/src/features/budgets/`) talks to the server only through the `BudgetBackend` interface and reads data with Firestore listeners that are subject to the rules.
- Cloud Functions need the Blaze plan when deployed (see `wymagania.md` §9); the region is not chosen yet (functions default to `us-central1`). Emulators need no billing.

```bash
npm run test:rules      # rules + service integration tests (Firestore emulator, needs Java)
npm run test:e2e        # UI flows against the emulator (needs Java)
npm run test:functions  # callable functions on Auth/Firestore/Functions emulators (needs Java)
```

## Prerequisites

- Node.js 24+
- npm 11+
- Java Runtime (required by Firestore emulator used by `firebase-tools`)

## Setup

```bash
npm install
npm install --prefix functions
cp .env.example .env.local
```

Update `.env.local` with your own non-secret development values.

## Running the desktop app

```bash
npm run dev
```

The app opens a desktop window with:

- secure IPC health check,
- local file picker button,
- test file write button,
- OAuth start button,
- online/offline simulation controls.

## Firebase emulator configuration

Firestore rules are defined in `firestore.rules`, emulator config in `firebase.json`.

Run rules tests (starts emulator automatically):

```bash
npm run test:rules
```

## Test commands

```bash
npm run test:unit
npm run test
npm run test:rules
npm run test:e2e
npm run test:functions
```

## Quality and validation commands

```bash
npm run format
npm run lint
npm run typecheck
```

## Build commands

```bash
npm run build:mac
npm run build:win
npm run build
```

## CI

GitHub Actions workflow: `.github/workflows/ci.yml`

Jobs:

- `verify` (format, lint, typecheck, unit tests, Firestore rules tests)
- `build-macos`
- `build-windows`

## Manual steps that cannot be fully automated in this repository

1. Create/configure Firebase project for live environment (if needed).
2. Configure Google OAuth credentials and authorized redirect URI (`income-tracker://oauth`).
3. Register custom protocol handling for packaged app validation on macOS/Windows.
4. Verify real end-to-end OAuth in system browser with a real account.
5. Verify signed installer/notarization/SmartScreen flow (outside Stage 0 local automation).

## Known Stage 0 limitations

- The OAuth callback is prototyped; full token exchange and durable Firebase session refresh for production requires additional provider/backend setup.
- Build signing/notarization is not configured (intentional Stage 0 limitation).
- Full DBML model is not implemented in Firestore yet: Stage 1 covers users, preferences, budgets, memberships and invitations; accounts, imports, transactions and the rest follow in later stages.
- The live Google sign-in (token exchange into a Firebase session) is still the Stage 0 prototype; Stage 1 flows are tested with a provider stand-in.
- Real-time behavior of listeners was verified on the emulator only.
