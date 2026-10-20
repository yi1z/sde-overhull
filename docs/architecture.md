# Architecture

Overhull is a local Electron application. A project is a Git checkout plus tracked `.sde/` metadata; there is no hosted coordination service. Teammates collaborate through separate clones and explicit commits, pushes, and pulls.

## Module boundaries

| Module                                                  | Responsibility                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/index.ts`                                     | Electron lifecycle, sandboxed window, sender-checked IPC, external browser integration, normal-exit cleanup.                         |
| `src/preload/index.ts`                                  | Allowlisted `window.sde.request` and application events. No renderer filesystem or shell primitives.                                 |
| `src/main/application.ts`                               | Validated RPC and agent-tool dispatch, trust checks, phase transitions, sessions, implementation lifecycle, and verification gates.  |
| `src/main/project.ts`                                   | `ProjectStore`: schemas, artifact revisions, shared records, approval lookup, recovery, and design/code digests.                     |
| `src/main/files.ts`                                     | Canonical JSON, SHA-256 digests, atomic replacement, and repository path confinement.                                                |
| `src/main/git.ts`                                       | Installed Git, status/diffs, selective commits, synchronization, and explicit conflict resolution.                                   |
| `src/main/codex.ts`                                     | `CodexAdapter`: app-server JSON-RPC over stdio, streaming events, questions/approvals, diagnostics, thread resumption, cancellation. |
| `src/main/mcp.ts`                                       | Authenticated loopback MCP gateway exposing application-owned domain tools.                                                          |
| `src/main/verification.ts`, `services.ts`               | Check execution, service dependency/readiness supervision, cancellation, and owned process cleanup.                                  |
| `src/main/preferences.ts`, `run-logs.ts`, `run-lock.ts` | Machine-local settings/session/environment data, full check output, and exclusive checkout ownership.                                |
| `src/shared/types.ts`, `prototypes.ts`                  | Zod domain/RPC contracts and validated prototype component palette.                                                                  |
| `src/renderer/`                                         | React workspace and controls. `DiagramEditor` uses React Flow/ELK; `PrototypeEditor` uses Puck.                                      |

Renderer requests and agent tools converge on the same persistence and lifecycle services. Electron disables Node integration, enables context isolation and sandboxing, blocks navigation/new windows, and denies permission requests. Generated prototypes use the shipped component palette, not privileged executable application code. Running software opens externally.

The MCP gateway binds an ephemeral `127.0.0.1` port and requires a random bearer token, matching Host, and no browser Origin. It exposes context, draft patches, design review, services, verification/completion, and evaluation operations. It does not expose approval or Git mutation tools. Codex runs read-only in Design/Evaluate, workspace-write in Implement, and read-only again for final confirmation.

## Shared files

```text
.sde/
  project.json                         # ProjectManifest; active design ID
  designs/<design-id>/
    design.json                        # Design fields, artifact IDs and digests
    diagrams/<artifact-id>.json         # Diagram
    prototypes/<artifact-id>.json       # Prototype / validated Puck data
  revisions/<design-id>/<revision>.json # Complete DesignRevision recovery snapshot
  approvals/<approval-id>.json          # Approval; commit resolved from Git history
  messages/<message-id>.json            # Completed Message
  feedback/<feedback-id>.json           # EvaluationItem, comments and references
  attachments/<uuid>-<filename>         # Explicitly attached evaluation files
  runs/<run-id>.json                    # ImplementationRun and concise check evidence
  services.json                        # ServiceDefinition[]
