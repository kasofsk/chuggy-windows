/**
 * The pool's lock is a seam: Windows' exclusive open locks nothing on other
 * systems, so the suites hold locks in memory, and of `windowsLocking` only
 * what any system does is shown.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout } from "node:timers";

import { controlServed } from "./control.fixture.mjs";
import {
  poolHeldCode,
  poolServiceAsked,
  poolServiceClaimed,
  poolServiceFound,
  poolServiceLeftoversRemoved,
  poolServicePipeFresh,
  poolServiceReleasedNow,
  windowsLocking,
} from "./poolService.mjs";
import { fakeLocking, machineDirectory } from "./runner.fixture.mjs";

const pipePattern = /^\\\\\.\\pipe\\chuggy-windows-[0-9a-f]{32}$/u;

/**
 * A pool's runtime directory, made, its record and lock, and locks held in
 * memory.
 *
 * @param {import("node:test").TestContext} t
 */
async function pooled(t) {
  await machineDirectory(t);
  const runtime =
    "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\run\\pools\\0123456789abcdef0123";
  await mkdir(runtime, { recursive: true });
  const file = win32.join(runtime, "control.json");
  return {
    runtime,
    file,
    lock: win32.join(runtime, "run.lock"),
    ...fakeLocking(),
    record: async () => JSON.parse(await readFile(file, "utf8")),
    /** What a claim may leave beside the record. */
    beside: async () =>
      (await readdir(".")).filter((name) => name.startsWith(`${file}.`)),
  };
}

test("a fresh pipe is one this runner names, and never one it named before", () => {
  const pipes = Array.from({ length: 16 }, poolServicePipeFresh);
  for (const pipe of pipes) assert.match(pipe, pipePattern);
  assert.equal(new Set(pipes).size, pipes.length);
});

test("a claim takes the pool's lock and records a fresh pipe, the claiming pid and what it is, leaving nothing half written", async (t) => {
  const { runtime, lock, held, locking, record, beside } = await pooled(t);
  const hold = await poolServiceClaimed(runtime, 4242, "run", locking);
  assert.match(hold.pipe, pipePattern);
  assert.deepEqual(await record(), { pipe: hold.pipe, pid: 4242, kind: "run" });
  assert.deepEqual([...held], [lock]);
  assert.deepEqual(await beside(), []);
});

test("a claim of a held pool is refused by its code, naming what holds it where its record says", async (t) => {
  const { runtime, file, locking } = await pooled(t);
  const hold = await poolServiceClaimed(runtime, 4242, "run", locking);
  await assert.rejects(poolServiceClaimed(runtime, 4243, "once", locking), {
    code: poolHeldCode,
    message:
      "this pool is already held here, by a runner's service as process 4242",
  });
  await hold.release();
  const pass = await poolServiceClaimed(runtime, 4243, "once", locking);
  await assert.rejects(poolServiceClaimed(runtime, 4242, "run", locking), {
    code: poolHeldCode,
    message: "this pool is already held here, by a pass as process 4243",
  });
  await writeFile(file, "{");
  await assert.rejects(poolServiceClaimed(runtime, 4242, "run", locking), {
    code: poolHeldCode,
    message: "this pool is already held here",
  });
  await pass.release();
});

test("letting go removes the record before the lock, and the pool is then claimed again", async (t) => {
  const { runtime, file, lock, held, locking, hooks } = await pooled(t);
  const hold = await poolServiceClaimed(runtime, 4242, "run", locking);
  /** @type {boolean[]} */
  const recordedAtRelease = [];
  hooks.onRelease = () => {
    recordedAtRelease.push(existsSync(file));
  };
  await hold.release();
  assert.deepEqual(recordedAtRelease, [false]);
  assert.deepEqual([...held], []);
  hooks.onRelease = () => undefined;
  const again = await poolServiceClaimed(runtime, 4243, "run", locking);
  assert.ok(held.has(lock));
  await again.release();
});

test("a record whose lock is held is what holds the pool, and one whose lock is not is no run's, and is replaced by the next claim", async (t) => {
  const { runtime, file, held, locking, record } = await pooled(t);
  const left = { pipe: poolServicePipeFresh(), pid: 4242, kind: "run" };
  await writeFile(file, JSON.stringify(left));
  assert.equal(await poolServiceFound(runtime, locking), undefined);
  assert.deepEqual([...held], [], "finding takes no lock it keeps");
  const hold = await poolServiceClaimed(runtime, 4243, "once", locking);
  const found = { pipe: hold.pipe, pid: 4243, kind: "once" };
  assert.deepEqual(await record(), found);
  assert.deepEqual(await poolServiceFound(runtime, locking), found);
  for (const text of [
    "{",
    JSON.stringify({ ...found, kind: "service" }),
    JSON.stringify({ ...found, pipe: "\\\\.\\pipe\\docker_engine" }),
    JSON.stringify({ ...found, pid: "4243" }),
  ]) {
    await writeFile(file, text);
    assert.equal(await poolServiceFound(runtime, locking), undefined, text);
  }
  await hold.release();
});

