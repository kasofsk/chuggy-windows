import assert from "node:assert/strict";
import test from "node:test";

import { machineFacts } from "./machineFacts.mjs";

/** Ports reading a machine of 16 CPUs with 40 GiB of memory, 7.5 GiB of it available. */
const ports = {
  cpus: () => 16,
  memoryTotal: () => 40 * 2 ** 30,
  memoryAvailable: () => 7.5 * 2 ** 30,
};

/** @param {number} diskFreeGibMin */
const configured = (diskFreeGibMin) =>
  /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
    /** @type {unknown} */ ({ diskFreeGibMin })
  );

test("a report names this machine's CPUs and memory as Windows counts them, no load average, and the free disk with its floor where the file keeps one", async () => {
  /** @type {number[]} */
  const measured = [];
  const diskFree = async () => {
    measured.push(1);
    return { free: 640 * 2 ** 30, where: "D:\\" };
  };
  assert.deepEqual(await machineFacts(configured(30), diskFree, ports)(), {
    cpus: 16,
    memoryTotalBytes: 40 * 2 ** 30,
    memoryAvailableBytes: 7.5 * 2 ** 30,
    diskFreeBytes: 640 * 2 ** 30,
    diskFloorBytes: 30 * 2 ** 30,
  });
  assert.deepEqual(await machineFacts(configured(0), diskFree, ports)(), {
    cpus: 16,
    memoryTotalBytes: 40 * 2 ** 30,
    memoryAvailableBytes: 7.5 * 2 ** 30,
  });
  assert.deepEqual(measured, [1]);
});

test("a free disk that cannot be measured, or memory Windows does not count, is left out", async () => {
  const unknown = async () => ({ unknown: "no engine" });
  const failing = async () => {
    throw new Error("hung");
  };
  for (const diskFree of [unknown, failing])
    assert.deepEqual(
      await machineFacts(configured(30), diskFree, {
        ...ports,
        memoryAvailable: () => 0,
        memoryTotal: () => Number.NaN,
      })(),
      { cpus: 16 },
    );
});
