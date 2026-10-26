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

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
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
 * @typedef {{code: number, stdout: string, stderr: string}} WslAnswer what `wsl.exe` answered: its exit code, -1 where it did not end by itself or could not start, and each stream
 *
 * @typedef {object} DiskFreePorts what the free disk is measured by
 * @property {(path: string) => Promise<{bavail: number, bsize: number}>} statfs
 * @property {(argv: readonly string[]) => Promise<WslAnswer>} wsl runs `wsl.exe`
 *
 * @typedef {{free: number, where: string, drive: boolean}} DiskMeasured `drive` where it is the drive's, which compacting the disk image frees
 *
 * @typedef {DiskMeasured & {unmeasured: string[], driveMeasured: boolean} | {unknown: string}} DockerDiskFree what is free where it was measured, why each place it was not could not be, and whether the drive was
 */

/** What `docker info` names Docker Desktop's VM. */
export const dockerDesktopMachine = "docker-desktop";

/** The WSL distribution Docker Desktop's engine runs in. */
export const dockerDesktopDistribution = "docker-desktop";

/** Where Docker Desktop's VM mounts the disk its engine stores on. */
export const dockerDesktopDataMount = "/mnt/docker-desktop-disk";

/** The cap on one `wsl.exe`, which guards a hung WSL and not a slow one. */
const wslTimeoutMs = 20_000;

/** The cap on asking docker which machine it runs on, which guards a hung engine. */
const engineInfoTimeoutMs = 15_000;

/** Windows' own wsl.exe, never one the working directory or `Path` could put first. */
const wslExe = win32.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "wsl.exe",
);

/**
 * What a program printed, as UTF-16 where it wrote that, as `wsl.exe` writes
 * its own messages unless told `WSL_UTF8`, and otherwise as UTF-8, as a Linux
 * program writes.
 *
 * @param {Buffer} bytes
 */
export function wslText(bytes) {
  const wide = bytes.length >= 2 && bytes[1] === 0 && bytes[0] !== 0;
  return bytes.toString(wide ? "utf16le" : "utf8");
}

/**
 * `wsl.exe` run through `start`, with no input, no window and its own words
 * in UTF-8, each stream kept apart and killed past `wslTimeoutMs`.
 *
 * @param {typeof spawn} start
 * @returns {DiskFreePorts["wsl"]}
 */
export function wslRunner(start) {
  return (argv) =>
    new Promise((resolve) => {
      const child = start(wslExe, [...argv], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: wslTimeoutMs,
        env: { ...process.env, WSL_UTF8: "1" },
      });
      /** @type {Buffer[]} */
      const out = [];
      /** @type {Buffer[]} */
      const err = [];
      child.stdout?.on("data", (chunk) => out.push(chunk));
      child.stderr?.on("data", (chunk) => err.push(chunk));
      child.once("error", (error) =>
        resolve({ code: -1, stdout: "", stderr: error.message }),
      );
      child.once("close", (code) =>
        resolve({
          code: code ?? -1,
          stdout: wslText(Buffer.concat(out)),
          stderr: wslText(Buffer.concat(err)),
        }),
      );
    });
}

/** @type {DiskFreePorts} */
export const diskFreePorts = { statfs, wsl: wslRunner(spawn) };

/**
 * What is asked inside the VM: the blocks free to a user under its data
 * disk's mount, and their size, once it is known to be a mount, since an
 * empty directory left where Docker Desktop no longer mounts would measure
 * the VM's own root.
 */
export const vmDiskArgv = /** @type {const} */ ([
  "-d",
  dockerDesktopDistribution,
  "-e",
  "sh",
  "-c",
  'mountpoint -q "$1" || { echo "$1 is not a mount" >&2; exit 1; }; stat -f -c "%a %S" "$1"',
  "sh",
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
  const said = answer.stdout
    .split(/\r?\n/u)
    .map((line) => /^(\d+) (\d+)$/u.exec(line.trim()))
    .findLast((match) => match !== null);
  if (answer.code !== 0 || said === undefined) {
    const why = [answer.stderr, answer.stdout]
      .map((text) => text.trim().split(/\r?\n/u)[0])
      .find((line) => line !== "");
    return {
      unknown: `Docker Desktop's VM could not be measured at ${dockerDesktopDataMount}: ${why ?? `wsl.exe exited ${String(answer.code)}`}`,
    };
  }
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
  let info;
  try {
    info = await engine.exec(engineInfoArgv(), {
      signal: globalThis.AbortSignal.timeout(engineInfoTimeoutMs),
    });
  } catch {
    return {
      unknown: "docker did not say which machine it runs on in time",
    };
  }
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
  const measured = await Promise.all([
    driveFree(dockerDiskDirectory(config, paths), ports),
    vmFree(ports),
  ]);
  /** @type {string[]} */
  const unmeasured = [];
  /** @type {DiskMeasured | undefined} */
  let lowest;
  for (const one of measured)
    if ("unknown" in one) unmeasured.push(one.unknown);
    else if (lowest === undefined || one.free < lowest.free) lowest = one;
  if (lowest === undefined) return { unknown: unmeasured.join("; ") };
  return { ...lowest, unmeasured, driveMeasured: !("unknown" in measured[0]) };
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
  "; if the drive stays low once images are removed, the disk image needs compacting: quit Docker Desktop, wsl --shutdown, then diskpart's compact vdisk, or Optimize-VHD -Mode Full where Hyper-V is installed";

/**
 * The free disk against the runner's floor, as doctor and `status` say it,
 * whether it is one to warn of, unmeasured anywhere or under the floor, and
 * whether it fails: the drive unmeasured, since the drive is what fills, and
 * a floor held on the VM alone holds it against a disk far larger than the
 * drive may have room for.
 *
 * @param {RunnerConfig} config
 * @param {RunnerPaths} paths
 * @param {Engine} engine
 * @param {DiskFreePorts} ports
 * @returns {Promise<{detail: string, warning: boolean, failed: boolean}>}
 */
export async function diskFloorSaid(config, paths, engine, ports) {
  if (config.diskFreeGibMin === 0)
    return {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
      failed: false,
    };
  const measured = await engineDiskFree(config, paths, engine, ports);
  if ("unknown" in measured)
    return {
      detail: `none held, since the free disk could not be measured: ${measured.unknown}`,
      warning: true,
      failed: false,
    };
  const failed = !measured.driveMeasured;
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
      failed,
    };
  if (measured.free >= Math.floor(bytesMin / 2))
    return {
      detail: `${free}, under ${floor}: the service removes the images it may and takes no job until it is over${compact}${unmeasured}`,
      warning: true,
      failed,
    };
  return {
    detail: `${free}, under half ${floor}: the service removes the images it may, and stops a job each pass it is still under half${compact}${unmeasured}`,
    warning: true,
    failed,
  };
}

/**
 * A measurement that says in the log each time the places it could not
 * measure change, since the core says only whether the disk is over its
 * floor, and a floor held on one place of two is a weaker one. A call while
 * one is still being made shares it: the core gives up waiting on one it
 * cannot stop, and asks again each pass and before each removal.
 *
 * @param {() => Promise<DockerDiskFree>} measure
 * @param {(line: string) => void} log
 * @returns {() => Promise<DiskFree>}
 */
export function diskFreeLogged(measure, log) {
  let said = "";
  /** @type {Promise<DiskFree> | undefined} */
  let making;
  const measuredOnce = async () => {
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
  return () => {
    making ??= measuredOnce().finally(() => {
      making = undefined;
    });
    return making;
  };
}
