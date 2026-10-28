/**
 * The runner's own file and where on this machine the runner keeps what it
 * writes. The file is refused unless only its owner can read or write it, and
 * is read strictly, so a misspelt key is an error rather than a default. The
 * pool's credentials are the worker core's to read.
 *
 * Every path is a Windows path, built with `path.win32`, so the suites hold
 * them on any machine.
 */

import { open, stat } from "node:fs/promises";
import { win32 } from "node:path";

import { z } from "zod";

import {
  ownerImagesSchema,
  ownerVolumesSchema,
} from "@chuggy/worker-core/containerBackend.mjs";
import { ownerVolumeDirectory } from "@chuggy/worker-core/engineArgv.mjs";
import { imageUnusedSecsMaxDefault } from "@chuggy/worker-core/imageCleanup.mjs";
import { registerDeclaredSchema } from "@chuggy/worker-core/register.mjs";
import {
  jobEngineSocketEnvironment,
  reservedJobVariables,
} from "@chuggy/worker-core/job.mjs";

/**
 * @typedef {z.infer<typeof runnerConfigSchema>} RunnerConfig
 *
 * @typedef {object} RunnerPaths
 * @property {string} config
 * @property {string} pools where `register` writes a pool file
 * @property {string} logs where an ended job's logs and each service's own log are saved
 * @property {string} jobs where a job run on this machine itself has its directory
 * @property {string} runtime where each pool's pull credentials and env files live
 * @property {string} images where the record of this machine's images is kept, one file per engine
 * @property {string} dockerDisk where Docker Desktop keeps its VM's disk image unless the runner's file moves it
 *
 * @typedef {(file: string) => Promise<string | undefined>} SharedRefusal why someone besides this account may open `file`, said after its name, or nothing
 */

/** Far above what a runner's file holds, so a file past it is not one. */
const runnerConfigBytesMax = 64 * 1024;

const positiveSchema = z.number().int().positive().safe();

const nonnegativeSchema = z.number().int().nonnegative().safe();

/** The most GiB kept free whose bytes are still a safe integer. */
const freeGibMax = Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30);

/**
 * Whether a bind mount's `source=` can name this absolute path: one with no
 * comma, which would end it, and no line break.
 *
 * @param {string} path
 */
export function bindMountNameable(path) {
  return !/[,\r\n]/u.test(path);
}

/** A name docker gives a network, less the host's own. */
const networkSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  .refine((network) => network !== "host", {
    error: "may not be the host's network",
  });

const environmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z.string().regex(/^[^\r\n]*$/u, { error: "may not break a line" }),
  )
  .superRefine((environment, context) => {
    for (const name of reservedJobVariables)
      if (Object.hasOwn(environment, name))
        context.addIssue({
          code: "custom",
          path: [name],
          message: "is the runner's to set",
        });
  });

export const runnerConfigSchema = z
  .strictObject({
    /** Docker Desktop's: podman on Windows is only ever a remote client. */
    engine: z
      .literal("docker", { error: "must be docker, Docker Desktop's engine" })
      .default("docker"),
    concurrencyMax: positiveSchema.default(1),
    /** The sessions held beside the jobs, none where it is 0. */
    sessionsMax: z.number().int().nonnegative().safe().default(2),
    /** Where `claude setup-token`'s output was saved, named in a bind mount. */
    claudeTokenFile: z
      .string()
      .refine((file) => win32.isAbsolute(file), {
        error: "must be an absolute path",
      })
      .refine((file) => bindMountNameable(file), {
        error: "cannot be named in a bind mount",
      }),
    timeoutSecsMax: positiveSchema,
    outputBytesMax: positiveSchema,
    environment: environmentSchema.default({}),
    network: networkSchema.default("chuggy-jobs"),
    /**
     * Whether each job is handed Docker Desktop's engine through its socket;
     * while it is, the variables that tell the job of it are the runner's.
     */
    engineSocket: z.boolean().default(false),
    /**
     * The images a job that pins none runs in, each with the capabilities its
     * owner declares it meets: the first meeting every one the job names.
     */
    images: ownerImagesSchema.default([]),
    /**
     * The named volumes of Docker Desktop mounted into every job, each field
     * but `scope` named as `--mount` names it. One whose `scope` is "project"
     * is one per project. A directory of this machine is refused: its path
     * is Windows', which a job's mount would need Docker Desktop to share and
     * translate, and who may write it is its access rules, not a job's uid.
     */
    volumes: ownerVolumesSchema
      .superRefine((volumes, context) => {
        volumes.forEach(({ source }, index) => {
          if (ownerVolumeDirectory(source) || win32.isAbsolute(source))
            context.addIssue({
              code: "custom",
              path: [index, "source"],
              message:
                "is a directory of this machine, and a Windows runner mounts only named volumes",
            });
        });
      })
      .default([]),
    /**
     * What this machine meets beside its platforms and the agents the file
     * can run, which each pool's service advertises in place of what
     * `--capability` declared when its pool was registered.
     */
    capabilities: registerDeclaredSchema.optional(),
    /**
     * How long a job's image this runner pulled may go unused before it is
     * removed, 0 keeping them until the disk is under `diskFreeGibMin`.
     */
    imageUnusedSecsMax: nonnegativeSchema.default(imageUnusedSecsMaxDefault),
    /**
     * The GiB kept free for what Docker Desktop holds: under it the service
     * removes the images it may and takes no job, and under half of it stops
     * one. None is kept where it is 0.
     */
    diskFreeGibMin: nonnegativeSchema.max(freeGibMax).default(20),
    /**
     * The GiB of Docker Desktop's VM's memory its containers leave free, a
     * reserve for what the engine and the VM use outside every container.
     * The rest is the budget every running container and every held job is
     * counted against: a job is held from its claim until it has room, and
     * is taken only where it fits. None is kept unless the file sets it, so
     * the whole of the VM's memory is the budget.
     */
    memoryFreeGibMin: nonnegativeSchema.max(freeGibMax).default(0),
    /**
     * The GiB of the budget no job may ask for, kept for what always runs
     * beside the jobs. The rest is the ceiling: a job asking more is refused,
     * and a plane that claims by room offers none. A session may ask the
     * whole budget. None is reserved where it is 0.
     */
    memoryReservedGib: nonnegativeSchema.max(freeGibMax).default(0),
    /**
     * The directory holding Docker Desktop's disk image, `docker_data.vhdx`,
     * where its settings moved it; the drive it is on is measured.
     */
    dockerDiskDirectory: z
      .string()
      .refine((directory) => win32.isAbsolute(directory), {
        error: "must be an absolute path",
      })
      .optional(),
  })
  .superRefine((config, context) => {
    if (!config.engineSocket) return;
    for (const name of Object.keys(jobEngineSocketEnvironment("docker", "")))
      if (Object.hasOwn(config.environment, name))
        context.addIssue({
          code: "custom",
          path: ["environment", name],
          message: "is the runner's to set while engineSocket is true",
        });
  });

