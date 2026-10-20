# Acceptance results

## Release-candidate validation

Source revision: `26a71a613a539c5d5d075b53f60d399f61a55971` on `main-0.1`.

Native Windows validation on **2026-10-20** passed:

- The complete 75-test deterministic suite passed with CI settings in **91.10 seconds**. Five additional refresh-ordering and diagram-selection regressions then passed in focused suites. The two credentialed tests are intentionally skipped in the default suite and were executed separately as recorded below.
- `pnpm build`, `pnpm typecheck`, and formatting checks passed.
- `pnpm test:e2e`: **six real Electron interaction tests passed in 26.4 seconds**. Coverage includes a 1024×680 window, actual diagram dragging/connections/grouping, visual Puck selection and field edits, compact palette/outline controls, validated JSON, persisted reloads, keyboard settings, dark theme, 125% interface scaling, a 2× display-scale restart, immediate-close autosave, and repository switching.
- Windows x64 NSIS generation and `pnpm test:package` passed. The packaged renderer, sandboxed preload, and settings IPC started successfully, then exited cleanly.

The local `release/Overhull Setup 0.1.0.exe` is unsigned. Its SHA-256 is:

`9EA133DAE388CE565E3EAD8A6A423C1F98930E740711596C84DFD4C12B1A255F`

## Native CI — passed

[Desktop validation run 39498198989](https://github.com/yi1z/sde-overhull/actions/runs/39498198989) completed successfully on **2026-10-20** against the source revision above. Every native runner passed **80 deterministic tests** and **six real Electron interaction tests**. The two credentialed tests remain opt-in and were not run using CI credentials.

| Native runner             | Installer generation | Packaged startup  | Additional verification                                       |
| ------------------------- | -------------------- | ----------------- | ------------------------------------------------------------- |
| Windows x64               | NSIS passed          | Passed            | Real Electron UI, including close/reload/repository switching |
| macOS Intel x64           | DMG passed           | Passed            | Ad-hoc signature passed `codesign --verify --deep --strict`   |
| macOS Apple Silicon arm64 | DMG passed           | Passed            | Ad-hoc signature passed `codesign --verify --deep --strict`   |
| Linux x64                 | AppImage passed      | Passed under Xvfb | Chromium sandbox helper configured on the disposable runner   |

The package smoke test launches the generated **unpacked application**, exercises its renderer/preload/settings IPC, and requires a successful clean exit. Installer generation is verified separately; automated installation through every OS installer dialog and physical multi-monitor testing are not claimed.

**Installer upload was unavailable on all four jobs:** GitHub reported that the account's artifact storage quota was exhausted. Upload is an optional delivery step, so this does not mask test, build, signature, or startup failures. No CI installer download is currently available from this run. The Windows installer exists locally at `release/Overhull Setup 0.1.0.exe`; reproduce other packages with the native commands in [installation and operations](installation.md). Windows builds are unsigned; macOS builds are ad-hoc signed without Developer ID or notarization.

## Acceptance coverage

| Scenario                                                                         | Recorded evidence                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real design → manual revision → approval → implementation → startup → evaluation | Credentialed `tests/live-acceptance.test.ts`, described below; production application facade and actual Codex                                                                                                                                  |
| Collaboration using Git alone                                                    | `tests/git.test.ts` exchanges a populated grouped diagram, nested prototype, approved task/check plan, committed approval, user/agent discussions, implementation report, and run/screen-linked feedback between two clones; both finish clean |
| Stale agent patches preserve manual work                                         | `tests/storage.test.ts` rejects stale revision writes before changing disk                                                                                                                                                                     |
| Divergence and malformed metadata                                                | Explicit conflicting-version merge test plus schema validation, future-version read-only access, mixed-revision detection, and complete snapshot recovery tests                                                                                |
| Completion cannot bypass checks or task evidence                                 | Application/verification tests reject absent task coverage, failed/missing checks, cancellation, overlapping mutable turns, and changed tested source                                                                                          |
| Historical evidence and verification currency                                    | Persisted reports are revalidated on load; source, executable configuration, renames, and submodule changes affect currency; discussions and feedback do not                                                                                   |
| Service lifecycle and isolation                                                  | Real child-process tests cover dependency readiness, cancellation cleanup, missing prerequisites/environment, occupied ports, and preservation of unrelated/previously running processes                                                       |
| Recovery and desktop usability                                                   | Cross-process checkout locks, session reconstruction, interrupted-run recovery, shutdown draining, plus the six native Electron interaction tests                                                                                              |

Conflict versions are currently previewed as source text rather than side-by-side rendered diagrams or prototypes. The 2× display-scale check exercises Chromium's scale factor; it does not substitute for physical multi-monitor testing.

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

The completed real cycle exercises the Windows application service layer and actual agent integration. Its digest identifies that disposable project's tested source at the time of the recorded run, not the Overhull release commit. Browser/editor, clone exchange, malformed metadata, approval/verification rejection, and native packaging have separate automated tests. macOS/Linux build, editor, and packaged-startup evidence comes from the native CI run above; the credentialed real-agent cycle was performed on Windows only. Packaged smoke checks do not automate installer interaction or a full agent cycle on every platform. Native macOS signature checks validate ad-hoc signatures, not Developer ID signing or notarization.
