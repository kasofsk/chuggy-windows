/**
 * The `chuggy-windows` commands. Each answers an exit status: 0 done, 1
 * failed, 2 asked wrongly, and `deniedExitStatus` when the plane denied the
 * pool, which is the one failure the service does not start `run` again
 * after.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolIdentityChatHost,
  poolIdentityPersonal,
} from "@chuggy/worker-core/poolIdentity.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";
import {
  poolRunnerPassLine,
  poolRunnerPlane,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";

import { controlServer } from "@chuggy/worker-core/control.mjs";
import { chatHostControl } from "@chuggy/worker-core/chatHost.mjs";
import { chatServiceAsked } from "./chatDoctor.mjs";
import {
  chatRunnerLoop,
  chatRunnerParts,
  chatSupervisorLeftRemoved,
} from "./chatRunner.mjs";
import { diskFloorSaid, diskFreePorts } from "./diskFree.mjs";
import { memoryBudgetSaid } from "./memoryFree.mjs";
import { doctorFindings, findingLine } from "./doctor.mjs";
import {
  poolHeldCode,
  poolServiceAsked,
  poolServiceClaimed,
  poolServiceFound,
  poolServiceLeftoversRemoved,
} from "./poolService.mjs";
import {
  registerPoolDirectory,
  registerPoolFileWritten,
  registerRedeemed,
  registerRequest,
} from "@chuggy/worker-core/register.mjs";
import {
  jobNetwork,
  runnerDirectories,
  runnerDirectoriesChecked,
  poolRuntimeDirectory,
  runnerEngine,
  runnerLeftoversRemoved,
  runnerLoop,
  runnerParts,
  runnerSetup,
  hostPlatform,
  scratchRemovedOnEnd,
} from "./runner.mjs";
import {
  runnerChatSettingsLine,
  runnerConfigLimits,
  runnerPaths,
} from "./runnerConfig.mjs";
import {
  commandLine,
  deniedExitStatus,
  serviceCommands,
  serviceCreateArgv,
  serviceDeleteArgv,
  serviceEnableArgv,
  serviceEndArgv,
  serviceQueryArgv,
  serviceRunArgv,
  serviceTask,
  serviceTaskBaseCharsMax,
  serviceTaskFileBytes,
  serviceTaskName,
  samePath,
  taskPoolFile,
  taskQueried,
} from "./serviceTask.mjs";
import {
  inputEnded,
  supervisedChild,
  supervisedVariable,
  supervisor,
} from "./supervisor.mjs";

/**
 * @typedef {object} CliHost
 * @property {Readonly<Record<string, string | undefined>>} environment
 * @property {string} home
 * @property {string} hostname
 * @property {string} arch as `process.arch` names it
 * @property {typeof globalThis.fetch} fetch
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine] the engine a run and doctor reach, when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] the token source a run and doctor reach, when not the pool's issuer
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["plane"]} [plane] the plane doctor polls, when not the pool's
 * @property {import("./diskFree.mjs").DiskFreePorts} [disk] what a run, doctor and status measure the free disk by, when not this machine's own
 * @property {import("./taskScheduler.mjs").TaskScheduler} tasks how `schtasks` is run
 * @property {import("./runnerConfig.mjs").SharedRefusal} sharedRefusal who besides this account may open a file
 * @property {() => Promise<string>} userSid this account's SID
 * @property {import("./supervisor.mjs").SupervisorHost["start"]} [startRun] how the service starts `run`, when not as a child of this Node
 * @property {(ms: number) => Promise<void>} [sleep] how a wait is waited, when not on the clock
 * @property {() => number} [nowMs] the clock a wait is bounded by, when not the system's
 * @property {import("./poolService.mjs").PoolLocking} [locking] how a pool's lock is taken, when not as Windows holds one
 * @property {NodeJS.ReadableStream} stdin
 * @property {(status: number) => void} exit ends this process at once
 * @property {string} version this copy's, as its `package.json` names it
 * @property {string} node the Node binary running this
 * @property {string} nodeVersion that Node's, as `process.versions.node` says it
 * @property {string} cli this CLI's entry, as an absolute path
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 *
 * @typedef {{host: CliHost, poolFile: string, positionals: string[]}} CliCall
 */