/**
 * The kind of Claude credential `claudeTokenFile` is, which every workload is
 * told, so that the core withholds what would choose another.
 *
 * @type {import("@chuggy/worker-core/claudeCredential.mjs").ClaudeCredentialSetting}
 */
export const runnerClaudeCredential = { kind: "Subscription" };

/**
 * How many jobs and sessions each pool's service holds at once, in the file's
 * own terms.
 *
 * @param {RunnerConfig} config
 */
export function runnerConfigLimits(config) {
  return `concurrencyMax ${String(config.concurrencyMax)}, sessionsMax ${String(config.sessionsMax)}`;
}

/**
 * A known folder from the environment, or its default under the profile
 * where the variable is unset or not absolute.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} variable
 * @param {string} fallback
 */
function knownFolder(environment, variable, fallback) {
  const value = environment[variable];
  return value !== undefined && win32.isAbsolute(value) ? value : fallback;
}

/**
 * Where the runner reads and writes: what it is configured by and what
 * registering writes under the roaming application data, what it makes as it
 * runs under the local.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @returns {RunnerPaths}
 */
export function runnerPaths(environment, home) {
  const roaming = knownFolder(
    environment,
    "APPDATA",
    win32.join(home, "AppData", "Roaming"),
  );
  const local = knownFolder(
    environment,
    "LOCALAPPDATA",
    win32.join(home, "AppData", "Local"),
  );
  return {
    config: win32.join(roaming, "chuggy-windows", "runner.json"),
    pools: win32.join(roaming, "chuggy", "pools"),
    logs: win32.join(local, "chuggy-windows", "logs"),
    jobs: win32.join(local, "chuggy-windows", "jobs"),
    runtime: win32.join(local, "chuggy-windows", "run"),
    images: win32.join(local, "chuggy-windows", "images"),
    dockerDisk: win32.join(local, "Docker", "wsl", "disk"),
  };
}

/**
 * The runner's file, checked and read through one handle so the file checked
 * is the file read; who may open it is asked of its path.
 *
 * @param {string} file
 * @param {SharedRefusal} sharedRefusal
 * @returns {Promise<RunnerConfig>}
 */
export async function runnerConfig(file, sharedRefusal) {
  const handle = await open(file, "r");
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`runner configuration ${file} is not a file`);
    const shared = await sharedRefusal(file);
    if (shared !== undefined)
      throw new Error(`runner configuration ${file} ${shared}`);
    if (stats.size > runnerConfigBytesMax)
      throw new Error(`runner configuration ${file} is larger than one`);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let document;
  try {
    document = JSON.parse(text.replace(/^\ufeff/u, ""));
  } catch {
    throw new Error(`runner configuration ${file} is not JSON`);
  }
  const parsed = runnerConfigSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `runner configuration ${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

/**
 * Why this runner cannot hand its jobs the Claude token file, or nothing. The
 * file is its owner's alone; Docker Desktop shows a file it mounts to every
 * user in the container, so the job's user reads it. Only the file's metadata
 * and access rules are read: the token reaches the job by mount and never
 * this process.
 *
 * @param {string} file
 * @param {SharedRefusal} sharedRefusal
 * @returns {Promise<string | undefined>}
 */
export async function claudeTokenFileRefusal(file, sharedRefusal) {
  let stats;
  try {
    stats = await stat(file);
  } catch {
    return `the Claude token file ${file} cannot be found; save \`claude setup-token\`'s output there`;
  }
  if (!stats.isFile()) return `the Claude token file ${file} is not a file`;
  if (stats.size === 0) return `the Claude token file ${file} is empty`;
  const shared = await sharedRefusal(file);
  if (shared !== undefined) return `the Claude token file ${file} ${shared}`;
  return undefined;
}
