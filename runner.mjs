/**
 * The runner composed: the pool's credentials and the runner's file read, and
 * the container backend beside the worker core's pool runner, which passes
 * until the plane denies the pool. Where the pool was registered with
 * `--host`, a job that pins no image runs on this machine itself, beside the
 * containers. Each poll advertises what the runner finds of this machine and
 * its file when the run starts. Every command starts here.
 *
 * EVERY BACKEND IS TOLD THE KIND OF CLAUDE CREDENTIAL, a subscription's. The
 * core withholds what would choose another credential only from a workload
 * told one, so a run that told none would let a variable its jobs inherit
 * outrank the token.
 */

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolRunnerClient,
  poolRunnerLoop,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";

import { containerBackend } from "@chuggy/worker-core/containerBackend.mjs";
import {
  hostBackend,
  hostPlatformsDeclared,
  hostRoutedBackend,
} from "@chuggy/worker-core/hostBackend.mjs";
import { containerEngine } from "@chuggy/worker-core/engine.mjs";
import {
  dockerContextArgv,
  dockerInfoArgv,
  networkCreateArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolIdentityDigest } from "@chuggy/worker-core/poolIdentity.mjs";
import {
  registerAdvertised,
  registerPlatform,
} from "@chuggy/worker-core/register.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import {
  diskFloorBytes,
  diskFreeLogged,
  diskFreePorts,
  engineDiskFree,
} from "./diskFree.mjs";
import { memoryFreeBytes } from "./memoryFree.mjs";
import {
  claudeTokenFileRefusal,
  runnerClaudeCredential,
  runnerConfig,
  runnerPaths,
} from "./runnerConfig.mjs";
import { poolServiceReleasedNow } from "./poolService.mjs";
import { deniedExitStatus } from "./serviceTask.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 * @typedef {import("./runnerConfig.mjs").SharedRefusal} SharedRefusal
 *
 * @typedef {object} RunnerSetup
 * @property {string} poolFile
 * @property {PoolCredentials} credentials
 * @property {RunnerConfig} config
 * @property {RunnerPaths} paths
 *
 * @typedef {object} Runner
 * @property {string} runtime the pool's runtime directory
 * @property {Engine} engine
 * @property {import("./diskFree.mjs").DiskFreePorts} disk what the free disk is measured by
 * @property {ContainerBackend} backend
 * @property {WorkerPoolClient} client
 */

/** The wait before a pull the registry refused is made again under a fresh token. */
const pullRetryMs = 5_000;

/** The cap on an engine call with no deadline of its own, which guards a hung engine. */
const engineCallTimeoutMs = 300_000;

/**
 * @param {string} poolFile
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @param {SharedRefusal} sharedRefusal who besides this account may open a file
 * @returns {Promise<RunnerSetup>}
 */
export async function runnerSetup(poolFile, environment, home, sharedRefusal) {
  const paths = runnerPaths(environment, home);
  return {
    poolFile,
    credentials: await poolCredentials(poolFile, (file) => sharedRefusal(file)),
    config: await runnerConfig(paths.config, sharedRefusal),
    paths,
  };
}

/**
 * A pool's own runtime directory under the runner's, so no two pools share
 * scratch. It sits in `pools`, a name no scratch entry has.
 *
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 */
export function poolRuntimeDirectory(paths, identity) {
  return win32.join(paths.runtime, "pools", poolIdentityDigest(identity));
}

/**
 * The directories the runner keeps secrets and logs in: the pool file's, the
 * runtime and log directories, where each attempt's bearer and each pull's
 * token are written, and where a job on this machine itself mints its own.
 *
 * @param {RunnerPaths} paths
 * @param {string} poolFile
 */
export function runnerSecretDirectories(paths, poolFile) {
  return [win32.dirname(poolFile), paths.runtime, paths.logs, paths.jobs];
}

/**
 * Makes the directories the runner keeps secrets and logs in, and refuses
 * one someone besides this account may open. They sit under the profile's
 * application data, which only this account, SYSTEM and the Administrators
 * may open, and inherit that, unless APPDATA or LOCALAPPDATA names somewhere
 * else.
 *
 * @param {RunnerPaths} paths
 * @param {string} poolFile
 * @param {SharedRefusal} sharedRefusal
 */