/** The variable naming the pool file when `--pool` does not. */
export const poolFileVariable = "CHUGGY_WINDOWS_POOL";

const usage = `usage: chuggy-windows <command> [--pool <file>]
       chuggy-windows register --api <origin> --token=<token>
                               [--pool <name> | --personal | --chat]
                               [--host] [--capability <token>]...
       chuggy-windows --version

  register                redeem a registration token for a pool file, the
                          pool named for this machine unless --pool names it,
                          or with --personal a member's personal token for
                          their personal runner's file, or with --chat a
                          chat host's token for their chat host's file, and
                          start its service where it can; a pool or a
                          personal runner declares the platform its
                          containers run and each --capability, and with
                          --host runs a job that pins no image on this
                          machine itself
  run                     run the pool, or the chat host, until the plane
                          denies it
  service                 what the pool's task runs: run, started again
                          after it ends unless the plane denied the pool
  once                    one pass, then wait for what it placed to start;
                          not of a chat host
  status                  this pool's limits and containers, and what the
                          service is placing, or a chat host's settings and
                          supervisor
  stop <assignment>       stop one assignment's container; not of a chat host
  doctor                  check everything a run needs
  install-service         register the scheduled task that runs \`service\`

The pool file is --pool, or ${poolFileVariable}.`;

/**
 * @param {CliCall} call
 * @param {{places: boolean}} [run] whether the command places work, which alone needs the host backend
 */
async function started(call, run = { places: true }) {
  const setup = await runnerSetup(
    call.poolFile,
    call.host.environment,
    call.host.home,
    call.host.sharedRefusal,
  );
  await runnerDirectoriesChecked(
    setup.paths,
    call.poolFile,
    call.host.sharedRefusal,
  );
  const runner = await runnerParts(setup, {
    log: call.host.out,
    sharedRefusal: call.host.sharedRefusal,
    engine: call.host.engine,
    tokens: call.host.tokens,
    fetch: call.host.fetch,
    places: run.places,
    disk: call.host.disk,
    arch: call.host.arch,
  });
  const holder = await poolServiceFound(runner.runtime, call.host.locking);
  return { setup, runner, holder, pipe: holder?.pipe };
}

/**
 * The pool held for this process and its pipe listened on, until `work`
 * settles. A second run or pass of the pool is refused by the hold before it
 * can remove the first's scratch. Letting go, the hold is released before
 * the pipe is closed, so no one believes a pipe whose name is free.
 *
 * @template T
 * @param {CliHost} host
 * @param {string} runtime the pool's runtime directory
 * @param {import("./poolService.mjs").PoolServiceKind} kind
 * @param {import("@chuggy/worker-core/control.mjs").ControlBackend} backend what the pipe answers of
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
async function claimed(host, runtime, kind, backend, work) {
  const hold = await poolServiceClaimed(
    runtime,
    process.pid,
    kind,
    host.locking,
  );
  /** @type {import("node:net").Server | undefined} */
  let server;
  try {
    await poolServiceLeftoversRemoved(runtime, await readdir(runtime));
    server = await controlServer(hold.pipe, backend);
    return await work();
  } finally {
    await hold.release();
    server?.close();
  }
}

/**
 * The runner. It claims the pool before removing what a killed run left.
 *
 * @param {CliCall} call
 */
async function run(call) {
  const { setup, runner } = await started(call);
  await runnerDirectories(setup.paths, runner.runtime);
  return claimed(call.host, runner.runtime, "run", runner.backend, async () => {
    await runnerLeftoversRemoved(runner.runtime);
    scratchRemovedOnEnd(runner.runtime, {
      supervised: call.host.environment[supervisedVariable] === "1",
      stdin: call.host.stdin,
      exit: call.host.exit,
    });
    if ((await jobNetwork(runner.engine, setup.config.network)) === "Created")
      call.host.out(`made the job network ${setup.config.network}`);
    return runnerLoop(runner.client, {
      sleep: (ms) => delay(ms),
      log: call.host.out,
    });
  });
}