```

The project manifest and designs declare schema version 1; all records are validated against their shared schemas. JSON uses stable IDs, sorted object keys, indentation, and a trailing newline. Individual artifacts/messages/feedback reduce merge contention. Completed messages are immutable through the application; feedback and draft artifacts remain editable.

`DesignRevision` contains requirements, questions, decisions, tasks, checks, diagrams, prototypes, and review evidence. Validation also checks unique IDs, graph endpoints/group cycles, requirement/task references, palette properties, and prototype screen links. Manual and agent patches use expected revisions. A stale patch fails without overwriting the newer content; unrelated artifacts keep their positions and revisions.

## Approval and verification invariants

1. **Review the current content.** `designDigest` hashes the validated complete design, excluding only `reviewedDigest` and `reviewSummary`. A content change increments the draft revision and clears review evidence.
2. **Confirm through the application.** Approval requires requirements/tasks, explicit required test and smoke commands, resolved blocking questions, current agent review, and clean source. Service configuration may be included in this approval commit. The approval records the Git identity, design digest, and preceding HEAD baseline.
3. **Use committed authority.** The snapshot, recovery records, manifest, service configuration, and approval are committed together. Approval lookup reads the record from its original addition commit; `getApproved` loads the design from that commit and verifies its digest/reachability. A working-tree approval edit cannot change run scope. The default approval must belong to the active design, so selecting a new draft cannot silently execute an older approval.
4. **Start from a clean checkout.** Implementation records its own starting HEAD and approval commit. Source, tests, and executable configuration must be clean; uncommitted shared discussions and feedback are allowed. Git changes are disabled in the app while the run owns the checkout. Baseline monitoring pauses work if external Git or approved-design changes invalidate the run.
5. **Check before completion.** The agent supplies evidence for every task and reports blockers. Its writing turn ends before host checks run. Required commands execute with cancellation/timeouts and optional declared service dependencies. Missing prerequisites, failures, cancellation, and changed source cannot pass. Successful checks lead to a read-only agent confirmation against the tested digest.
6. **Revalidate on load.** A `complete` status alone is insufficient for **Agent verified**. The active approval, design digest, task coverage, empty blocker list, latest passing required test/smoke results, zero exit codes, and matching tested/output/current code digests must agree. Historical reports remain visible when later source changes make verification stale.

The code digest includes tracked and nonignored untracked source, deletions, executable bits, symlink targets, and `.sde/services.json`. Initialized submodules contribute their HEAD and recursively hashed working content. Other `.sde/` content is excluded, so discussion, feedback, and report commits do not invalidate verification. Ignored build output, environment values, external dependencies, and external service state are not fingerprinted; verification is evidence about the recorded code and checks, not a guarantee about every future runtime environment.

## Concurrency and recovery

`Application` serializes lifecycle mutations and orders agent events. Generation guards discard events from disconnected sessions. `ProjectStore` serializes draft mutations within the process; artifact and design revision checks reject stale updates. Git mutations and destination-file writes also have in-process queues.

Implementation additionally acquires `git rev-parse --git-path overhull-run.lock` with exclusive creation. The record contains PID, hostname, run ID, and a random ownership token. Linked worktrees receive separate locks. A confirmed dead local PID may be reclaimed under a second exclusive recovery guard; live/unknown PIDs, foreign hosts, and malformed records remain blocked conservatively. Release checks ownership and cannot remove a replacement lock.

Each file replacement writes and flushes a temporary sibling before rename. A design save writes its full recovery snapshot first, then component files, and its descriptor last. Descriptor artifact digests detect mixed revisions after interruption. Legacy descriptors remain readable and, when available, are checked against their complete snapshot. This is recoverable multi-file persistence, not a filesystem transaction: inconsistent designs open read-only with the newest valid complete snapshot available for inspection. Restore valid files from Git or resolve the inconsistent metadata before editing; recovery does not silently overwrite the damaged originals.

Unknown future project versions open read-only. Malformed design data and unresolved conflicts also block editing/implementation; malformed individual message/feedback/run records produce warnings rather than erasing valid siblings. A reopened active run is displayed as interrupted. Cancellation preserves partial source edits and a checkpoint digest; committing/pushing those edits lets another clone begin a new run linked to its predecessor. It does not transfer a live process or session lock.

There is no simultaneous live editing or distributed design lock. Use separate checkouts for teammates. Revision checks and process-local queues are not a cross-process transaction mechanism for concurrent manual edits to one metadata directory.

## Git collaboration

`GitService` invokes installed Git with argument arrays, literal pathspecs, the user's configuration/credential helper, and repository/index environment overrides removed. Paths reject traversal, protected Git directories/aliases, and symlink escapes.

Selective commits build a temporary index from HEAD and stage only selected working-tree paths. Renames include their original path. After the commit, only selected paths are refreshed in the real index; unrelated staged content is retained. This path deliberately refuses an active merge.

Pull is fast-forward only. Divergence requires an explicit merge. Conflict inspection exposes base/ours/theirs, and metadata resolutions are schema-validated before staging. Whole-design consistency is checked again when loading and approving. Finish Merge commits the resolved real index, including automatically merged files. No automatic stash, rebase, or force-push is performed.

## Machine-local state and contributor checks

Electron `userData/settings.json` holds appearance, recent/trusted roots, and agent connection preferences. `local.json` stores per-root phase/session references and environment values. These local environment files use OS permissions, not an encrypted secret vault. Codex credentials remain with the installed CLI. Full check output is written beneath `userData/run-logs/<root-hash>/<run-id>.json`; tracked run reports contain concise outcomes. Service logs, child processes, gateway tokens, and active ownership are local runtime state.

Use `pnpm typecheck` and `pnpm test` for contracts and backend behavior. Relevant suites include `storage`, `git`, `run-lock`, `application`, `verification`, `services`, `codex`, and `mcp`. Electron/editor tests run through `pnpm test:e2e`; real account-backed acceptance is separately gated. See [README](../README.md) for commands and [acceptance results](acceptance.md) for the recorded validation scope.
