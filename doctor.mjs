/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found, and before the engine whether the pool
 * file's task runs this copy. Of a pool it changes nothing: a missing
 * network is reported for a run to make, and its one poll names nothing
 * held, wants nothing and advertises nothing, which the plane answers
 * without granting or releasing a lease or changing what the pool
 * advertised. Of a member's chat host it checks what `chatDoctor.mjs` says,
 * and makes one change: the image its supervisor runs is pulled where it is
 * not here, as the host's run would pull it before starting.
 */

import { readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";

import { z } from "zod";

import {
  hostEnvironmentRefusal,
  hostPlatformsDeclared,
  hostTimeoutSecsMax,
} from "@chuggy/worker-core/hostBackend.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import {
  ownerVolumeLabelsRefusal,
  ownerVolumeProjectsLine,
  ownerVolumesServed,
} from "@chuggy/worker-core/containerBackend.mjs";
import {
  listArgv,
  networkInspectArgv,
  volumeInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import {
  poolIdentityChatHost,
  poolIdentityPersonal,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";
import {
  chatCredentialDirectoryFinding,
  chatImageFinding,
  chatServiceAsked,
  chatSettingsFinding,
  chatSupervisorFinding,
} from "./chatDoctor.mjs";
import { diskFloorSaid } from "./diskFree.mjs";
import {
  credentialFileRefusal,
  runnerChatSettingsLine,
  runnerCodexAgent,
  runnerCredentialDescribed,
  runnerConfig,
  runnerConfigLimits,
} from "./runnerConfig.mjs";
import {
  dockerDesktopSocket,
  engineEndpoint,
  engineMachine,
  engineSocketHanded,
  poolRuntimeDirectory,
  runnerCapabilities,
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
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
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
 * @property {import("./diskFree.mjs").DiskFreePorts} disk what the free disk is measured by
 * @property {string} arch this machine, as `process.arch` names it
 * @property {import("./poolService.mjs").PoolLocking} [locking] how a pool's lock is taken, when not as Windows holds one
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

/** What docker answers an inspection of volumes with, of each one's labels. */
const inspectedVolumeLabelsSchema = z.array(
  z.object({ Labels: z.record(z.string(), z.string()).nullish() }),
);

/**
 * What a job is given of one of its owner's named volumes, or a throw naming
 * why it cannot be given it: there and labelled as the one listed, or for
 * the first job to make.
 *
 * @param {Engine} engine
 * @param {import("@chuggy/worker-core/engineArgv.mjs").OwnerVolume} volume
 */
async function ownerVolumeFound(engine, volume) {
  const { source, target, readonly, project } = volume;
  const mounted = `${source} at ${target}${readonly ? ", read-only" : ""}${project === undefined ? "" : `, ${project}'s alone`}`;
  const inspected = await engine.exec(volumeInspectArgv([source]));
  if (inspected.code === 0) {
    let labels;
    try {
      const [found] = inspectedVolumeLabelsSchema.parse(
        JSON.parse(inspected.stdout),
      );
      labels = found?.Labels ?? {};
    } catch {
      throw new Error(
        `docker answered an inspection of ${source} doctor cannot read`,
      );
    }
    const refusal = ownerVolumeLabelsRefusal(volume, labels);
    if (refusal !== undefined) throw new Error(`${source} ${refusal}`);
    return `${mounted}, present`;
  }
  if (engineFailure(inspected) === "NoSuchVolume")
    return `${mounted}, missing until the first job started through chuggy's runtime makes it`;
  throw new Error(`${source}: ${engineFailureLine(inspected)}`);
}

/**
 * What each job is given of its owner's volumes. On a personal runner one
 * scoped per project is each job's own project's, so it is named as such and
 * not looked for: the runner serves its member across projects, and doctor
 * holds no job's project to look under.
 *
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @returns {Promise<DoctorFinding>}
 */
async function ownerVolumesFinding(engine, credentials, config) {
  const check = "volumes";
  const { served, withheld } = ownerVolumesServed(config.volumes, credentials);
  const scoped = withheld.map(ownerVolumeProjectsLine);
  /** @type {string[]} */
  const found = [];
  try {
    for (const volume of served)
      found.push(await ownerVolumeFound(engine, volume));
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: [failureMessage(failure), ...scoped].join("; "),
    };
  }
  found.push(...scoped);
  return {
    check,
    passed: true,
    detail: found.length === 0 ? "none" : found.join("; "),
  };
}

/**
 * The free disk against the floor the runner's file sets, warned of where
 * any place could not be measured or it is under the floor, and failed where
 * the drive could not be.
 *
 * @param {Engine} engine
 * @param {RunnerConfig} config
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding>}
 */
async function diskFloorFinding(engine, config, input) {
  const check = "disk floor";
  const { detail, warning, failed } = await diskFloorSaid(
    config,
    input.paths,
    engine,
    input.disk,
  );
  if (failed)
    return {
      check,
      passed: false,
      detail: `${detail}; set dockerDiskDirectory to the directory holding docker_data.vhdx`,
    };
  return warning
    ? { check, passed: true, warning: true, detail }
    : { check, passed: true, detail };
}

/**
 * Whether the network every container here joins is present, or a run makes
 * it.
 *
 * @param {Engine} engine
 * @param {RunnerConfig} config
 * @param {DoctorFinding[]} findings
 */
async function jobNetworkChecked(engine, config, findings) {
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
}

/**
 * How many of a pool's containers the engine lists.
 *
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 */
async function containersCounted(engine, credentials) {
  const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
  if (listed.code !== 0) throw new Error(engineFailureLine(listed));
  return listed.stdout.split("\n").filter((id) => id.trim()).length;
}

/**
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {DoctorInput} input
 * @param {DoctorFinding[]} findings
 */
async function engineChecks(engine, credentials, config, input, findings) {
  const reachable = await checked(findings, "container engine", async () => {
    const endpoint = await engineEndpoint(engine);
    const machine = await engineMachine(engine);
    const count = await containersCounted(engine, credentials);
    return [
      true,
      `docker at ${endpoint}, on ${String(machine.cpuMillis / 1000)} CPUs and ${String(machine.memoryMib)} MiB, lists ${String(count)} of this pool's containers`,
    ];
  });
  if (reachable === undefined) return;
  findings.push(engineSocketFinding(config));
  await jobNetworkChecked(engine, config, findings);
  findings.push(await ownerVolumesFinding(engine, credentials, config));
  findings.push(await diskFloorFinding(engine, config, input));
}

/**
 * The pool's token, then one poll of its plane, answering the session image
 * the plane names, where it names one.
 *
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {DoctorFinding[]} findings
 * @returns {Promise<{chatImage: string | undefined} | undefined>} where the plane answered
 */
async function planeChecks(input, credentials, findings) {
  const token = await checked(findings, "pool token", async () => {
    const acquired = await input.parts.tokens(credentials).acquire();
    if (acquired.acquired !== "Token") throw new Error(acquired.evidence);
    return [acquired.token, `issued by ${credentials.tokenUrl}`];
  });
  if (token === undefined) return undefined;
  return checked(findings, "plane", async () => {
    const polled = await input.parts.plane(credentials).poll(token, [], 0, 0);
    if (polled.polled === "Stale")
      throw new Error("the plane rejected a token the issuer had just issued");
    if (polled.polled !== "Reconciled") throw new Error(polled.evidence);
    return [
      { chatImage: polled.chatImage },
      `${credentials.planeUrl} answered a poll`,
    ];
  });
}

/**
 * Docker Desktop as a chat host's supervisor is run by, and what it checks
 * there: the host's containers, the network, and a supervisor's container no
 * service here runs.
 *
 * @param {Engine} engine
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @param {DoctorInput} input
 * @param {DoctorFinding[]} findings
 * @returns {Promise<string | undefined>} the endpoint, where the engine answered
 */
async function chatEngineChecks(engine, identity, config, input, findings) {
  const endpoint = await checked(findings, "container engine", async () => {
    const reached = await engineEndpoint(engine);
    const count = await containersCounted(engine, identity);
    return [
      reached,
      `docker at ${reached} lists ${String(count)} of this chat host's containers`,
    ];
  });
  if (endpoint === undefined) return undefined;
  await jobNetworkChecked(engine, config, findings);
  findings.push(
    await chatSupervisorFinding(engine, identity, () =>
      chatServiceAsked(
        poolRuntimeDirectory(input.paths, identity),
        input.locking,
      ),
    ),
  );
  return endpoint;
}

/**
 * What a member's chat host needs beyond its file, the runner's file, the
 * runner's directories and the Claude token file: the token file alone in
 * its directory, its settings, the task as a pool's, Docker Desktop, the
 * plane, and the image its supervisor runs, which is checked once the plane
 * named one or the host sets its own, and pulled only into directories
 * this account alone may open.
 *
 * @param {DoctorInput} input
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig | undefined} config
 * @param {boolean} secret whether the runner's directories are this account's alone
 * @param {DoctorFinding[]} findings
 */
async function chatHostChecks(input, identity, config, secret, findings) {
  if (config !== undefined) {
    findings.push(await chatCredentialDirectoryFinding(config));
    findings.push(chatSettingsFinding(identity, config));
  }
  findings.push(await serviceTaskFinding(input));
  const engine = config === undefined ? undefined : input.parts.engine(config);
  const endpoint =
    engine === undefined || config === undefined
      ? undefined
      : await chatEngineChecks(engine, identity, config, input, findings);
  const polled = await planeChecks(input, identity, findings);
  if (
    engine === undefined ||
    config === undefined ||
    endpoint === undefined ||
    !secret ||
    (polled === undefined && config.chat?.image === undefined)
  )
    return findings;
  findings.push(
    await chatImageFinding(
      {
        engine,
        site: {
          engine: config.engine,
          runtimeDir: poolRuntimeDirectory(input.paths, identity),
          dockerHost: endpoint,
        },
        credentials: identity,
        tokens: input.parts.tokens(identity),
      },
      config.chat,
      polled?.chatImage,
    ),
  );
  return findings;
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

/**
 * What this pool's run advertises on each poll, as a run finds it when it
 * starts, and where what is neither a platform nor an agent comes from; or,
 * where it cannot be found, why a run would be refused.
 *
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @returns {DoctorFinding}
 */
function capabilitiesFinding(input, credentials, config) {
  const check = "capabilities";
  let advertised;
  try {
    advertised = runnerCapabilities(
      { credentials, config, paths: input.paths },
      input.arch,
    );
  } catch (failure) {
    return { check, passed: false, detail: failureMessage(failure) };
  }
  const rest =
    config.capabilities === undefined
      ? "the rest of what the pool was registered with"
      : "its capabilities";
  return {
    check,
    passed: true,
    detail: `a run advertises ${advertised.join(", ")} on each poll: the platforms it runs, the agents ${input.paths.config} can run, and ${rest}`,
  };
}

/** What a job requiring Codex names, which brings it the Codex credential. */
const codexCapability = `Agent:${runnerCodexAgent}`;

/**
 * Why the Codex auth file is not one Codex reads, or nothing: as only doctor
 * reads it, as a JSON object, never naming what it holds or what a parser
 * said of it.
 *
 * @param {string} file
 */
async function codexAuthRefusal(file) {
  const { label, remedy } = runnerCredentialDescribed(runnerCodexAgent);
  let document;
  try {
    document = JSON.parse(
      (await readFile(file, "utf8")).replace(/^\ufeff/u, ""),
    );
  } catch {
    document = undefined;
  }
  return typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
    ? undefined
    : `the ${label} ${file} is not a JSON object; ${remedy}`;
}

/**
 * The Codex credential the runner's file names, held to the rule a run holds
 * it to and then read as a JSON object, and whether this pool advertises
 * `Agent:Codex`, which is what brings a job its file; or nothing where the
 * file names none and this pool advertises no Codex.
 *
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @returns {Promise<DoctorFinding | undefined>}
 */
async function codexCredentialFinding(input, credentials, config) {
  const check = "Codex credential";
  let advertised = /** @type {string[]} */ ([]);
  try {
    advertised = runnerCapabilities(
      { credentials, config, paths: input.paths },
      input.arch,
    );
  } catch {
    // The capabilities check says why; this one judges the file alone.
  }
  const codex = advertised.includes(codexCapability);
  if (config.codexCredential === undefined)
    return codex
      ? {
          check,
          passed: true,
          warning: true,
          detail: `this pool advertises ${codexCapability} and ${input.paths.config} names no codexCredential, so its Codex jobs are handed the Claude token file; add codexCredential to hand them a Codex auth.json`,
        }
      : undefined;
  const file = config.codexCredential.authFile;
  const refusal =
    (await credentialFileRefusal(
      file,
      input.sharedRefusal,
      runnerCodexAgent,
    )) ?? (await codexAuthRefusal(file));
  if (refusal !== undefined) return { check, passed: false, detail: refusal };
  const detail = `the Codex auth file ${file}, this account's own`;
  return codex
    ? { check, passed: true, detail }
    : {
        check,
        passed: true,
        warning: true,
        detail: `${detail}; this pool does not advertise ${codexCapability}, since no images entry declares it and it was not registered with --host, so no job requiring ${codexCapability} reaches it`,
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
      `${input.poolFile} names ${poolIdentityChatHost(read) ? "chat host" : poolIdentityPersonal(read) ? "personal runner" : "pool"} ${poolLabelValue(read)}`,
    ];
  });
  const chat = credentials !== undefined && poolIdentityChatHost(credentials);
  const config = await checked(findings, "runner configuration", async () => {
    const read = await runnerConfig(input.paths.config, input.sharedRefusal);
    return [
      read,
      `${input.paths.config}: ${chat ? runnerChatSettingsLine(read) : runnerConfigLimits(read)}`,
    ];
  });
  const directories = await directoriesFinding(input);
  findings.push(directories);
  if (config !== undefined)
    await checked(findings, "Claude token file", async () => {
      const refusal = await credentialFileRefusal(
        config.claudeTokenFile,
        input.sharedRefusal,
      );
      if (refusal !== undefined) throw new Error(refusal);
      return [true, `${config.claudeTokenFile}, this account's own`];
    });
  if (chat)
    return chatHostChecks(
      input,
      credentials,
      config,
      directories.passed,
      findings,
    );
  if (credentials !== undefined && config !== undefined) {
    const codex = await codexCredentialFinding(input, credentials, config);
    if (codex !== undefined) findings.push(codex);
  }
  if (credentials?.host === true && config !== undefined)
    findings.push(hostJobsFinding(credentials, config));
  findings.push(await serviceTaskFinding(input));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    findings.push(capabilitiesFinding(input, credentials, config));
  if (config !== undefined)
    await engineChecks(
      input.parts.engine(config),
      credentials,
      config,
      input,
      findings,
    );
  await planeChecks(input, credentials, findings);
  return findings;
}