export async function runnerDirectoriesChecked(paths, poolFile, sharedRefusal) {
  for (const directory of runnerSecretDirectories(paths, poolFile)) {
    await mkdir(directory, { recursive: true });
    const shared = await sharedRefusal(directory);
    if (shared !== undefined)
      throw new Error(
        `the directory ${directory} ${shared}; the runner keeps secrets there`,
      );
  }
}

/**
 * The lock a service takes to start a job into Docker Desktop's memory: one
 * for every pool's service of this account, which share the runtime
 * directory under the local application data.
 *
 * @param {RunnerPaths} paths
 */
export function runnerMemoryLock(paths) {
  return win32.join(paths.runtime, "memory", "docker.lock");
}

/**
 * The capabilities each poll of a pool's run advertises, found when it
 * starts: the platform its containers run, this machine's own beside it
 * where the pool was registered with `--host`, the agents the runner's file
 * can run, and what the file's `capabilities` declares or, where it is
 * absent, the rest of what the pool was registered with. A machine no pool
 * runs on, and a set past the contract's bound, are refused.
 *
 * @param {Pick<RunnerSetup, "credentials" | "config" | "paths">} setup
 * @param {string} arch as `process.arch` names this machine
 * @returns {string[]}
 */
export function runnerCapabilities(setup, arch) {
  const { credentials, config, paths } = setup;
  const found = registerPlatform(arch);
  if ("refused" in found) throw new Error(found.refused);
  const host = credentials.host === true;
  const hosted = host ? hostPlatform(arch) : undefined;
  const advertised = registerAdvertised({
    platforms: [found.platform, ...(hosted === undefined ? [] : [hosted])],
    files: { tokenFile: config.claudeTokenFile },
    images: config.images,
    host,
    declared: config.capabilities,
    recorded: credentials.capabilities,
  });
  if ("refused" in advertised)
    throw new Error(
      `runner configuration ${paths.config}: capabilities: ${advertised.refused}`,
    );
  return advertised.capabilities;
}

/**
 * @param {RunnerConfig} config
 * @returns {Engine}
 */
export function runnerEngine(config) {
  return containerEngine(config.engine, engineCallTimeoutMs);
}

/** The scheme every local named pipe is named by as an endpoint. */
const localPipeScheme = "npipe:////./pipe/";

/** How `docker info` names a daemon that maps a job's uid onto another. */
const remappedDocker = { rootless: "rootless", userns: "with userns-remap" };

/**
 * Refuses rootless docker and userns-remap, because each maps a job's uid onto
 * one that cannot read the Claude token file, and any context but a local
 * named pipe, which Docker Desktop's is: a job mounts this machine's paths,
 * which a remote daemon would find on its own, and a pull of the pool's
 * registry is told the endpoint alone, without a context's certificates.
 *
 * @param {Engine} engine
 * @returns {Promise<string>} the endpoint docker's context names
 */
export async function engineEndpoint(engine) {
  const info = await engine.exec(dockerInfoArgv());
  if (info.code !== 0)
    throw new Error(
      `docker could not be asked, so Docker Desktop may not be running: ${engineFailureLine(info)}`,
    );
  const remapped = /\bname=(rootless|userns)\b/u.exec(info.stdout)?.[1];
  if (remapped !== undefined)
    throw new Error(
      `docker is running ${remappedDocker[remapped]}, where a job cannot read the Claude token file; use Docker Desktop as it comes`,
    );
  const context = await engine.exec(dockerContextArgv());
  if (context.code !== 0)
    throw new Error(
      `docker's context could not be read: ${engineFailureLine(context)}`,
    );
  const endpoint = context.stdout.trim();
  if (!endpoint.toLowerCase().startsWith(localPipeScheme))
    throw new Error(
      `docker's context names "${endpoint}", and only a local docker, reached by a named pipe as Docker Desktop's is, is supported`,
    );
  return endpoint;
}

