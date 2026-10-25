/**
 * The bytes free for what Docker Desktop's engine holds, which the runner
 * measures itself, since the engine answers for its VM's disk: the lower of
 * the drive holding the VM's disk image, which grows into that drive, and the
 * VM's own filesystem under it, which Docker Desktop's disk size caps. One
 * that cannot be measured is left out and said, and with neither the free
 * disk is unknown. An engine that is not Docker Desktop's stores what it holds
 * somewhere this runner cannot measure, and its free disk is unknown.
 *
 * THE DISK IMAGE MAY NOT SHRINK. What is removed in the VM frees room inside
 * the image, which Docker Desktop returns to the drive only where the image
 * is sparse; otherwise the drive stays as low until the image is compacted.
 */

import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { win32 } from "node:path";

import { z } from "zod";

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { engineInfoArgv } from "@chuggy/worker-core/engineArgv.mjs";
import { engineFailureLine } from "@chuggy/worker-core/engineErrors.mjs";

/**
 * @typedef {import("@chuggy/worker-core/diskFloor.mjs").DiskFree} DiskFree
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {{code: number, stdout: string}} WslAnswer what `wsl.exe` answered: its exit code, -1 where it did not end by itself, and its output
 *
 * @typedef {object} DiskFreePorts what the free disk is measured by
 * @property {(path: string) => Promise<{bavail: number, bsize: number}>} statfs
 * @property {(argv: readonly string[]) => Promise<WslAnswer>} wsl runs `wsl.exe`
 *
 * @typedef {{free: number, where: string, drive: boolean}} DiskMeasured `drive` where it is the drive's, which compacting the disk image frees
 *
 * @typedef {DiskMeasured & {unmeasured: string[]} | {unknown: string}} DockerDiskFree what is free where it was measured, and why each place it was not could not be
 */

/** What `docker info` names Docker Desktop's VM. */
export const dockerDesktopMachine = "docker-desktop";

/** The WSL distribution Docker Desktop's engine runs in. */
export const dockerDesktopDistribution = "docker-desktop";

/** Where Docker Desktop's VM mounts the disk its engine stores on. */
export const dockerDesktopDataMount = "/mnt/docker-desktop-disk";

/** The cap on one `wsl.exe`, which guards a hung WSL and not a slow one. */
const wslTimeoutMs = 20_000;

/** Windows' own wsl.exe, never one the working directory or `Path` could put first. */
const wslExe = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "wsl.exe",
);

/**
 * What a program printed, as UTF-16 where it wrote that, as `wsl.exe` writes
 * its own messages, and otherwise as UTF-8, as a Linux program writes.
 *
 * @param {Buffer} bytes
 */
export function wslText(bytes) {
  const wide = bytes.length >= 2 && bytes[1] === 0 && bytes[0] !== 0;
  return bytes.toString(wide ? "utf16le" : "utf8");
}

/** @type {DiskFreePorts["wsl"]} */
function wslRun(argv) {
  return new Promise((resolve) => {
    execFile(
      wslExe,
      argv,
      { windowsHide: true, timeout: wslTimeoutMs, encoding: "buffer" },
      (error, stdout, stderr) => {
        const output = `${wslText(stdout)}${wslText(stderr)}`;
        if (error === null) resolve({ code: 0, stdout: output });
        else
          resolve({
            code: typeof error.code === "number" ? error.code : -1,
            stdout: output || error.message,
          });
      },
    );
  });
}

/** @type {DiskFreePorts} */
export const diskFreePorts = { statfs, wsl: wslRun };

/** What `stat -f` is asked inside the VM: the blocks free to a user, and their size. */
export const vmDiskArgv = /** @type {const} */ ([
  "-d",
  dockerDesktopDistribution,
  "-e",
  "stat",
  "-f",
  "-c",
  "%a %S",
  dockerDesktopDataMount,
]);

const dockerInfoSchema = z.object({ Name: z.string() });

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The directory holding Docker Desktop's disk image: the runner's file's, or
 * Docker Desktop's own default.
 *
 * @param {RunnerConfig} config
 * @param {RunnerPaths} paths
 */
export function dockerDiskDirectory(config, paths) {
  return config.dockerDiskDirectory ?? paths.dockerDisk;
}

/**
 * @param {string} directory
 * @param {DiskFreePorts} ports
 * @returns {Promise<DiskMeasured | {unknown: string}>}
 */
async function driveFree(directory, ports) {
  try {
    const found = await ports.statfs(directory);
    return {
      free: found.bavail * found.bsize,
      where: `${win32.parse(directory).root}, holding Docker Desktop's disk image`,
      drive: true,
    };
  } catch (failure) {
    return {
      unknown: `the drive holding Docker Desktop's disk image could not be measured at ${directory}: ${failureMessage(failure)}`,
    };
  }
}

/**
 * @param {DiskFreePorts} ports
 * @returns {Promise<DiskMeasured | {unknown: string}>}
 */
