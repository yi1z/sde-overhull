# Installation and operations

Overhull runs on your workstation. Your repositories, agent credentials, development tools, and services remain local. Git is the collaboration transport.

## Prerequisites

- A desktop operating system supported by the bundled Electron release (Windows, macOS, or Linux).
- Git available on `PATH`, with a configured name/email and GitHub authentication through its credential helper or SSH.
- Codex CLI installed and authenticated with `codex login`. Select its full executable path under Settings if it is not on `PATH`.
- The runtime and package managers needed by the application being developed. For the deepest supported workflow, install Node.js 22.12+ and pnpm 10.
- Docker, databases, and other externally managed services required by your project. Overhull checks configured prerequisites but does not install or control unrelated applications.

The packaged desktop application includes its own Electron runtime. Node.js and pnpm are needed to build Overhull from source and to develop Node-based projects, not to run the desktop shell itself.

## Development installers

Download the artifact for your platform from this repository's **Actions → Desktop validation** run. Extract the artifact archive first.

| Platform            | Package                    | Installation                                                                                                                    |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | `Overhull Setup 0.1.0.exe` | Run the NSIS installer and choose an installation directory.                                                                    |
| macOS Intel         | x64 `.dmg`                 | Mount the image and copy Overhull to Applications.                                                                              |
| macOS Apple Silicon | arm64 `.dmg`               | Mount the image and copy Overhull to Applications.                                                                              |
| Linux x64           | `.AppImage`                | Give the file executable permission, then launch it from a desktop session. AppImage/FUSE support depends on your distribution. |

These initial builds are unsigned and not notarized. Operating-system or organization policy may block them. Use a source build or a build signed through your organization's normal process when needed. No signing credentials are included in this repository.

Linux also needs Chromium's sandbox prerequisites. AppImages require usable unprivileged user namespaces. On systems that restrict them, an administrator can install the unpacked build with its `chrome-sandbox` helper owned by root and mode `4755`. The native CI configures that helper on its disposable runner. Overhull does not disable the renderer sandbox to work around a missing prerequisite.

If GitHub Actions reports artifact storage quota exhaustion, validation and native smoke tests can still complete, but the installer upload is unavailable until account storage is restored. Build from source using the commands below; the job summary distinguishes upload failure from build/test results.

## Reproducible source build

```sh
git clone https://github.com/yi1z/sde-overhull.git
cd sde-overhull
git checkout main-0.1
pnpm install --frozen-lockfile
pnpm dev
```

The repository is private; GitHub access is required. To build installers on the corresponding native platform:

```sh
pnpm build
pnpm exec electron-builder --win --x64 --publish never
# Or: --mac --x64, --mac --arm64, --linux --x64
pnpm test:package
```

On headless Linux, run UI and package smoke checks under `xvfb-run -a`. Installer outputs are in `release/`; do not commit generated binaries. Native CI uploads packages as workflow artifacts. `pnpm package:dir` creates an unpacked local application for debugging.

## First project

Open or clone a Git repository. Select **Trust project** before running the agent or commands. Configure the agent in Settings and use **Check connection** to inspect installation, authentication, and available models.

Start a conversation in Design. Include concrete acceptance criteria when you know them; the agent can narrow a broad idea. You can edit diagrams, screens, requirements, tasks, and test commands before requesting another review. Confirm & Commit requires an agent review of the current digest. If Git has no identity, set `git config user.name` and `git config user.email` in a terminal.

Implement runs in this checkout. Commit source/configuration changes first. Keep service commands in the foreground (for example, `pnpm dev`); do not use detached daemons or `start /b`. Overhull can stop only the process trees it owns. External prerequisites remain externally managed.

## Recovery and troubleshooting

- **Agent interrupted:** partial code remains in the checkout. Stop any active run, commit the checkpoint/source as appropriate, then start another implementation from the same approved design. The next agent receives shared evidence and discussions.
- **Another run owns the checkout:** stop it in the application instance that started it. An expired lock is recovered automatically when its process is absent. Ambiguous or foreign-machine locks require checking the reported lock owner before manual removal.
- **Source changed after verification:** the evidence remains in history, but the UI no longer shows current verification. Re-run the approved checks and obtain fresh agent confirmation.
- **Manual edit cannot save:** retain/export the edited JSON from the UI and inspect the stale-revision error. Reloading deliberately discards the unsaved edit; Overhull never silently overwrites the newer file.
- **Invalid metadata:** files remain on disk. The UI shows a recoverable complete snapshot read-only. Fix the invalid JSON or restore the relevant files through Git. A committed approved design can seed a clean next round. Future schema versions require a compatible app release.
- **Diverged Git history:** commit local changes, fetch, select Merge remote, resolve each conflict, and finish the merge. Selective commits preserve unrelated staging. There is no automatic stash, reset, rebase, or force-push.
- **Service startup fails:** check the service log, executable, working directory, environment-variable names, dependency order, and readiness address. Occupied ports are reported without stopping their owner. Restart acts only on Overhull-owned services.
- **Verification output:** full command output is stored in `run-logs` under Electron's local `userData` directory. Shared reports contain results and digests, not raw logs. UI logs are local and bounded.

Settings and session references live under Electron's platform `userData` directory. Environment overrides are local JSON protected by normal filesystem permissions; they are not an encrypted secret store. Keep credentials out of shared chat, artifact JSON, command arguments, and attachments.
