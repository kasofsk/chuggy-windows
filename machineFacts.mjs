/**
 * What a runner report says of this machine, where the runner's file sets
 * `reportMetrics`: its CPUs and its physical memory as Windows counts them,
 * total and available, and, where the service holds a disk floor, that floor
 * and the space free under it, measured as the floor measures it. Windows
 * keeps no load average, which Node answers there as zeros, so a report
 * names none. A fact that cannot be read is left out, never estimated from
 * another.
 */

import { availableParallelism, freemem, totalmem } from "node:os";

import { diskFloorBytes } from "./diskFree.mjs";

/**
 * @typedef {import("@chuggy/worker-core/runnerReport.mjs").RunnerMachine} RunnerMachine
 * @typedef {import("@chuggy/worker-core/diskFloor.mjs").DiskFree} DiskFree
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {object} MachineFactPorts what this machine's CPUs and memory are read by
 * @property {() => number} cpus as `os.availableParallelism` answers
 * @property {() => number} memoryTotal as `os.totalmem` answers
 * @property {() => number} memoryAvailable as `os.freemem` answers, which on Windows is the physical memory available
 */

/** @type {MachineFactPorts} */
export const machineFactPorts = {
  cpus: availableParallelism,
  memoryTotal: totalmem,
  memoryAvailable: freemem,
};

/**
 * @param {number} bytes
 * @returns {number | undefined}
 */
function counted(bytes) {
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/**
 * The floor the runner's file keeps and the space free under it, or nothing
 * where it keeps none, as the service then measures none, or the space
 * cannot be measured.
 *
 * @param {RunnerConfig} config
 * @param {() => Promise<DiskFree>} diskFree
 * @returns {Promise<Pick<RunnerMachine, "diskFreeBytes" | "diskFloorBytes">>}
 */
async function diskFacts(config, diskFree) {
  if (config.diskFreeGibMin === 0) return {};
  const measured = await diskFree().catch(() => undefined);
  if (measured === undefined || "unknown" in measured) return {};
  return {
    diskFreeBytes: measured.free,
    diskFloorBytes: diskFloorBytes(config),
  };
}

/**
 * This machine's facts as a report reads them, each read as the report is
 * made.
 *
 * @param {RunnerConfig} config
 * @param {() => Promise<DiskFree>} diskFree the free disk, measured as the floor measures it
 * @param {MachineFactPorts} [ports]
 * @returns {() => Promise<RunnerMachine>}
 */
export function machineFacts(config, diskFree, ports = machineFactPorts) {
  return async () => {
    const total = counted(ports.memoryTotal());
    const available = counted(ports.memoryAvailable());
    return {
      cpus: ports.cpus(),
      ...(total === undefined ? {} : { memoryTotalBytes: total }),
      ...(available === undefined ? {} : { memoryAvailableBytes: available }),
      ...(await diskFacts(config, diskFree)),
    };
  };
}