/** What `docker info` is asked for the machine its containers run on. */
const machineInfoArgv = ["info", "--format", "{{.NCPU}} {{.MemTotal}}"];

/**
 * The CPU and memory of the machine the engine runs containers on, which is
 * Docker Desktop's VM and not this one.
 *
 * @param {Engine} engine
 * @returns {Promise<{cpuMillis: number, memoryMib: number}>}
 */
export async function engineMachine(engine) {
  const answer = await engine.exec(machineInfoArgv);
  if (answer.code !== 0)
    throw new Error(
      `docker could not say what its machine has: ${engineFailureLine(answer)}`,
    );
  const said = /^(\d+) (\d+)$/u.exec(answer.stdout.trim());
  const [cpus, bytes] = said === null ? [0, 0] : [said[1], said[2]].map(Number);
  if (!(cpus > 0 && bytes > 0))
    throw new Error(
      `docker answered "${answer.stdout.trim()}" when asked for its CPUs and memory`,
    );
  return {
    cpuMillis: cpus * 1000,
    memoryMib: Math.floor(bytes / (1024 * 1024)),
  };
}

/**
 * @param {RunnerSetup} setup
 * @param {{log: (line: string) => void, sharedRefusal: SharedRefusal, engine?: Engine, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch, places?: boolean, disk?: import("./diskFree.mjs").DiskFreePorts, spawn?: typeof spawn, arch?: string}} host where its log lines go, who besides this account may open a file, the engine and token source when not those the files name, the fetch a job's or a session's plane is reached by when not the global one, `places: false` for a run that places nothing, which then composes no host backend and advertises nothing: a job on this machine itself is stopped only through the service, what the free disk is measured by when not this machine's own, what starts a job on this machine itself when not `hostJobSpawned`, and this machine as `process.arch` names it when not this one
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const capabilities =
    host.places === false
      ? undefined
      : runnerCapabilities(setup, host.arch ?? process.arch);
  const runtimeDir = poolRuntimeDirectory(paths, credentials);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(engine);
  const machine = await engineMachine(engine);
  const engineSocket =
    host.places === false ? undefined : engineSocketHanded(setup.config);
  const tokens = host.tokens ?? poolRunnerTokens(credentials);
  const disk = host.disk ?? diskFreePorts;
  const container = containerBackend(
    {
      engine: config.engine,
      pool: credentials,
      tokenFile: config.claudeTokenFile,
      claudeCredential: runnerClaudeCredential,
      registryHost: credentials.registryHost,
      dockerHost,
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir,
      logDir: paths.logs,
      machine,
      pullRetryMs,
      images: config.images,
      ...(engineSocket === undefined ? {} : { engineSocket }),
      imageRecord: win32.join(paths.images, `${config.engine}.json`),
      imageUnusedSecsMax: config.imageUnusedSecsMax,
      diskFreeBytesMin: diskFloorBytes(config),
      memoryFreeBytesMin: memoryFreeBytes(config),
      memoryLock: runnerMemoryLock(paths),
    },
    {
      engine,
      tokens,
      nowMs: Date.now,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      log: host.log,
      tokenFileRefusal: (file) =>
        claudeTokenFileRefusal(file, host.sharedRefusal),
      diskFree: diskFreeLogged(
        () => engineDiskFree(config, paths, engine, disk),
        host.log,
      ),
    },
  );
  const backend =
    host.places === false
      ? container
      : runnerHostRouted(setup, container, host);
  const client = poolRunnerClient(
    credentials,
    backend,
    { concurrencyMax: config.concurrencyMax, sessionsMax: config.sessionsMax },
    { tokens, fetch: host.fetch, capabilities },
  );
  return { runtime: runtimeDir, engine, disk, backend, client };
}

/**
 * Docker Desktop's socket, as a job is handed it where the runner's file says
 * to, or nothing. The path is its VM's, which Docker Desktop mounts from
 * whatever context names it; the socket is root's group's, mode 660, so a
 * job is added to root's group. Every job then runs anything Docker Desktop
 * will, which is root on its VM and whatever it shares of this machine.
 *
 * @param {RunnerConfig} config
 * @returns {import("@chuggy/worker-core/engineArgv.mjs").EngineSocket | undefined}
 */
