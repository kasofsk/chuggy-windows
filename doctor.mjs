/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found, and before the engine whether the pool
 * file's task runs this copy. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 */

import { stat } from "node:fs/promises";
import { win32 } from "node:path";

import {
  hostEnvironmentRefusal,
  hostPlatformsDeclared,
  hostTimeoutSecsMax,
} from "@chuggy/worker-core/hostBackend.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import {
  listArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import {
  poolIdentityPersonal,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";
import {
  claudeTokenFileRefusal,
  runnerConfig,
  runnerConfigLimits,
} from "./runnerConfig.mjs";
import {
  dockerDesktopSocket,
  engineEndpoint,
  engineMachine,
  engineSocketHanded,
  runnerSecretDirectories,
} from "./runner.mjs";
import {
  commandLine,
  serviceEndArgv,
  serviceQueryArgv,
  serviceRunArgv,
  samePath,
  serviceTaskName,
  taskQueried,
  taskService,
} from "./serviceTask.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 * @typedef {import("./runnerConfig.mjs").SharedRefusal} SharedRefusal
 *
 * @typedef {{check: string, passed: boolean, detail: string, warning?: true}} DoctorFinding a warning passes, and is printed as one
 *
 * @typedef {object} DoctorParts what a run would reach, built from what was read
 * @property {(config: RunnerConfig) => Engine} engine
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["tokens"]} tokens
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["plane"]} plane
 *
 * @typedef {object} DoctorInput
 * @property {string} poolFile
 * @property {RunnerPaths} paths
 * @property {SharedRefusal} sharedRefusal who besides this account may open a file
 * @property {import("./taskScheduler.mjs").TaskScheduler} tasks how `schtasks` is run
 * @property {string} node the Node binary running this
 * @property {string} cli this CLI's entry, as an absolute path
 * @property {DoctorParts} parts
 */

/**
 * Runs one check: a probe answers what it found, or throws what is wrong.
 *
 * @template T
 * @param {DoctorFinding[]} findings
 * @param {string} check
 * @param {() => Promise<[T, string]>} probe
 * @returns {Promise<T | undefined>}
 */
async function checked(findings, check, probe) {
  try {
    const [value, detail] = await probe();
    findings.push({ check, passed: true, detail });
    return value;
  } catch (failure) {
    findings.push({ check, passed: false, detail: failureMessage(failure) });
    return undefined;
  }
}

/**
 * What a pool registered with `--host` runs on this machine, or a throw naming
 * what in the runner's file no host job can run under.
 *
 * @param {RunnerConfig} config
 */
function hostJobsChecked(config) {
  const refusal = hostEnvironmentRefusal(config.environment, "win32");
  if (refusal !== undefined) throw new Error(refusal);
  if (config.timeoutSecsMax > hostTimeoutSecsMax)
    throw new Error(
      `timeoutSecsMax is at most ${String(hostTimeoutSecsMax)} for a job on this machine itself`,
    );
  return "a job that pins no image and names this machine's platform runs on the machine itself, as this account, unisolated";
}

/**
 * The host jobs check: what a pool registered with `--host` runs here, warned
 * of where it declared no Windows platform, so that no job is ever run here.
 *
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @returns {DoctorFinding}
 */
function hostJobsFinding(credentials, config) {
  const check = "host jobs";
  let detail;
  try {
    detail = hostJobsChecked(config);
  } catch (failure) {
    return { check, passed: false, detail: failureMessage(failure) };
  }
  if (hostPlatformsDeclared(credentials, "Windows").length > 0)
    return { check, passed: true, detail };
  return {
    check,
    passed: true,
    warning: true,
    detail:
      "the pool file says host, but declares no Windows platform, so no job runs on this machine itself; register again with --host",
  };
}

/**
 * Whether each job is handed Docker Desktop's engine, warned of whenever it
 * is, since that hands every job far more than a container.
 *
 * @param {RunnerConfig} config
 * @returns {DoctorFinding}
 */
function engineSocketFinding(config) {
  const check = "engine socket";
  if (engineSocketHanded(config) === undefined)
    return { check, passed: true, detail: "off" };
  return {
    check,
    passed: true,
    warning: true,
    detail: `on: each job reaches Docker Desktop's engine at ${dockerDesktopSocket} in root's group, so every job, and its agent, can run anything Docker Desktop will: root on its VM, and whatever it shares of this machine, which by default is your user folder, its keys and this runner's tokens among it`,
  };
}

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {DoctorFinding[]} findings
 */
async function engineChecks(engine, credentials, config, findings) {
  const reachable = await checked(findings, "container engine", async () => {
    const endpoint = await engineEndpoint(engine);
    const machine = await engineMachine(engine);
    const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
    if (listed.code !== 0) throw new Error(engineFailureLine(listed));
    const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
    return [
      true,
      `docker at ${endpoint}, on ${String(machine.cpuMillis / 1000)} CPUs and ${String(machine.memoryMib)} MiB, lists ${String(count)} of this pool's containers`,
    ];
  });
  if (reachable === undefined) return;
  findings.push(engineSocketFinding(config));
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
}

/**
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {DoctorFinding[]} findings
 */
