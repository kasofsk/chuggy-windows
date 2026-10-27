/**
 * The memory budget a run keeps of Docker Desktop's VM, which the worker
 * core's `memoryBudget.mjs` holds: the VM's memory, as docker's `info` says
 * it, less `memoryFreeGibMin`, and what `status` says of it.
 */

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { fileLockHolderAlive } from "@chuggy/worker-core/fileLock.mjs";
import {
  memoryBudgetBytes,
  memoryBudgetState,
  memoryCountMsMax,
  memoryCounted,
  memoryRoomBytes,
} from "@chuggy/worker-core/memoryBudget.mjs";

/**
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 */

/**
 * What the runner's file keeps free of the VM's memory, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function memoryFreeBytes(config) {
  return config.memoryFreeGibMin * 2 ** 30;
}

/**
 * The VM's memory against the runner's budget, as `status` says it: the
 * room, the budget and the budget's state, or why it could not be counted;
 * and where docker refused to say what its containers use, that what no
 * runner capped was counted at none.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {(pid: number) => boolean} [holderAlive]
 */
export async function memoryBudgetSaid(
  config,
  engine,
  holderAlive = fileLockHolderAlive,
) {
  const { counted } = await memoryCounted({
    engine,
    name: config.engine,
    holderAlive,
    nowMs: Date.now,
    signal: globalThis.AbortSignal.timeout(memoryCountMsMax),
  });
  if ("unknown" in counted) return `Unknown · ${counted.unknown}`;
  const bytesFree = memoryFreeBytes(config);
  return [
    `${diskGib(Math.max(0, memoryRoomBytes(bytesFree, counted)))} GiB room`,
    `${diskGib(memoryBudgetBytes(bytesFree, counted))} GiB budget`,
    memoryBudgetState(bytesFree, counted, 0),
    ...(counted.unmeasured === undefined ? [] : ["uncapped use unmeasured"]),
  ].join(" · ");
}
