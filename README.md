# chuggy-windows

Runs a chuggy worker pool's jobs on a Windows machine. Registered as a pool, the machine runs `chuggy-windows service` as a scheduled task: it runs `chuggy-windows run`, which polls chuggy for assignments and runs each one as a Docker Desktop container of the image the assignment pins.

It needs Windows 11, Node 24 or later, and Docker Desktop running Linux containers. Docker must be local, reached through a named pipe by your current docker context, as Docker Desktop's is.

## Install

```powershell
npm i -g https://github.com/kasofsk/chuggy-windows/releases/download/v0.1.0/chuggy-windows-0.1.0.tgz <!-- intent -->
```

The tarball carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout.

It refuses to run on a Node below 24. A pool's task runs the copy that registered it, under that copy's Node; `chuggy-windows --version` names a copy, and `doctor` warns where the task runs another.

## Register

Mint a registration token for the pool in chuggy, then:

```powershell
chuggy-windows register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

This spends the token, declaring the platform the jobs run on, `Platform:Linux:Amd64` or `Platform:Linux:Arm64`, since Docker Desktop runs them as Linux containers, and writes the pool file chuggy answers with to `%APPDATA%\chuggy\pools\`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, which only you, SYSTEM and the Administrators may open, as everything under `%APPDATA%` is by default.

A project's task can require capabilities rather than pin an image, such as `Agent:Claude` or `Tool:Unity`, and is offered only to a pool advertising every one. Declare each this machine meets with `--capability <token>`, as often as needed; a token is letters, digits, `_`, `:` and `-`, and a platform is never one, since `register` finds it. `--host` has jobs that pin no image run on this machine itself, declaring its own platform, `Platform:Windows:Amd64` or `Platform:Windows:Arm64`, beside its containers'; the pool file then says so. How a job is then met is yours: see [The image a job runs in](#the-image-a-job-runs-in).

From 0.3.0 the pool's service advertises on every poll what it finds when it starts, in place of what the pool was registered with: the platform its containers run, this machine's own beside it where the pool was registered with `--host`, `Agent:Claude` where an `images` entry declares it or the pool was registered with `--host`, and runner.json's `capabilities` or, where it is absent, the rest of what the pool was registered with, less any agent it has no image or host to run. So an edit to runner.json's `images` or `capabilities` takes effect when the service restarts; register again only for a new machine or pool, or to replace a registration. An earlier copy refuses a runner.json naming `capabilities`.

The pool takes the computer name's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. A pool is one per name in a project, so a second machine of the same name registering in the same project displaces the first: give one a `--pool`.

Once the file is written, `register` starts its service. Where every check `doctor` makes passes, it registers the file's task as `install-service` does and runs it. Its first line on stdout says whether the service is running; where it stopped short, it prints why and the commands left. It exits 0 either way, since the token is spent.

Registering a pool again, from here or any machine, replaces its registration. chuggy denies the earlier one, so a service still running it stops, and stays stopped until it is started on the new file. Where the file's own task here serves exactly that file, `register` registers it again, ends it, waits for the ended service to stop answering, and runs it. Registering another pool adds a file beside the first.

### A personal runner

A member's personal runner runs only that member's work, in the projects they allowlist for it in chuggy. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, then:

```powershell
chuggy-windows register --api <chuggy's origin> --token=<token> --personal
```

It takes no `--pool`, and the file is named for the tenant and the member. A member has one personal runner in a tenant, so registering again, from here or any machine, replaces it as registering a pool again does. Every other command takes its file as it takes a pool's.

A member's chat host is registered with `--chat`: see [A chat host](#a-chat-host).

## Configure

**The pool file** is what registering the pool wrote, such as `%APPDATA%\chuggy\pools\vteng.chuggy.shame.json`. Every command but `register` takes it as `--pool <file>`, or from `CHUGGY_WINDOWS_POOL`. Only you, SYSTEM and the Administrators may be able to open it.

**The runner's file** is `%APPDATA%\chuggy-windows\runner.json`. The same holds for who may open it, and a key it does not know is an error.

```json
{
  "concurrencyMax": 1,
  "sessionsMax": 2,
  "claudeTokenFile": "C:\\Users\\you\\AppData\\Roaming\\chuggy-windows\\claude-token",
  "timeoutSecsMax": 7200,
  "outputBytesMax": 1048576,
  "environment": {},
  "network": "chuggy-jobs",
  "imageUnusedSecsMax": 604800,
  "diskFreeGibMin": 20,
  "memoryFreeGibMin": 0,
  "memoryReservedGib": 0
}
```

| Key               | Required | Meaning                                                                                                      |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `engine`          | no       | `docker`, the only one: podman on Windows is only ever a remote client.                                      |
| `concurrencyMax`  | no       | Jobs each pool's service runs at once. Default 1.                                                            |
| `sessionsMax`     | no       | Sessions each pool's service runs at once besides its jobs; 0 runs none. Default 2.                          |
| `claudeTokenFile` | yes      | The file `claude setup-token`'s output was saved to, which only you may open. It is mounted into each job, never read. |
| `codexCredential` | no | `{ "authFile": … }`, the `auth.json` `codex login` writes, which a job requiring `Agent:Codex` is handed in place of the Claude token file, below; 0.6.0 or later. Default none. |
| `timeoutSecsMax`  | yes      | The longest a job may run; a job is killed at the sooner of this and its assignment's deadline.              |
| `outputBytesMax`  | yes      | The most output a job may report.                                                                            |
| `environment`     | no       | Variables handed to every job. `CHUG_WORKER_TASK`, `CHUG_WORKER_WORKSPACE` and `CLAUDE_CODE_OAUTH_TOKEN` are the runner's. |
| `network`         | no       | The bridge network jobs join, made if missing. Default `chuggy-jobs`; never `host`.                          |
| `engineSocket`    | no       | `true` hands each job Docker Desktop's engine, below. Default `false`.                                       |
| `images`          | no       | The images a job that pins none runs in, below. Default none.                                                |
| `capabilities` | no | What this machine meets beyond its platforms and the agents found for it, which each pool's service advertises in place of what `--capability` declared; an agent named here is advertised whether or not an `images` entry declares it; never a platform, each once; 0.3.0 or later. Where it is absent, each advertises the rest of what its pool was registered with. |
| `volumes` | no | Named volumes of Docker Desktop mounted into every job and never a session, below; 0.5.0 or later. Default none. |
| `reportMetrics` | no | `true` has each pool's service report its work and this machine's name, CPUs, memory and free disk against the floor to chuggy, whose Grafana shows them; its memory is this machine's, Windows', while its disk is where Docker Desktop stores, as the floor measures it; Windows keeps no load average, so none is reported; 0.7.0 or later. Default `false`. |
| `imageUnusedSecsMax` | no    | How long a job's image this runner pulled may go unused before it is removed; 0 keeps them until the disk is under `diskFreeGibMin`. Default a week, 604800. |
| `diskFreeGibMin`  | no       | The GiB kept free for what Docker Desktop holds, below; 0 keeps no floor; 0.3.0 or later. Default 20.         |
| `memoryFreeGibMin` | no      | The GiB of Docker Desktop's VM's memory its containers leave free for the engine and the VM, below; 0.3.0 or later. Default 0, which makes all of it the budget. |
| `memoryReservedGib` | no | The GiB of the memory budget no job may ask, kept for what always runs beside the jobs, below; 0.4.0 or later. Default 0, which lets a job ask the whole budget. |
| `dockerDiskDirectory` | no   | The directory holding Docker Desktop's disk image, `docker_data.vhdx`, where its settings moved it. Default `%LOCALAPPDATA%\Docker\wsl\disk`. |
| `chat` | no | A chat host's own settings, in [A chat host](#a-chat-host); 0.8.0 or later. Default none, every setting its default. A chat host needs `claudeTokenFile` alone in a directory of its own. |

Save the token file under `%APPDATA%`, where only you may open it. Docker Desktop shows a file it mounts to every user in the container, so a job reads it as the image's user.

A file is yours alone where you, SYSTEM or the Administrators own it and no one else is allowed anything by its access rules. The directories the runner keeps secrets in, the pool file's and those under `%LOCALAPPDATA%\chuggy-windows`, are held to the same: `register` spends no token, and no other command runs, where one is not, as it would not be if `APPDATA` or `LOCALAPPDATA` named a shared one. A directory not made yet is held to the one it would be made in.

Each assignment's CPU and memory are checked against what Docker Desktop's VM has, not what already runs on it, so a pool's service may run `concurrencyMax` jobs and `sessionsMax` sessions at once; a job also starts only into the room the memory budget below leaves. Docker Desktop's resource settings decide what that VM has.

A session is a project's chat or lead, run on this machine's Claude login, and comes only from a project whose administrator routes Chat or Lead to Runners. It is run as a job is, with the same token file, environment and network, but is not held to `timeoutSecsMax`: it ends once idle, and is killed at its assignment's own deadline.

With `engineSocket` on, each job, and never a session, is handed Docker Desktop's engine, so that its checks can build images and start containers of their own, as testcontainers does. The socket in Docker Desktop's VM is mounted at `/var/run/docker.sock`, read-only, which limits nothing the engine will do; it is root's group's, so each job is added to root's group, and is told where the socket is by `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE`, which `environment` may then not name.

Every job on this machine, and its agent, can then run anything Docker Desktop will. That is root on its VM, every other job and session here among it, and whatever Docker Desktop shares of this machine, which by default is your user folder: a job can mount it and read or change your files, your keys, and this runner's own pool files and tokens. Turn it on only on a machine whose every project you trust that far; `doctor` warns of it whenever it is on. The containers a job starts are left to testcontainers' own clean-up (Ryuk), so a killed job can leave them running.

With `volumes`, every job, and never a session, mounts each named volume listed at its `target`, read-only where `readonly` is `true`, as `--volume <source>:<target>:nocopy`. One whose `scope` is `"project"` is one per project: each job mounts the volume of its own project, named `<source>-<project digest>` and labelled as that project's, so no project's job reads another's cache. A volume that is missing is made by the first job started through chuggy's runtime; an unscoped one you made is mounted as it is, and a project's one is refused unless it carries that project's label. Nothing removes one, not even the disk floor, so a cache grows the disk image up to its own size cap. A directory of this machine is refused, since its path is Windows' and who may write it is its access rules, not a job's uid. A target at, in or above one of chuggy's own paths in a job's container is refused. `doctor` checks each volume and its labels. A compiler cache sccache keeps between jobs:

```json
"volumes": [{ "source": "sccache", "target": "/cache/sccache", "scope": "project" }]
```

**The disk floor** is `diskFreeGibMin`, held each pass against the lower of two: what is free on the drive holding Docker Desktop's disk image, which grows into that drive, and what is free in Docker Desktop's VM under `/mnt/docker-desktop-disk`, which Docker Desktop's disk size caps. The VM's is asked through `wsl -d docker-desktop`, and only once `/mnt/docker-desktop-disk` is a mount. Where only one can be measured, the floor is held on that one, and the service's log, `doctor` and `status` say so; where neither can, or the engine is not Docker Desktop's, no floor is held. Under it, the service removes the images it may, at most once a minute and under half of it every pass, as the hourly removal below does but keeping only the newest of chuggy's runtime and session images, and removing a job's image this runner pulled whatever `imageUnusedSecsMax` says, and takes no job until the disk is over it; sessions and jobs already running go on. Under half of it once that removal has begun, and is done or has run out its 30 s, it kills one job a pass, never a session: the one whose container and workspace hold the most, and otherwise the newest. chuggy shows that job's ticket as Disk low, waiting for you to free space on this machine and resume it. The service's log says when the disk goes under the floor and when it is over again. `doctor` and `status` say what is free against the floor.

What is removed in the VM frees room in the disk image, and Docker Desktop returns it to the drive only where the image is sparse. Where the drive stays under the floor once images are gone, compact the image: stop the runner's tasks, quit Docker Desktop, `wsl --shutdown`, then diskpart's `select vdisk file=<the image>` and `compact vdisk`, or `Optimize-VHD -Path <the image> -Mode Full` where Hyper-V is installed, which Windows Home never has. A floor held on the VM alone, where the drive cannot be measured, fails `doctor`, since the drive is what fills.

**The memory budget** is the memory of Docker Desktop's VM, as docker's `info` says it, less `memoryFreeGibMin`, a reserve for what the engine and the VM use outside every container; none is kept unless the file sets one. Every running container counts against it, whichever pool's service started it: a job or session a runner ran at its memory cap, and anything else, such as a database or what a job starts through `engineSocket`, at what `docker stats` says it uses. A job is held from when the service takes it, before its image is pulled, still this service's and shown in chuggy as starting, and starts once its image is here and the room left takes its cap; if its assignment's deadline comes too near for it to start, it fails as a job lost on its runner, which chuggy resumes by itself up to its retry limit. A held job counts at its cap on every pool's service here, as a volume named for its container with `-held`, until its container runs, and held jobs start in the order they were held. `memoryReservedGib` is kept from jobs for what always runs beside them, such as a lead's sessions: the rest of the budget is the ceiling, and a job asking more is refused, and chuggy shows its ticket as Nowhere to run this work. Each poll tells chuggy the room and the ceiling, and a chuggy that reads them offers the service only jobs that fit both; every pool's service of this account takes those one at a time, under the one claim lock beside the memory lock in `%LOCALAPPDATA%\chuggy-windows\run\memory`, so no two are given the same room. Against a chuggy that does not, no service takes a job while any job is held for room, or while the room is under the least memory a job may ask. Sessions are counted but never held, and may ask the whole budget. The count is approximate: a container counted by its use is counted at what it used when the service last counted, use outside every container is covered only by `memoryFreeGibMin`, and jobs a pool registered with `--host` runs on this machine itself are not counted. `status` says the room, the budget, the ceiling, the sessions' caps and whether the service takes jobs, and why a held job waits.

**Codex.** With `codexCredential`, a job requiring `Agent:Codex` is handed that `auth.json`, mounted read-only where every job's credential is, and every other job the Claude token file. It is held to the same rule: only you, SYSTEM and the Administrators may open it, and `doctor` also reads it as a JSON object. A pool advertises `Agent:Codex` where an `images` entry declares it or the pool runs host jobs, so list the image Codex jobs run in with that capability:

```json
"codexCredential": { "authFile": "C:\\Users\\you\\.codex\\auth.json" },
"images": [{ "image": "ghcr.io/you/agents@sha256:…", "capabilities": ["Agent:Claude", "Agent:Codex"] }]
```

Run `codex login --device-auth` as the task's account, once per machine: a login's refresh token is used once, so two machines never share one `auth.json`. `doctor` warns where the pool advertises `Agent:Codex` and the file names no `codexCredential`, since its Codex jobs would be handed the Claude token file.

## The image a job runs in

A project's configuration names the image its jobs run in, by digest or by tag. An image already in Docker Desktop is used as it is, so one built here with `docker build -t myproject:dev .` serves under that tag and is never pulled; a missing one is pulled. chuggy's runtime is got the same way, copied into a volume of the job's own and mounted read-only at `/opt/chuggy`, and the job starts through it in place of the image's `ENTRYPOINT` and `CMD`. So the image needs:

- `/bin/sh`, and `git` on `PATH`;
- glibc 2.28 or later with libstdc++, as a current Debian or Ubuntu has: an Alpine or other musl image cannot load the runtime;
- a `$HOME` and a temporary directory uid 1000 can write. The workspace is a volume this runner provides.

An image that lacks one is refused before any agent starts, and the ticket stops with a reason naming what is missing.

A private image is pulled with this machine's own login for its registry. Log in once, as the account the scheduled task runs as: `docker login ghcr.io`. The registry the pool was registered for is the exception: a pull from it presents the pool's own token.

A task that pins no image names capabilities instead, and this runner meets them with what you give it in `runner.json`. With `images`, such a job runs in the first image listed declaring every capability it names, its platform aside, and is otherwise refused:

```json
"images": [{ "image": "ghcr.io/you/bazel:7", "capabilities": ["Agent:Claude", "Tool:Bazel"] }]
```

On a pool registered with `--host`, such a job of this machine's platform runs on this machine instead: as you, in a directory of its own under `%LOCALAPPDATA%\chuggy-windows\jobs\`, with its own home and temporary directory, which it is told as `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP` and `TMP`, the service's environment and `environment`, and `git` and its agent's command, such as `claude`, found on the service's `Path`. Nothing isolates it. It can read and change whatever you can, the other jobs here among it, and reach whatever this machine reaches; register with `--host` only a machine whose every project you trust that far. A session, and a job that pins an image, still runs in a container. A host job is killed, with every process still under it, at the sooner of `timeoutSecsMax` and its deadline, when it is stopped, or when the runner ends; Windows has no signal to ask a console program to stop, so each is a kill, and a program started under the job whose parent has already ended, as a background server is, is no longer under it and is left running. Its log is saved beside a container's, and its directory is removed when it ends, or by the next run where a program still holds a file in it.

Host jobs on Windows are not yet whole: the worker core runs a project's `setup` and checks through `/bin/sh`, finds its agent as a program rather than through `PATHEXT` (so an npm-installed `claude.cmd` is not found), and writes a minted git credential to a POSIX path, so for now a host job here runs only an agent installed as an `.exe`, for a project with no setup, no checks and no minted credential. Git for Windows' own credential helper is asked before the job's, so a job can reach a forge with your stored login.

A service the project's checks need, such as a database, is yours and never chuggy's: start it from a check inside the image, or run it in Docker Desktop on the jobs' network and hand every job its address through `environment`.

## A chat host

A member's chat host runs that member's chats with chuggy, each a session, on their own machine and their own Claude login, in one Docker Desktop container of chuggy's chat image that it keeps running. It is one per member in a tenant. A tenant administrator grants the member the right to register one; the member mints a chat host registration token through chuggy's API, `POST /api/v1/tenants/:tenant/chat-host-registration-tokens`, then:

```powershell
chuggy-windows register --api <chuggy's origin> --token=<token> --chat
```

It takes no `--pool`, `--host` or `--capability`, and declares nothing: the file is named for the tenant and the member, then `chat.host`, and its task for the file. Registering again, from here or any machine, replaces the host: chuggy denies the earlier one, so its service stops, and `register` here restarts this machine's task on the new file. `run`, `service`, `status`, `doctor` and `install-service` take the file as they take a pool's; `once` and `stop` refuse it, since a chat host runs only as its service and a session is stopped in chuggy.

It reads the same runner's file as a pool's service: its `claudeTokenFile`, `network`, and `timeoutSecsMax` and `outputBytesMax`, which the file still requires. What is its own is under `chat`, each key optional and any other an error:

```json
"chat": {
  "image": { "image": "ghcr.io/you/chuggy-chat:1", "pull": "missing" },
  "sessionsMax": 4,
  "sessionMemoryMib": 2048,
  "idleSecs": 600,
  "outputBytesMax": 1048576
}
```

| Key                | Meaning |
| ------------------ | ------- |
| `image`            | The image to run in place of the one chuggy names, and `pull`: `missing` (the default) pulls it where it is not here, `always` before each start, `never` not at all. Pulled with this machine's own login for its registry. Default none, which runs chuggy's. |
| `sessionsMax`      | Sessions run at once. Default 4. |
| `sessionMemoryMib` | The memory the container is given for each of those, in MiB. Default 2048. The container is capped at `sessionsMax` times this, with no swap past it, and a session that takes more than its share takes it from the others. |
| `idleSecs`         | How long a session may sit idle before it ends, which chuggy caps. Default 600. |
| `outputBytesMax`   | The most output a session may report. Default the file's `outputBytesMax`. |

`chat` needs chuggy-windows 0.8.0 or later, and so does a chat host's file: an earlier copy refuses a runner.json naming `chat`, so check `chuggy-windows --version` before writing it.

The container is chuggy's supervisor, run as root inside with only the capabilities it needs to make each session's user, and no privilege escalation. Its memory cap, as `sessionMemoryMib` says, is asked of Docker Desktop; `status` and `doctor` print it. It runs each session as a user of its own, which it clears once the session ends, and keeps their directories and the repositories they read in two volumes named for the host, `chuggy-chat-<digest>-sessions` and `-mirrors`, which nothing removes. It is named for the host too, `chuggy-chat-<digest>`, so a second started beside it is refused: one that has exited is removed before each start, and one still running is never killed for it, so a container no service runs refuses every start until it is removed, which `doctor` reports with the command that removes it. It joins `network`, and a session reaches whatever that reaches. Its input is the run's, so it ends when the run does, and every session with it.

The Claude token file's directory is mounted into the container read-only, whole, so a Windows chat host needs the token file alone in a directory of its own, such as `%APPDATA%\chuggy-windows\claude\token`; `run` and `doctor` refuse one with anything beside it, or that anyone else may open. Docker Desktop shows that directory and the file inside the container as root's, open to every user, so the supervisor reads the file as root, behind a directory only root may open, and hands each session a copy only that session's user reads; a token renewed in place serves the next session. Every session uses your Claude plan.

`doctor` checks the chat host's file and the runner's, the directories the runner keeps secrets in, the token file and that it is alone in its directory, the settings and the memory cap they make, the task, the engine and the host's containers, the network, that no supervisor's container is running that the service does not run, a token and one poll of the plane, and that the image the host would run is here or can be pulled: it pulls it where it is not, as the host would before starting, under the host's token where it is in chuggy's registry. `status` prints the `chat` settings, whether the service is running, and from the service, the supervisor's phase and the image it runs against the one chuggy names. Each session's log is kept in `%LOCALAPPDATA%\chuggy-windows\logs\chuggy-chat-<digest>.log`, opening with its assignment.

## Check

```powershell
chuggy-windows doctor --pool $env:APPDATA\chuggy\pools\vteng.chuggy.shame.json
```

Its first line names the copy speaking and the Node it runs under. It checks both files and who may open them, the directories the runner keeps secrets in, the token file, whether jobs are handed Docker Desktop's engine, whether the pool file's task runs this copy, the capabilities a run advertises, the engine and what its VM has, the job network, the free disk against the floor, a token from the pool's issuer and one poll of the plane, which advertises none, and changes nothing. The poll is a long one, so the last check can take a while. Of a chat host it checks what [A chat host](#a-chat-host) says.

## Run as a service

`register` registers the task and starts it itself where it can. Otherwise:

```powershell
chuggy-windows install-service --pool $env:APPDATA\chuggy\pools\vteng.chuggy.shame.json
schtasks /Run /TN \chuggy-windows\vteng.chuggy.shame
```

This registers the pool file's own task, `\chuggy-windows\vteng.chuggy.shame` in Task Scheduler's library, named for the file less `.json`, which runs this install's `chuggy-windows service` under the Node that installed it. It runs as you, only while you are logged on, as Docker Desktop does, with no window. It starts at each logon, and Task Scheduler starts it again every few minutes, which starts nothing while it runs and brings back a service that ended for any reason. Each pool file has a task of its own, so several pools run side by side; a task of the name that serves another pool file is refused. Task Scheduler expands a `%NAME%` in a task's command, so a Node, install or pool file whose path holds a `%`, as a profile whose user name has one does, is refused. Run `install-service` again from the new copy after upgrading Node or moving the install, then end and run the task; until then `doctor` warns that the task runs another. None of it needs an elevated PowerShell, but a task registered from one can be replaced only from one.

The service runs `run` and starts it again ten seconds after it ends, except when the plane denied the pool, which no restart would change: it then stays stopped, and the task's repetition starts nothing, until it is registered again. Its log, with every line `run` prints, is `%LOCALAPPDATA%\chuggy-windows\logs\service-<task>.log`; once it passes its bound it is moved aside to `.log.1`.

To stop a pool's service until you start it again, disable the task, so its repetition does not bring it back, then end it:

```powershell
schtasks /Change /TN \chuggy-windows\vteng.chuggy.shame /DISABLE
schtasks /End /TN \chuggy-windows\vteng.chuggy.shame
```

and to start it again, `/ENABLE` then `/Run`. Ending the task ends the service, which ends `run`; its containers are found by their labels by the next run. To remove it, disable and end it as above, then `schtasks /Delete /TN \chuggy-windows\vteng.chuggy.shame /F`: deleting a task ends nothing it started.

## Commands

| Command             | What it does                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `register`          | Redeems a registration token for a pool file, a personal runner's with `--personal` or a chat host's with `--chat`, and starts its service where it can. |
| `run`               | The runner: polls until the plane denies the pool or chat host.                                                         |
| `service`           | What the task runs: `run`, started again after it ends unless the plane denied the pool.                                 |
| `once`              | One poll, then waits for what it placed to start, and for a job on this machine itself to end. Holds the pool as `run` does, so each is refused while the other runs. Refused of a chat host. |
| `status`            | The runner's limits, the free disk against its floor, the room, ceiling and sessions in the memory budget, this pool's containers, the service's jobs on this machine itself and what it is still pulling, starting or holding for room, each named a job or a session; of a chat host, its settings and its supervisor. |
| `stop <assignment>` | Stops one assignment's container, through the service when it is running; a job on this machine itself only through the service. Refused of a chat host. |
| `doctor`            | The checks above.                                                                                                       |
| `install-service`   | Registers the pool's scheduled task.                                                                                    |

`once` renews nothing after it exits, so with no service running, the lease on what it placed lapses while the container keeps going.

## What it does

- Places an assignment only if the machine that runs it, Docker Desktop's VM or for a host job this one, has the CPU and memory it asks for, counted for that assignment alone, it pins an image, or one `images` lists or `--host` meets it, and the token file is usable; otherwise it refuses it, and chuggy sees the reason.
- Pulls a missing image from the registry the pool was registered for under the pool's own token, written for that one pull to a directory only you can open and removed after it. An image from any other registry is pulled once with no credential, and never with a login Docker Desktop keeps.
- Runs each job as uid 1000 through chuggy's runtime, mounted read-only, with every capability dropped, no privilege escalation, a process limit, the assignment's CPU and memory, the token file mounted read-only, and a workspace volume of its own. The job's credentials reach it through an env file that is deleted once the container starts.
- Keeps renewing an assignment while its image is still pulling, and finds the containers a previous run started.
- Saves an ended job's logs to `%LOCALAPPDATA%\chuggy-windows\logs\<container>.log` and removes the container with its workspace. A job that is stopped, or past its deadline, is killed first. A log longer than 10 MiB or than 200 000 lines is saved as its end, opening with a line saying so. A container whose logs cannot be saved is kept and tried again, and after ten minutes removed without them, which the service's log says.
- Removes images this machine no longer needs, hourly: of each repository chuggy's runtime or sessions came from, every untagged image but the two most recently used, and a job's image this runner pulled itself once it has gone unused for `imageUnusedSecsMax`; under the [disk floor](#configure), more. No removal is forced, so an image a container uses stays. Nor is an image removed while a placement is about to use it, within ten minutes of its last use, or while it has a tag but the one a job pulled it by; to keep an image, tag it. Every runner here keeps one record of what it used, in `%LOCALAPPDATA%\chuggy-windows\images\docker.json`. A job's image pulled before the runner kept that record was never recorded as its own, and stays until you remove it.
- Tells chuggy at once when a job ends without being stopped, with the runner's own reason and never the job's log, and when a session's container ends.

## What it does not do

- Run while you are logged off: the task runs only while you are logged on, as Docker Desktop does.
- Restrict a job's network: the bridge reaches whatever the machine reaches.
- Report a job's result: the job reports to chuggy itself.
- Install Docker Desktop or Node, or upgrade itself.
- Limit a job's workspace: its volume has no size limit.