export function engineSocketHanded(config) {
  if (!config.engineSocket) return undefined;
  return { path: dockerDesktopSocket, gid: 0, rootGroup: true };
}

/** Where Docker Desktop's VM keeps its engine's socket. */
export const dockerDesktopSocket = "/var/run/docker.sock";

/** The platform each Windows `process.arch` names is, as `--host` declares it. */
const hostPlatforms = /** @type {Record<string, string>} */ ({
  x64: "Platform:Windows:Amd64",
  arm64: "Platform:Windows:Arm64",
});

/**
 * The platform a Windows machine of this architecture is, or nothing for one
 * no pool runs work on the host of.
 *
 * @param {string} arch as `process.arch` names one
 */
export function hostPlatform(arch) {
  return Object.hasOwn(hostPlatforms, arch) ? hostPlatforms[arch] : undefined;
}

/** The host jobs this process started and has not yet seen end, by pid. */
const hostJobsLive = new Map();

/**
 * Starts a host job's core on Windows. The core asks for a process of its own
 * group, which on Windows starts it on no console, where every program it
 * runs would open a window of its own; so it starts on a console of its own,
 * hidden, where the runner itself has none, and on the runner's where it
 * has one, as a `once` in a terminal does. Each is kept until it is seen to
 * end, so that only a job this process still holds is ever killed.
 *
 * @type {typeof spawn}
 */
export function hostJobSpawned(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: false,
    windowsHide: true,
  });
  if (child.pid !== undefined) {
    const pid = child.pid;
    hostJobsLive.set(pid, child);
    child.once("exit", () => hostJobsLive.delete(pid));
  }
  return child;
}

/** The cap on one taskkill, which guards a hung kill and not a slow one. */
const hostKillTimeoutMs = 30_000;

/** Windows' own taskkill, never one the working directory or `Path` could put first. */
const taskkill = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "taskkill.exe",
);

/**
 * Kills a host job's process and every process still under it, as `taskkill
 * /T` does, while this process holds the job: once it has ended its pid may be
 * another process's, and is left alone. Windows has no signal a console
 * program can be asked to stop by, so the core's polite request and its last
 * word are both a kill. A program started under the job whose parent has
 * already ended is no longer under it, and is not killed.
 *
 * @param {number} pid
 */
export function hostJobTreeKilled(pid) {
  const child = hostJobsLive.get(pid);
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  try {
    execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: hostKillTimeoutMs,
    });
  } catch {
    // Nothing of it was left to kill, or the kill did not answer in time.
  }
}

/**
 * The container backend, with this machine beside it where the pool was
 * registered with `--host`, taking each job that pins no image and names the
 * platform the pool declared it is. Its jobs are sized against this machine,
 * not Docker Desktop's VM, and are killed whole as this runner exits.
 *
 * @param {RunnerSetup} setup
 * @param {ContainerBackend} container
 * @param {{log: (line: string) => void, sharedRefusal: SharedRefusal, spawn?: typeof spawn}} host
 * @returns {ContainerBackend}
 */
function runnerHostRouted(setup, container, host) {
  const { credentials, config, paths } = setup;
  const platforms = hostPlatformsDeclared(credentials, "Windows");
  if (platforms.length === 0) return container;
  return hostRoutedBackend(
    container,
    hostBackend(
      {
        platforms,
        directory: win32.join(paths.jobs, poolIdentityDigest(credentials)),
        logDir: paths.logs,
        tokenFile: config.claudeTokenFile,
        claudeCredential: runnerClaudeCredential,
        timeoutSecsMax: config.timeoutSecsMax,
        outputBytesMax: config.outputBytesMax,
        environment: config.environment,
        machine: {
          cpuMillis: availableParallelism() * 1000,
          memoryMib: Math.floor(totalmem() / (1024 * 1024)),
        },
        platform: "win32",
      },
      {
        log: host.log,
        tokenFileRefusal: (file) =>
          claudeTokenFileRefusal(file, host.sharedRefusal),
        spawn: host.spawn ?? hostJobSpawned,
        kill: (pid) => hostJobTreeKilled(pid),
        atExit: (onExit) => process.once("exit", onExit),
      },
    ),
    platforms,
  );
}

