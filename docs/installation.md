# Installation and operations

Overhull runs on your workstation. Your repositories, agent credentials, development tools, and services remain local. Git is the collaboration transport.

## Prerequisites

- A desktop operating system supported by the bundled Electron release (Windows, macOS, or Linux).
- Git available on `PATH`, with a configured name/email and GitHub authentication through its credential helper or SSH.
- Codex CLI with app-server support installed and authenticated with `codex login`. Select its full executable path under Settings if it is not on `PATH`.
- The runtime and package managers needed by the application being developed. For the deepest supported workflow, install Node.js 22.12+ and pnpm 10.
- Docker, databases, and other externally managed services required by your project. Overhull checks configured prerequisites but does not install or control unrelated applications.

The packaged desktop application includes its own Electron runtime. Node.js and pnpm are needed to build Overhull from source and to develop Node-based projects, not to run the desktop shell itself.

## Development installers

When an **Actions → Desktop validation** run has passed and uploaded artifacts, download the artifact for your platform. Check that it belongs to the commit you intend to run, and extract the artifact archive first. Installer uploads are currently unavailable because the GitHub account's artifact storage quota is exhausted; use the source-build instructions below. A configured CI target is not itself evidence of a successful native build.

| Platform            | Package                    | Installation                                                                                                                    |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | `Overhull Setup 0.1.0.exe` | Run the NSIS installer and choose an installation directory.                                                                    |
| macOS Intel         | x64 `.dmg`                 | Mount the image and copy Overhull to Applications.                                                                              |
| macOS Apple Silicon | arm64 `.dmg`               | Mount the image and copy Overhull to Applications.                                                                              |
| Linux x64           | `.AppImage`                | Give the file executable permission, then launch it from a desktop session. AppImage/FUSE support depends on your distribution. |

Windows development installers are unsigned. macOS development builds use an ad-hoc signature (`identity: "-"`), which supplies no trusted Apple Developer ID and no notarization. Operating-system or organization policy may block these packages. Use a source build or a build signed through your organization's normal process when needed. No developer signing credentials are included in this repository.

Linux also needs Chromium's sandbox prerequisites. AppImages require usable unprivileged user namespaces. On systems that restrict them, an administrator can install the unpacked build with its `chrome-sandbox` helper owned by root and mode `4755`. The native CI configures that helper on its disposable runner. Overhull does not disable the renderer sandbox to work around a missing prerequisite.

Validation and native smoke tests can still complete while installer upload is unavailable. Check the exact run's job results and summary to distinguish upload failure from build/test results; quota exhaustion does not establish either outcome for the native checks.

## Reproducible source build

```sh
git clone https://github.com/yi1z/sde-overhull.git
cd sde-overhull
git checkout main-0.1
pnpm install --frozen-lockfile
pnpm dev
```

Your GitHub account needs access if the repository is private. To build installers on the corresponding native platform:

```sh
pnpm build
pnpm exec electron-builder --win --x64 --publish never
# Or: --mac --x64, --mac --arm64, --linux --x64
pnpm test:package
```

On headless Linux, run UI and package smoke checks under `xvfb-run -a`. Installer outputs are in `release/`; do not commit generated binaries. Native CI attempts to upload packages as workflow artifacts. `pnpm package:dir` creates an unpacked local application for debugging. `pnpm test:package` launches the native unpacked executable and checks its renderer/preload connection; it does not automate installation of an NSIS, DMG, or AppImage package.

## First project

Open or clone a Git repository. Select **Trust project** before running the agent or commands. Configure the agent in Settings and use **Check connection** to inspect installation, authentication, and available models.

**New project** initializes a local Git repository; it does not create a repository on GitHub. To share it, create a remote repository through your usual GitHub workflow, then run `git remote add origin git@github.com:YOUR_ORG/YOUR_REPOSITORY.git` in the project directory. The app's first Push sets the current branch's upstream. Cloning an existing repository already configures `origin`.

Start a conversation in Design. Include concrete acceptance criteria when you know them; the agent can narrow a broad idea. You can edit diagrams, screens, requirements, tasks, and test commands before requesting another review. Confirm & Commit requires an agent review of the current digest. If Git has no identity, set `git config user.name` and `git config user.email` in a terminal.

Implement runs in this checkout. Commit source/configuration changes first. Keep service commands in the foreground (for example, `pnpm dev`); do not use detached daemons or `start /b`. Overhull can stop only the process trees it owns. External prerequisites remain externally managed.

Use **Implement → Development services → Configure services** to inspect the shared JSON manifest and enter local environment values as `NAME=value`, one per line. Enter the complete set of local overrides when updating them; these values replace the saved override set. Declared environment names and service commands are shared, while values stay on this machine. Open-app actions accept local HTTP/HTTPS URLs only.

## Recovery and troubleshooting

- **Agent interrupted:** partial code remains in the checkout. Stop any active run, commit the checkpoint/source as appropriate, then start another implementation from the same approved design. The next agent receives shared evidence and discussions.
- **Another run owns the checkout:** stop it in the application instance that started it. An expired lock is recovered automatically when its process is absent. Ambiguous or foreign-machine locks require checking the reported lock owner before manual removal.
- **Source changed after verification:** the evidence remains in `.sde/runs/`, but the UI no longer shows current verification. Commit the changed source/configuration and choose **Implement design** to start a new run against the approved design. **Run checks** is available during an active run; completion still requires fresh agent confirmation.
- **Manual edit cannot save:** copy the edited artifact's JSON from its JSON view before choosing **Discard local edit and reload**. Review the stale-revision error and reapply the intended changes to the latest saved revision. The application preserves the unsaved edit until you discard it.
- **Invalid metadata:** files remain on disk. For a damaged design, the UI shows a valid complete recovery snapshot read-only when one exists. Restore the descriptor and artifacts as a consistent set through Git; fixing JSON syntax alone may not fix a digest mismatch. After restoring valid metadata, the committed approved design can seed a new round. Future schema versions require a compatible app release.
- **Diverged Git history:** commit local changes, fetch, select Merge remote, resolve each conflict, and finish the merge. Selective commits preserve unrelated staging. There is no automatic stash, reset, rebase, or force-push.
- **Service startup fails:** check the service log, executable, working directory, environment-variable names, dependency order, and readiness address. Occupied ports are reported without stopping their owner. Restart acts only on Overhull-owned services.
- **Verification output:** full command output is stored in `run-logs` under Electron's local `userData` directory. Shared reports contain results and digests, not raw logs. UI logs are local and bounded.

Settings and session references live under Electron's platform `userData` directory. Environment overrides are local JSON protected by normal filesystem permissions; they are not an encrypted secret store. Keep credentials out of shared chat, artifact JSON, command arguments, and attachments.