/**
 * The service the pool's task runs. Its log and its memory of a denial are
 * named for the task, so each pool's are its own.
 *
 * @param {CliCall} call
 */
async function service(call) {
  const { host, poolFile } = call;
  const paths = runnerPaths(host.environment, host.home);
  const base = win32.basename(serviceTaskName(poolFile));
  await runnerDirectoriesChecked(paths, poolFile, host.sharedRefusal);
  const serviceDirectory = win32.join(paths.runtime, "service");
  await mkdir(serviceDirectory, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  return supervisor({
    poolFile,
    logFile: win32.join(paths.logs, `service-${base}.log`),
    deniedFile: win32.join(serviceDirectory, `${base}.denied`),
    start:
      host.startRun ??
      (() =>
        supervisedChild({
          node: host.node,
          cli: host.cli,
          poolFile,
          environment: host.environment,
        })),
    sleep: (ms) => delay(ms),
    parentGone: inputEnded(host.stdin),
    now: () => new Date(),
  });
}

/**
 * One pass, the pool claimed as a run claims it, so it is refused while the
 * pool's service runs.
 *
 * @param {CliCall} call
 */
async function once(call) {
  const { setup, runner } = await started(call);
  await runnerDirectories(setup.paths, runner.runtime);
  try {
    return await claimed(
      call.host,
      runner.runtime,
      "once",
      runner.backend,
      async () => {
        await runnerLeftoversRemoved(runner.runtime);
        scratchRemovedOnEnd(runner.runtime, {
          supervised: false,
          stdin: call.host.stdin,
          exit: call.host.exit,
        });
        await jobNetwork(runner.engine, setup.config.network);
        const pass = await workerPoolClientPass(runner.client);
        await runner.backend.settled();
        if (pass.passed === "Reconciled") {
          call.host.out(poolRunnerPassLine(pass));
          return 0;
        }
        call.host.err(`${pass.passed}: ${pass.evidence}`);
        return pass.passed === "Denied" ? deniedExitStatus : 1;
      },
    );
  } catch (failure) {
    if (/** @type {{code?: unknown}} */ (failure)?.code !== poolHeldCode)
      throw failure;
    call.host.err(
      `${failureMessage(failure)}; stop it before a pass of your own`,
    );
    return 1;
  }
}

/**
 * The kind a status line names.
 *
 * @param {{kind?: string}} workload
 */
function statusKind(workload) {
  return workload.kind === "Session" ? "session" : "job";
}

/** @param {CliCall} call */
async function status(call) {
  const { setup, runner, holder, pipe } = await started(call, {
    places: false,
  });
  const containers = await runner.backend.containers();
  /** @type {string | undefined} */
  let unasked;
  const answered =
    /** @type {{inFlight?: import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await poolServiceAsked(pipe, { op: "status" }).catch((failure) => {
        unasked = failureMessage(failure);
        return undefined;
      })
    );
  call.host.out(
    unasked !== undefined
      ? `service: holds the pool, but could not be asked: ${unasked}`
      : answered === undefined
        ? "service: not running"
        : holder?.kind === "once"
          ? `service: not running; a pass holds the pool as process ${String(holder.pid)}`
          : "service: running",
  );
  call.host.out(`limits: ${runnerConfigLimits(setup.config)}`);
  const disk = await diskFloorSaid(
    setup.config,
    setup.paths,
    runner.engine,
    runner.disk,
  );
  call.host.out(`disk floor: ${disk.detail}`);
  call.host.out(
    `memory: ${await memoryBudgetSaid(setup.config, runner.engine)}`,
  );
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${statusKind(placement)}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}${placement.waiting === undefined ? "" : `  waiting: ${placement.waiting}`}`,
    );
  for (const container of containers)
    call.host.out(
      `${container.name}  ${statusKind(container)}  ${container.status}  deadline ${container.deadlineEpochSecs === undefined ? "none" : new Date(container.deadlineEpochSecs * 1000).toISOString()}  ${container.assignment ?? "no assignment"}`,
    );
  return 0;
}

/** @param {CliCall} call */
async function stop(call) {
  const [assignment] = call.positionals;
  if (assignment === undefined || call.positionals.length !== 1) {
    call.host.err(usage);
    return 2;
  }
  const { runner, pipe } = await started(call, { places: false });
  // A service that cannot be asked is stopped past, as one not running is.
  const asked = await poolServiceAsked(pipe, { op: "stop", assignment }).catch(
    () => undefined,
  );
  const answered =
    /** @type {{stopped?: string, evidence?: string, refused?: string} | undefined} */ (
      asked ?? (await runner.backend.stop(assignment))
    );
  if (answered.stopped === "Stopped") {
    call.host.out(`stopped ${assignment}`);
    return 0;
  }
  call.host.err(answered.evidence ?? answered.refused ?? "not stopped");
  return 1;
}

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * doctor's findings for a pool file, reaching the engine, issuer and plane
 * the host names, or else those the files do.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 */
function doctorFound(host, poolFile) {
  return doctorFindings({
    poolFile,
    paths: runnerPaths(host.environment, host.home),
    sharedRefusal: host.sharedRefusal,
    tasks: host.tasks,
    node: host.node,
    cli: host.cli,
    disk: host.disk ?? diskFreePorts,
    arch: host.arch,
    locking: host.locking,
    parts: {
      engine: (config) => host.engine ?? runnerEngine(config),
      tokens: (credentials) => host.tokens ?? poolRunnerTokens(credentials),
      plane: (credentials) => host.plane ?? poolRunnerPlane(credentials),
    },
  });
}

/**
 * Whether a finding is one to read: a failure, or a pass with a warning.
 *
 * @param {import("./doctor.mjs").DoctorFinding} finding
 */
function doctorAside(finding) {
  return !finding.passed || finding.warning === true;
}

/**
 * Which copy is speaking, under which Node, and then each check.
 *
 * @param {CliCall} call
 */
async function doctor(call) {
  const { host } = call;
  host.out(
    `chuggy-windows ${host.version} at ${host.cli}, under Node ${host.nodeVersion} at ${host.node}`,
  );
  const findings = await doctorFound(host, call.poolFile);
  for (const finding of findings)
    (doctorAside(finding) ? host.err : host.out)(findingLine(finding));
  return findings.every((finding) => finding.passed) ? 0 : 1;
}

/**
 * A failed command and the first line it printed on stderr, or its exit
 * status where it printed none.
 *
 * @param {readonly string[]} argv
 * @param {import("./taskScheduler.mjs").TaskSchedulerAnswer} answer
 */
function taskFailureLine(argv, answer) {
  const [said] = answer.stderr.trim().split(/\r?\n/u);
  return `${commandLine(argv)}: ${said === "" ? `exited ${String(answer.code)}` : said}`;
}

/**
 * Registers the pool file's own task, refusing one of its name that serves
 * another file, and answers its name. The definition reaches `schtasks`
 * through a file of its own, removed once read.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 */
async function installServiceTask(host, poolFile) {
  await poolCredentials(poolFile, (file) => host.sharedRefusal(file));
  const paths = runnerPaths(host.environment, host.home);
  await runnerDirectoriesChecked(paths, poolFile, host.sharedRefusal);
  const name = serviceTaskName(poolFile);
  const existing = taskQueried(await host.tasks(serviceQueryArgv(name)));
  const served = existing === undefined ? undefined : taskPoolFile(existing);
  if (
    existing !== undefined &&
    (served === undefined || !samePath(served, poolFile))
  )
    throw new Error(
      `the task ${name} serves ${served ?? "no pool file this runner named"}, not ${poolFile}; delete that task if it is stale, or rename the pool file`,
    );
  const definition = serviceTask(
    { node: host.node, cli: host.cli, poolFile },
    await host.userSid(),
  );
  await mkdir(paths.runtime, { recursive: true });
  const file = win32.join(
    paths.runtime,
    `task-${win32.basename(name)}-${String(process.pid)}.xml`,
  );
  try {
    await writeFile(file, serviceTaskFileBytes(definition));
    const argv = serviceCreateArgv(name, file);
    const created = await host.tasks(argv);
    if (created.code !== 0)
      throw new Error(
        existing === undefined
          ? taskFailureLine(argv, created)
          : `${taskFailureLine(argv, created)}; a task registered from an elevated PowerShell can be replaced only from one, so run this there, or delete the task there with ${commandLine(serviceDeleteArgv(name))} and run this again`,
      );
  } finally {
    await rm(file, { force: true });
  }
  return name;
}

/**
 * Registers the pool file's own task and prints how to start it now; it
 * starts by itself at the next logon.
 *
 * @param {CliCall} call
 */
async function installService(call) {
  const name = await installServiceTask(call.host, call.poolFile);
  call.host.out(
    `registered the task ${name}, which starts at each logon; start it now with:`,
  );
  for (const command of serviceCommands(name)) call.host.out(`  ${command}`);
  return 0;
}

/**
 * @typedef {object} RegisterServed what became of the written file's service
 * @property {string} said what the first line says of the service
 * @property {readonly string[]} why what failed, and what a check warned of
 * @property {readonly string[]} left the commands left to the operator, from the first not done
 */

/**
 * @param {string} since
 * @param {readonly string[]} why
 * @param {readonly string[]} left
 * @returns {RegisterServed}
 */
function registerUnserved(since, why, left) {
  return {
    said: `its service is not running, since ${since}; next:`,
    why,
    left,
  };
}

/**
 * What is left of a file's service from doctor's checks on: the checks, then
 * the task install-service registers, which prints what starts it.
 *
 * @param {string} file
 */
function registerUnchecked(file) {
  return ["doctor", "install-service"].map((command) =>
    commandLine(["chuggy-windows", command, "--pool", file]),
  );
}

/**
 * Runs each command in turn. Where one fails, the service is not running, and
 * what is left is that command on.
 *
 * @param {CliHost} host
 * @param {readonly (readonly string[])[]} argvs
 * @param {string} said what the first line says once every command ran
 * @param {(argv: readonly string[]) => string} since why the service is not running where `argv` failed
 * @param {readonly string[]} why what a check warned of
 * @returns {Promise<RegisterServed>}
 */
async function registerRan(host, argvs, said, since, why) {
  for (const [index, argv] of argvs.entries()) {
    const answer = await host.tasks(argv);
    if (answer.code !== 0)
      return registerUnserved(
        since(argv),
        [...why, taskFailureLine(argv, answer)],
        argvs.slice(index).map(commandLine),
      );
  }
  return { said, why, left: [] };
}

/** The longest `register` waits for an ended service to let its pipe go. */
const serviceEndWaitMs = 30_000;

/** How often it asks whether the pipe is still answered. */
const serviceEndLookMs = 500;

/**
 * Waits until the pool file's service is gone, as an ended task's service and
 * run are a moment after the task ends, or until `serviceEndWaitMs` has
 * passed. Whether it went is answered; what kept it from being asked is
 * thrown.
 *
 * @param {CliHost} host
 * @param {string} file
 */
async function serviceEnded(host, file) {
  const credentials = await poolCredentials(file, (path) =>
    host.sharedRefusal(path),
  );
  const paths = runnerPaths(host.environment, host.home);
  await runnerDirectoriesChecked(paths, file, host.sharedRefusal);
  const runtime = poolRuntimeDirectory(paths, credentials);
  const sleep = host.sleep ?? ((ms) => delay(ms));
  const nowMs = host.nowMs ?? Date.now;
  const deadline = nowMs() + serviceEndWaitMs;
  for (;;) {
    const holder = await poolServiceFound(runtime, host.locking);
    if (holder === undefined) return true;
    if (nowMs() >= deadline) return false;
    await sleep(serviceEndLookMs);
  }
}

/**
 * Starts the pool file's service again, since chuggy denies the registration
 * it ran on: its task registered again as install-service registers it, so
 * what comes back is this copy under this Node, then enabled, ended and run
 * once the ended service has let its pipe go. Ending a task that is not
 * running fails, and is not a failure here.
 *
 * @param {CliHost} host
 * @param {string} file
 * @param {string} whose
 * @param {string} name the task
 * @returns {Promise<RegisterServed>}
 */
async function registerRestarted(host, file, whose, name) {
  /** @param {string} what */
  const since = (what) =>
    `chuggy denies ${whose} earlier registration and ${what}`;
  try {
    await installServiceTask(host, file);
  } catch (failure) {
    return registerUnserved(
      since("its task could not be registered"),
      [failureMessage(failure)],
      [
        ...registerUnchecked(file).slice(1),
        ...[serviceEndArgv(name), serviceRunArgv(name)].map(commandLine),
      ],
    );
  }
  await host.tasks(serviceEndArgv(name));
  // The task is run again whatever the wait came to, and why it fell short
  // is said.
  const waited = await serviceEnded(host, file).then(
    (ended) =>
      ended
        ? []
        : [
            `the ended service still held the pool after ${String(serviceEndWaitMs / 1000)}s; the new one starts its run once it lets go`,
          ],
    (failure) => [
      `whether the ended service let go could not be asked: ${failureMessage(failure)}`,
    ],
  );
  return registerRan(
    host,
    [serviceEnableArgv(name), serviceRunArgv(name)],
    `its service is running: restarted ${name}`,
    (argv) => since(`${commandLine(argv)} failed`),
    waited,
  );
}

/**
 * Starts the service of a file no task here serves yet: doctor's checks, then
 * its task as install-service registers it, then run.
 *
 * @param {CliHost} host
 * @param {string} file
 * @param {string} written what register says it did with the file
 * @returns {Promise<RegisterServed>}
 */
async function registerStarted(host, file, written) {
  host.err(
    `${written}, and the token is spent; checking this machine before starting its service`,
  );
  const findings = await doctorFound(host, file);
  const why = findings.filter(doctorAside).map(findingLine);
  if (!findings.every((finding) => finding.passed))
    return registerUnserved("a check failed", why, registerUnchecked(file));
  let name;
  try {
    name = await installServiceTask(host, file);
  } catch (failure) {
    return registerUnserved(
      "its task could not be registered",
      [...why, failureMessage(failure)],
      registerUnchecked(file).slice(1),
    );
  }
  return registerRan(
    host,
    [serviceRunArgv(name)],
    `its service is running: started ${name}`,
    (argv) => `${commandLine(argv)} failed`,
    why,
  );
}

/**
 * The written file's service: its task registered again and restarted where
 * the file's own task here already serves it, since chuggy denies the
 * registration it ran on, and started otherwise. What fails is said rather
 * than thrown, since the token is spent.
 *
 * @param {CliHost} host
 * @param {import("@chuggy/worker-core/register.mjs").RegisteredPool} pool
 * @param {string} file
 * @param {string} written what register says it did with the file
 * @returns {Promise<RegisterServed>}
 */
async function registerServed(host, pool, file, written) {
  try {
    const name = serviceTaskName(file);
    const definition = taskQueried(await host.tasks(serviceQueryArgv(name)));
    const served =
      definition === undefined ? undefined : taskPoolFile(definition);
    if (served === undefined || !samePath(served, file))
      return await registerStarted(host, file, written);
    return await registerRestarted(
      host,
      file,
      poolIdentityPersonal(pool)
        ? "this personal runner's"
        : poolIdentityChatHost(pool)
          ? "the chat host's"
          : "the pool's",
      name,
    );
  } catch (failure) {
    return registerUnserved(
      "it could not be started",
      [failureMessage(failure)],
      registerUnchecked(file),
    );
  }
}

/**
 * Redeems a registration token, writes the pool file it answers, and leaves
 * the file's service running where it can. It takes no pool file: its
 * `--pool` is the name the pool takes, `--personal` redeems a member's
 * personal token, which names no pool, and `--chat` a member's chat host's,
 * which declares nothing. `--host` declares this machine's own platform
 * beside its containers'. Once the file is written it exits 0
 * whatever became of the service, since a rerun would spend another token.
 *
 * @param {CliHost} host
 * @param {Omit<import("@chuggy/worker-core/register.mjs").RegisterAsked, "capabilities"> & {capability?: string[] | undefined}} asked each `--capability` once per token
 */
async function register(host, { capability, ...named }) {
  const asked = { ...named, capabilities: capability };
  const platform = hostPlatform(host.arch);
  if (asked.host === true && platform === undefined) {
    host.err(
      `this machine is ${host.arch}, and no pool runs work on the host of one`,
    );
    return 2;
  }
  const requested = registerRequest(asked, {
    hostname: host.hostname,
    arch: host.arch,
    ...(asked.host === true
      ? { hosted: [/** @type {string} */ (platform)] }
      : {}),
  });
  if ("refused" in requested) {
    host.err(requested.refused);
    return 2;
  }
  const { pools } = runnerPaths(host.environment, host.home);
  await registerPoolDirectory(pools);
  const shared = await host.sharedRefusal(pools);
  if (shared !== undefined) {
    host.err(
      `the directory ${pools} ${shared}; the pool file's secret would be written there, so no token was spent`,
    );
    return 1;
  }
  const pool = await registerRedeemed(requested.request, host.fetch);
  const { file, replaced } = await registerPoolFileWritten(
    pools,
    pool,
    serviceTaskBaseCharsMax,
  ).catch((/** @type {unknown} */ failure) => {
    throw new Error(
      `the pool file could not be written, and the token is spent, so mint another: ${failureMessage(failure)}`,
      { cause: failure },
    );
  });
  const written = `${replaced ? "replaced" : "wrote"} ${file}`;
  const served = await registerServed(host, pool, file, written);
  host.out(`${written}; ${served.said}`);
  for (const line of served.why) host.err(line);
  for (const command of served.left) host.out(`  ${command}`);
  return 0;
}

/**
 * A chat host's run: the host claimed as a pool's run claims its pool, so a
 * second is refused before it removes the first's scratch, and its pipe
 * answering what the host says of itself, then the host until the plane
 * denies it.
 *
 * @param {CliCall} call
 */
async function chatRun(call) {
  const { host, poolFile } = call;
  const setup = await runnerSetup(
    poolFile,
    host.environment,
    host.home,
    host.sharedRefusal,
  );
  await runnerDirectoriesChecked(setup.paths, poolFile, host.sharedRefusal);
  const { chat, engine, runtime } = await chatRunnerParts(setup, {
    log: host.out,
    sharedRefusal: host.sharedRefusal,
    engine: host.engine,
    tokens: host.tokens,
    fetch: host.fetch,
  });
  await runnerDirectories(setup.paths, runtime);
  return claimed(host, runtime, "run", chatHostControl(chat), async () => {
    await runnerLeftoversRemoved(runtime);
    scratchRemovedOnEnd(runtime, {
      supervised: host.environment[supervisedVariable] === "1",
      stdin: host.stdin,
      exit: host.exit,
    });
    if ((await jobNetwork(engine, setup.config.network)) === "Created")
      host.out(`made the job network ${setup.config.network}`);
    await chatSupervisorLeftRemoved(
      engine,
      /** @type {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} */ (
        setup.credentials
      ),
      host.out,
    );
    return chatRunnerLoop(chat);
  });
}

/**
 * A chat host's settings, and what the service holding it says of its
 * supervisor.
 *
 * @param {CliCall} call
 */
async function chatStatus(call) {
  const { host, poolFile } = call;
  const setup = await runnerSetup(
    poolFile,
    host.environment,
    host.home,
    host.sharedRefusal,
  );
  await runnerDirectoriesChecked(setup.paths, poolFile, host.sharedRefusal);
  const service = await chatServiceAsked(
    poolRuntimeDirectory(setup.paths, setup.credentials),
    host.locking,
  );
  host.out(
    "unreadable" in service
      ? `service: holds the chat host, but could not be asked: ${service.unreadable}`
      : "status" in service
        ? "service: running"
        : "service: not running",
  );
  host.out(`chat: ${runnerChatSettingsLine(setup.config)}`);
  if (!("status" in service)) return 0;
  const { supervisor, starting, used, named } = service.status;
  host.out(
    `supervisor: ${supervisor.toLowerCase()}${starting ? ", starting" : ""}`,
  );
  host.out(
    `image: running ${used ?? "none yet"}; chuggy names ${named ?? "none yet"}`,
  );
  return 0;
}

/**
 * A pool's command, refused of a chat host.
 *
 * @param {string} why
 */
function chatRefused(why) {
  /** @param {CliCall} call */
  return async (call) => {
    call.host.err(why);
    return 2;
  };
}

/** Each command of a chat host's file. */
const chatCommands = {
  run: chatRun,
  service,
  once: chatRefused(
    "a chat host runs only as its service; start it with chuggy-windows run, which its task runs",
  ),
  status: chatStatus,
  stop: chatRefused("a chat host's sessions are stopped in chuggy"),
  doctor,
  "install-service": installService,
};

/**
 * Whether the pool file is a member's chat host's, and not where it cannot
 * be read or anyone else may open it, which the pool's command then says.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 */
async function poolFileChatHost(host, poolFile) {
  try {
    return poolIdentityChatHost(
      await poolCredentials(poolFile, (file) => host.sharedRefusal(file)),
    );
  } catch {
    return false;
  }
}

const commands = {
  run,
  service,
  once,
  status,
  stop,
  doctor,
  "install-service": installService,
};

/**
 * @param {readonly string[]} argv the arguments after the entry
 * @param {CliHost} host
 * @returns {Promise<number>} the exit status
 */
export async function cliMain(argv, host) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        pool: { type: "string" },
        api: { type: "string" },
        token: { type: "string" },
        personal: { type: "boolean" },
        chat: { type: "boolean" },
        host: { type: "boolean" },
        capability: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (failure) {
    host.err(`${/** @type {Error} */ (failure).message}\n${usage}`);
    return 2;
  }
  const { values } = parsed;
  const [name, ...positionals] = parsed.positionals;
  if (values.help === true || name === "help") {
    host.out(usage);
    return 0;
  }
  if (values.version === true) {
    host.out(`chuggy-windows ${host.version}`);
    return 0;
  }
  const registering = name === "register";
  const command = Object.hasOwn(commands, name ?? "")
    ? commands[name]
    : undefined;
  if (
    (!registering &&
      (command === undefined ||
        values.api !== undefined ||
        values.token !== undefined ||
        values.personal !== undefined ||
        values.chat !== undefined ||
        values.host !== undefined ||
        values.capability !== undefined)) ||
    (name !== "stop" && positionals.length > 0)
  ) {
    host.err(usage);
    return 2;
  }
  const poolFile = values.pool ?? host.environment[poolFileVariable];
  if (!registering && (poolFile === undefined || poolFile === "")) {
    host.err(
      `no pool file: name one with --pool or ${poolFileVariable}\n${usage}`,
    );
    return 2;
  }
  try {
    if (registering) return await register(host, values);
    const resolved = win32.resolve(/** @type {string} */ (poolFile));
    const chosen = (await poolFileChatHost(host, resolved))
      ? chatCommands[/** @type {keyof typeof chatCommands} */ (name)]
      : command;
    return await chosen({ host, poolFile: resolved, positionals });
  } catch (failure) {
    host.err(failureMessage(failure));
    return 1;
  }
}