async function vmFree(ports) {
  const answer = await ports.wsl(vmDiskArgv);
  const said = /^(\d+) (\d+)$/u.exec(answer.stdout.trim());
  if (answer.code !== 0 || said === null)
    return {
      unknown: `Docker Desktop's VM could not be measured at ${dockerDesktopDataMount}: ${answer.stdout.trim().split(/\r?\n/u)[0] || `wsl.exe exited ${String(answer.code)}`}`,
    };
  return {
    free: Number(said[1]) * Number(said[2]),
    where: `${dockerDesktopDataMount} in Docker Desktop's VM`,
    drive: false,
  };
}

/**
 * @param {RunnerConfig} config
 * @param {RunnerPaths} paths
 * @param {Engine} engine
 * @param {DiskFreePorts} ports
 * @returns {Promise<DockerDiskFree>}
 */
export async function engineDiskFree(config, paths, engine, ports) {
  const info = await engine.exec(engineInfoArgv());
  if (info.code !== 0)
    return {
      unknown: `docker could not be asked which machine it runs on: ${engineFailureLine(info)}`,
    };
  let parsed;
  try {
    parsed = dockerInfoSchema.safeParse(JSON.parse(info.stdout));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success)
    return { unknown: "docker answered an info this runner cannot read" };
  if (parsed.data.Name !== dockerDesktopMachine)
    return {
      unknown: `docker names its machine ${parsed.data.Name}, not Docker Desktop's VM, so this runner cannot measure where it stores what it holds`,
    };
  const measured = [
    await driveFree(dockerDiskDirectory(config, paths), ports),
    await vmFree(ports),
  ];
  /** @type {string[]} */
  const unmeasured = [];
  /** @type {DiskMeasured | undefined} */
  let lowest;
  for (const one of measured)
    if ("unknown" in one) unmeasured.push(one.unknown);
    else if (lowest === undefined || one.free < lowest.free) lowest = one;
  if (lowest === undefined) return { unknown: unmeasured.join("; ") };
  return { ...lowest, unmeasured };
}

/**
 * What the core is handed of a measurement: the lowest measured, or why
 * nothing could be.
 *
 * @param {DockerDiskFree} measured
 * @returns {DiskFree}
 */
export function diskFreeHanded(measured) {
  return "unknown" in measured
    ? measured
    : { free: measured.free, where: measured.where };
}

/**
 * The floor the runner's file sets, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function diskFloorBytes(config) {
  return config.diskFreeGibMin * 2 ** 30;
}

/** What frees the drive where the disk image does not shrink by itself. */
const compactLine =
  "; if the drive stays low once images are removed, the disk image needs compacting: wsl --shutdown, then Optimize-VHD -Mode Full or diskpart's compact vdisk";

/**
 * The free disk against the runner's floor, as doctor and `status` say it,
 * and whether it is one to warn of: unmeasured anywhere, or under the floor.
 *
 * @param {RunnerConfig} config
 * @param {RunnerPaths} paths
 * @param {Engine} engine
 * @param {DiskFreePorts} ports
 * @returns {Promise<{detail: string, warning: boolean}>}
 */
export async function diskFloorSaid(config, paths, engine, ports) {
  if (config.diskFreeGibMin === 0)
    return {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
    };
  const measured = await engineDiskFree(config, paths, engine, ports);
  if ("unknown" in measured)
    return {
      detail: `none held, since the free disk could not be measured: ${measured.unknown}`,
      warning: true,
    };
  const bytesMin = diskFloorBytes(config);
  const free = `${diskGib(measured.free)} GiB free at ${measured.where}`;
  const floor = `the floor of ${String(config.diskFreeGibMin)} GiB`;
  const unmeasured = measured.unmeasured
    .map((why) => `; only that, since ${why}`)
    .join("");
  const compact = measured.drive ? compactLine : "";
  if (measured.free >= bytesMin)
    return {
      detail: `${free}, over ${floor}${unmeasured}`,
      warning: unmeasured !== "",
    };
  if (measured.free >= Math.floor(bytesMin / 2))
    return {
      detail: `${free}, under ${floor}: the service removes the images it may and takes no job until it is over${compact}${unmeasured}`,
      warning: true,
    };
  return {
    detail: `${free}, under half ${floor}: the service removes the images it may, and stops a job each pass it is still under half${compact}${unmeasured}`,
    warning: true,
  };
}

/**
 * A measurement that says in the log each time the places it could not
 * measure change, since the core says only whether the disk is over its
 * floor, and a floor held on one place of two is a weaker one.
 *
 * @param {() => Promise<DockerDiskFree>} measure
 * @param {(line: string) => void} log
 * @returns {() => Promise<DiskFree>}
 */
export function diskFreeLogged(measure, log) {
  let said = "";
  return async () => {
    const measured = await measure();
    if ("unknown" in measured) return measured;
    const unmeasured = measured.unmeasured.join("; ");
    if (unmeasured !== said) {
      said = unmeasured;
      log(
        unmeasured === ""
          ? "this runner measures its free disk everywhere it looks again"
          : `this runner measures its free disk only at ${measured.where}, since ${unmeasured}`,
      );
    }
    return diskFreeHanded(measured);
  };
}
