# Acceptance results

## Real Codex development cycle — passed

Run on native Windows x64 on **2026-10-20**, using the developer's installed, authenticated Codex app-server and a disposable Git repository. The production `Application` facade ran headlessly; the test did not substitute a simulated agent. Elapsed test time: **456.24 seconds**.

The agent created requirements, implementation tasks, required commands, four typed diagrams (workflow, UI, database, backend), and a Puck prototype for a minimal two-service web application. The test applied developer edits to a prototype heading and node position through the production design API, invalidating the old review. The agent reviewed the new digest and preserved both changes. The Confirm & Commit Design application action recorded the approval in Git.

The real implementation created the frontend and backend, fulfilled all approved tasks, and registered their service dependency/readiness definitions. The application ran both required checks: **17 unit tests passed**, and the HTTP smoke check passed with application-managed services. The agent then confirmed completion in a read-only review turn against the unchanged tested source digest:

`87b05c1b11974047eff5ffdc0a5d71baa90c0be3f03268b6bb9f63fae9ce6070`

The production startup action brought up the backend and frontend in dependency order. HTTP assertions confirmed the revised heading, frontend API proxy response, and backend health route. Stop cleaned up the owned services. The test saved evaluation feedback against the completed run and promoted it into a new design round with its origin preserved. This exercised the same application actions used by the UI, without claiming a human clicked through this headless run.

Reproduce in PowerShell with an installed Node.js, Git, authenticated Codex CLI, and project dependencies:

```powershell
$env:SDE_LIVE_ACCEPTANCE = '1'
pnpm exec vitest run tests/live-acceptance.test.ts
```

On macOS/Linux:

```sh
SDE_LIVE_ACCEPTANCE=1 pnpm exec vitest run tests/live-acceptance.test.ts
```

This test uses real model calls and may consume account usage. It creates and removes its own temporary repository. `SDE_CODEX_PATH` can select a specific executable. Deterministic tests remain the default; the real cycle is opt-in.

## Focused runtime checks

The real Codex-to-authenticated-MCP connection test also passed independently in **8.9 seconds**. Deterministic runtime and protocol tests covered service dependency ordering, readiness, process cleanup, unrelated occupied ports, missing prerequisites, command cancellation/timeouts, changed-source verification rejection, MCP authentication/origin checks, app-server streaming, interruption, and phase-specific sandbox/resumption. Native packaging and UI acceptance results are recorded separately by the release validation workflow.

## Scope of this evidence

The completed real cycle exercises the Windows application service layer and actual agent integration. Its digest identifies that disposable project's tested source at the time of the recorded run, not the Overhull release commit. Browser/editor, clone exchange, malformed metadata, approval/verification rejection, and native packaging have separate automated tests. macOS/Linux packages and Electron startup require their native CI runner results; this Windows result does not claim those platforms were executed locally. Packaged smoke checks launch the unpacked application and test renderer/preload startup; they do not automate installer interaction, signing/notarization, or a full agent cycle on every platform.