test("a claim that cannot place its record lets the lock go and says why", async (t) => {
  const { runtime, file, held, locking, beside } = await pooled(t);
  await mkdir(join(file, "in-the-way"), { recursive: true });
  await assert.rejects(
    poolServiceClaimed(runtime, 4242, "run", locking),
    /^Error: E(ISDIR|NOTEMPTY|EXIST)/u,
  );
  assert.deepEqual([...held], []);
  assert.deepEqual(await beside(), []);
});

test("a claim made while another looks at the lock for a moment is not refused for it", async (t) => {
  const { runtime, lock, locking, record } = await pooled(t);
  const looking = await locking(lock);
  setTimeout(() => void looking?.release(), 150);
  const hold = await poolServiceClaimed(runtime, 4242, "run", locking);
  assert.equal((await record()).pid, 4242);
  await hold.release();
});

test("claims made at once leave exactly one holding the pool", async (t) => {
  const { runtime, locking, record } = await pooled(t);
  const settled = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      poolServiceClaimed(runtime, 100 + index, "run", locking),
    ),
  );
  const holds = settled.filter((claim) => claim.status === "fulfilled");
  assert.equal(holds.length, 1);
  for (const claim of settled)
    if (claim.status === "rejected")
      assert.equal(claim.reason.code, poolHeldCode);
  assert.equal((await record()).pipe, holds[0].value.pipe);
});

test("a process ending at once removes the record only where it is its own, and fails on none", async (t) => {
  const { runtime, file, locking } = await pooled(t);
  poolServiceReleasedNow(runtime, 4242);
  await poolServiceClaimed(runtime, 4242, "run", locking);
  poolServiceReleasedNow(runtime, 4243);
  assert.ok(existsSync(file));
  poolServiceReleasedNow(runtime, 4242);
  assert.ok(!existsSync(file));
  await writeFile(file, "{");
  poolServiceReleasedNow(runtime, 4242);
  assert.ok(existsSync(file));
});

test("records a holder half wrote are removed, and nothing else is", async (t) => {
  const { runtime, file } = await pooled(t);
  const entries = [
    "control.json",
    "control.json.new-0011223344556677",
    "control.json.new-8899aabbccddeeff",
    "run.lock",
    "pull-1-a",
  ];
  for (const entry of entries) await writeFile(win32.join(runtime, entry), "");
  await poolServiceLeftoversRemoved(runtime, entries);
  assert.deepEqual(
    entries.filter((entry) => existsSync(win32.join(runtime, entry))),
    ["control.json", "run.lock", "pull-1-a"],
  );
  assert.ok(existsSync(file));
});

test("Windows' lock is a file opened and closed again, and a lock that cannot be opened says why", async (t) => {
  const { lock } = await pooled(t);
  const held = await windowsLocking(lock);
  assert.ok(held !== undefined);
  assert.ok((await stat(lock)).isFile());
  await held.release();
  // Off Windows a missing directory is named by this system's separator.
  await assert.rejects(windowsLocking(join("gone", "run.lock")), {
    code: "ENOENT",
  });
});

test("asking where no pipe is found answers nothing, and asking a service that never answers is refused past the wait", async (t) => {
  await machineDirectory(t);
  assert.equal(await poolServiceAsked(undefined, { op: "status" }), undefined);
  assert.equal(
    await poolServiceAsked(poolServicePipeFresh(), { op: "status" }),
    undefined,
  );
  const pipe = poolServicePipeFresh();
  /** @type {import("node:net").Socket[]} */
  const sockets = [];
  const silent = createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => silent.listen(pipe, () => resolve(undefined)));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
  await assert.rejects(poolServiceAsked(pipe, { op: "status" }, 50), {
    message: `the service at ${pipe} did not answer within 0.05s`,
  });
});

test("the service on the pipe of what holds the pool is asked and answers", async (t) => {
  const { runtime, locking } = await pooled(t);
  const hold = await poolServiceClaimed(runtime, 4242, "run", locking);
  const served = await controlServed(t, hold.pipe);
  const found = await poolServiceFound(runtime, locking);
  assert.deepEqual(
    await poolServiceAsked(found?.pipe, { op: "stop", assignment: "asg-1" }),
    { stopped: "Stopped" },
  );
  assert.deepEqual(served.stopped, ["asg-1"]);
  await hold.release();
});

test("a pool whose runtime directory is not made yet is held by nothing", async (t) => {
  await machineDirectory(t);
  const missing =
    "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\run\\pools\\never";
  const locking = async (/** @type {string} */ file) => {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${file}'`),
      {
        code: "ENOENT",
      },
    );
  };
  assert.equal(await poolServiceFound(missing, locking), undefined);
  assert.equal(await poolServiceFound(missing, windowsLocking), undefined);
});

test("a claim tries the lock again for a moment, so a look at the pool that holds it briefly refuses no claim, and one held throughout is refused", async (t) => {
  const { runtime, lock, events, locking } = await pooled(t);
  const looking = await locking(lock);
  const claim = poolServiceClaimed(runtime, 4242, "run", locking);
  await delay(150);
  await looking?.release();
  const hold = await claim;
  assert.ok(events.some(([what]) => what === "refuse"));
  events.length = 0;
  await assert.rejects(poolServiceClaimed(runtime, 4243, "run", locking), {
    code: poolHeldCode,
  });
  assert.deepEqual(
    events.map(([what]) => what),
    ["refuse", "refuse", "refuse", "refuse", "refuse"],
  );
  await hold.release();
});
