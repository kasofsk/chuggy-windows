# chuggy-windows — working notes

A Windows machine's worker pool for chuggy: a scheduled task and a CLI that run the pool loop from the worker core (`@chuggy/worker-core`, kasofsk/chuggy-common) over a container backend, one Docker Desktop container per assignment. It is chuggy-linux's port, module for module where it can be, and `README.md` is the operator's page.

## Where the knowledge is

- **Each gate's own header.** Every script in `.chug/tasks/` opens by stating the rule it enforces, and its sibling `*.test.sh` proves the rule bites. The rule and its enforcement are the same file.
- **chuggy's review brief**, [`review-change.md`](https://github.com/kasofsk/chuggy/blob/main/.chug/tasks/review-change.md). Its house rules and standing commitments bind here, for the rules no script can decide.
- **The loop and the wire are not this tree's.** The pool loop, its token source, its plane client, the credentials reader, registration, the control socket and the container backend with its engine are the worker core's, consumed by commit; the contract is chuggy's, locked to a GitHub release asset by URL and integrity. A change here that needs either to be different is a change there first, then a pin or lock bump here.

## Layout

Every module sits at the root. `cli.mjs` is the entry: it refuses a Node below the floor `nodeFloor.mjs` holds before importing anything that Node may not parse, and otherwise holds nothing but the call; `commands.mjs` is the commands, `runner.mjs` composes a run from the core's backend and this machine's policy, and the service answering for a pool, the configuration, `doctor`'s checks, who may open a file (`windowsAcl.mjs`), the scheduled task (`serviceTask.mjs`), `schtasks` itself (`taskScheduler.mjs`) and the service that restarts `run` (`supervisor.mjs`) each have a module of their own. Suites are `*.test.mjs` and their shared doubles `*.fixture.mjs`. `package.json`'s `files` is the shipped set, which `shipped.test.mjs` holds to every module but those, and `bundleDependencies` carries the core, the contract and zod inside the tarball, so an install needs neither git nor the contract's release.

## Checks

```sh
just check          # every gate and the gates' own suites
just pack           # the installable tarball
```

A fresh clone needs two things once, and neither can set itself:

```sh
npm ci              # the pinned core, the locked contract release and the toolchain the gates run
just hooks          # git config core.hooksPath .githooks
```

A gate exits 0 clean, 1 on a finding, **2 when it could not run** — and 2 is not a pass. `check-source` runs the suites only when `check-contract` finds the locked release installed; an `npm link` to a local chuggy is a could-not-run, never a green run. The hook runs the gates without the shell suites; `--no-verify` bypasses every gate at once. No suite needs Windows, a container engine, Task Scheduler, the network or the rig: the engine, `schtasks` and the access-rule reader are seams, every call they would make is asserted as argv, and every Windows path is built with `path.win32`, so the suites run anywhere.

## Conventions that bite if you miss them

- **Nothing reviews its own work.** A change is reviewed by a fresh reviewer, a session that did not author it, under chuggy's review brief.
- **The engine, `schtasks` and PowerShell are called with `execFile` or `spawn` and never a shell**, and nothing secret goes in an argv: the envelope carries an attempt's bearer, so it reaches the container through an env file under `%LOCALAPPDATA%`, which only its owner may open, that is deleted once `run` returns. PowerShell is handed a path through the environment, never inside its script.
- **Windows has no mode bits that mean anything and ends no process with its parent.** Who may open a file is its owner and access rules, by SID; a task's process is a console host, and ending the task ends every process on that console at once, so `run` is started on no console and ends, having cleaned up, when its input closes.
- **Any account may list and take a free named pipe's name.** A pool's pipe is fresh to each run and found through the record its run writes while it holds the pool's lock, a file opened so no other open succeeds, which Windows lets go of however the run ends; the record is believed only while the lock is held.
- **Docs are concise, correct, consistent and extremely minimal, and a comment is a doc.**
- **A doc that says a path, gate, command or constant exists is making a factual claim, and that claim is checked or it is marked.** A markdown line naming something this tree does not have carries a marker: `<!-- intent -->` designed but not built, `<!-- runtime -->` correctly absent from git, `<!-- absent -->` named because it does not exist. `check-paths` still resolves and prints a marked line. A path of chuggy's or the core's is named as theirs; `check-paths` cannot see another repository's paths, so the reviewer holds that.
- **No comment states a quantity a reader has to trust.** A figure is one the code or a suite derives, never one copied into prose.
- **A rule needs a failure it can prevent here.** Before adding one, name the thing that goes wrong in this tree without it.
- **Don't run destructive commands** without asking first.