/**
 * The job network, made when it is missing. Every pool's run on the machine
 * shares it, so a creation that failed is one another run may have beaten.
 *
 * @param {Engine} engine
 * @param {string} network
 * @returns {Promise<"Present" | "Created">}
 */
export async function jobNetwork(engine, network) {
  const inspected = await engine.exec(networkInspectArgv(network));
  if (inspected.code === 0) return "Present";
  if (engineFailure(inspected) !== "NotFound")
    throw new Error(
      `network ${network} could not be inspected: ${engineFailureLine(inspected)}`,
    );
  const created = await engine.exec(networkCreateArgv(network));
  if (created.code === 0) return "Created";
  if ((await engine.exec(networkInspectArgv(network))).code === 0)
    return "Present";
  throw new Error(
    `network ${network} could not be created: ${engineFailureLine(created)}`,
  );
}

/**
 * The pool loop until the plane denies the pool, which the service does not
 * restart.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void}} seams
 * @returns {Promise<number>} the exit status
 */
export async function runnerLoop(client, seams) {
  await poolRunnerLoop(client, seams);
  return deniedExitStatus;
}

/**
 * The directories a pool's run writes under, both within those
 * `runnerDirectoriesChecked` checked.
 *
 * @param {RunnerPaths} paths
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerDirectories(paths, runtime) {
  await mkdir(runtime, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
}

/**
 * Removes every pull credential and env file in a pool's runtime directory,
 * which only a run that no other run of the pool is beside may do: each is
 * one a killed run did not get to remove.
 *
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerLeftoversRemoved(runtime) {
  for (const entry of await readdir(runtime))
    if (/^(?:pull|job)-/u.test(entry))
      await rm(win32.join(runtime, entry), { recursive: true, force: true });
}

/**
 * Removes the pull credentials and env files this process made, and no other
 * process's, and its claim on the pool where it holds one.
 *
 * @param {string} runtime
 * @param {number} pid
 */
export function ownScratchRemoved(runtime, pid = process.pid) {
  const own = [runtimeScratch("pull", pid), runtimeScratch("job", pid)];
  try {
    for (const entry of readdirSync(runtime))
      if (own.some((prefix) => entry.startsWith(prefix)))
        try {
          rmSync(win32.join(runtime, entry), { recursive: true, force: true });
        } catch {
          // One still open elsewhere is the next run's to remove.
        }
  } finally {
    poolServiceReleasedNow(runtime, pid);
  }
}

/**
 * Has the end of this process remove its own scratch first: a Ctrl+C or
 * Ctrl+Break, its console closing, or, under the service, its input closing
 * or its output failing, which is how a
 * supervisor that ended is noticed, since Windows ends no process with its
 * parent. Its containers are left for the next run to pick up.
 *
 * @param {string} runtime
 * @param {{supervised: boolean, stdin: NodeJS.ReadableStream, exit: (status: number) => void, outputs?: NodeJS.WritableStream[]}} host its outputs being this process's own unless named
 */
export function scratchRemovedOnEnd(runtime, host) {
  let ending = false;
  const ended = () => {
    if (ending) return;
    ending = true;
    try {
      ownScratchRemoved(runtime);
    } finally {
      host.exit(1);
    }
  };
  // SIGHUP is a console window closing on a run started by hand in it,
  // which Windows gives a moment before it ends this process.
  for (const signal of ["SIGINT", "SIGBREAK", "SIGHUP"])
    process.once(signal, ended);
  if (host.supervised) {
    host.stdin.once("end", ended);
    host.stdin.once("error", ended);
    host.stdin.resume();
    // An output the service no longer reads fails the next line written to
    // it, which would otherwise end this process before it cleans up.
    for (const output of host.outputs ?? [process.stdout, process.stderr])
      output.on("error", ended);
  }
}