async function planeChecks(input, credentials, findings) {
  const token = await checked(findings, "pool token", async () => {
    const acquired = await input.parts.tokens(credentials).acquire();
    if (acquired.acquired !== "Token") throw new Error(acquired.evidence);
    return [acquired.token, `issued by ${credentials.tokenUrl}`];
  });
  if (token === undefined) return;
  await checked(findings, "plane", async () => {
    const polled = await input.parts.plane(credentials).poll(token, [], 0, 0);
    if (polled.polled === "Stale")
      throw new Error("the plane rejected a token the issuer had just issued");
    if (polled.polled !== "Reconciled") throw new Error(polled.evidence);
    return [true, `${credentials.planeUrl} answered a poll`];
  });
}

/**
 * Whether the pool file's own task runs this copy under this Node. One that
 * runs another is warned of with what makes it run this one, and so is one
 * serving another file, or whose command this runner cannot read back; none
 * yet passes.
 *
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding>}
 */
async function serviceTaskFinding(input) {
  const check = "service task";
  /** @param {string} detail */
  const warned = (detail) => ({ check, passed: true, warning: true, detail });
  let name;
  try {
    name = serviceTaskName(input.poolFile);
  } catch (failure) {
    return warned(failureMessage(failure));
  }
  const definition = taskQueried(await input.tasks(serviceQueryArgv(name)));
  if (definition === undefined)
    return { check, passed: true, detail: `none yet named ${name}` };
  const service = taskService(definition);
  if (service === undefined)
    return warned(
      `${name} runs a command this runner cannot read back, so which copy it runs is unknown`,
    );
  if (!samePath(service.poolFile, input.poolFile))
    return warned(`${name} serves ${service.poolFile}, not this pool file`);
  if (samePath(service.node, input.node) && samePath(service.cli, input.cli))
    return {
      check,
      passed: true,
      detail: `${name} runs this copy under this Node`,
    };
  const left = [
    [input.node, input.cli, "install-service", "--pool", input.poolFile],
    serviceEndArgv(name),
    serviceRunArgv(name),
  ].map(commandLine);
  return warned(
    `${name} runs ${service.cli} under ${service.node}, not this copy under this Node; to have it run this one: ${left.join("; ")}`,
  );
}

/**
 * The directory a path is made under: itself where it is there, or else the
 * nearest one above it that is, whose rules a directory made there inherits.
 *
 * @param {string} directory
 */
async function nearestMade(directory) {
  let path = directory;
  while ((await stat(path).catch(() => undefined)) === undefined) {
    const parent = win32.dirname(path);
    if (parent === path) return path;
    path = parent;
  }
  return path;
}

/**
 * Whether the directories the runner keeps secrets in are this account's
 * alone, as `run` refuses them otherwise. One not made yet is answered by the
 * nearest directory above it, whose rules it inherits when a run makes it.
 *
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding>}
 */
async function directoriesFinding(input) {
  const check = "runner directories";
  const directories = runnerSecretDirectories(input.paths, input.poolFile);
  for (const directory of directories) {
    const made = await nearestMade(directory);
    let shared;
    try {
      shared = await input.sharedRefusal(made);
    } catch (failure) {
      return { check, passed: false, detail: failureMessage(failure) };
    }
    if (shared !== undefined)
      return {
        check,
        passed: false,
        detail: `${made === directory ? directory : `${directory}, made under ${made}, which`} ${shared}; the runner keeps secrets there`,
      };
  }
  return {
    check,
    passed: true,
    detail: `${directories.join(", ")} are this account's alone, or are made where they will be`,
  };
}

/** @param {DoctorFinding} finding */
export function findingLine(finding) {
  const label =
    finding.warning === true ? "warn" : finding.passed ? "ok  " : "FAIL";
  return `${label}  ${finding.check}: ${finding.detail}`;
}

/**
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding[]>}
 */
export async function doctorFindings(input) {
  /** @type {DoctorFinding[]} */
  const findings = [];
  const credentials = await checked(findings, "pool file", async () => {
    const read = await poolCredentials(input.poolFile, (file) =>
      input.sharedRefusal(file),
    );
    return [
      read,
      `${input.poolFile} names ${poolIdentityPersonal(read) ? "personal runner" : "pool"} ${poolLabelValue(read)}`,
    ];
  });
  const config = await checked(findings, "runner configuration", async () => {
    const read = await runnerConfig(input.paths.config, input.sharedRefusal);
    return [read, `${input.paths.config}: ${runnerConfigLimits(read)}`];
  });
  findings.push(await directoriesFinding(input));
  if (config !== undefined)
    await checked(findings, "Claude token file", async () => {
      const refusal = await claudeTokenFileRefusal(
        config.claudeTokenFile,
        input.sharedRefusal,
      );
      if (refusal !== undefined) throw new Error(refusal);
      return [true, `${config.claudeTokenFile}, this account's own`];
    });
  if (credentials?.host === true && config !== undefined)
    findings.push(hostJobsFinding(credentials, config));
  findings.push(await serviceTaskFinding(input));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(
      input.parts.engine(config),
      credentials,
      config,
      findings,
    );
  await planeChecks(input, credentials, findings);
  return findings;
}
