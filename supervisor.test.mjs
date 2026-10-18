import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import { deferred } from "./engine.fixture.mjs";
import { deniedExitStatus } from "./serviceTask.mjs";
import { PassThrough } from "node:stream";

import {
  inputEnded,
  restartDelayMs,
  serviceLogBytesMax,
  serviceLogLinesQueuedMax,
  serviceLogged,
  supervisedChild,
  supervisedVariable,
  supervisor,
  supervisorDenied,
} from "./supervisor.mjs";

/**
 * @typedef {object} FakeRun what a started `run` prints and how it ends
 * @property {string[]} [lines]
 * @property {Promise<number> | number} exits
 */

/**
 * A service over runs a suite scripts, in a directory of its own, whose
 * clock ticks a second at each reading. The parent is there until the suite
 * says it is gone; the wait before a restart ends at once unless the suite
 * holds it.
 *
 * @param {import("node:test").TestContext} t
 */
async function serviced(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-windows-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const poolFile = join(directory, "pool.json");
  await writeFile(poolFile, '{"pool":"shame"}');
  /** @type {FakeRun[]} */
  const runs = [];
  /** @type {number[]} */
  const slept = [];
  const parent = deferred();
  /** @type {{held: boolean, asked: ReturnType<typeof deferred<void>>}} */
  const restart = { held: false, asked: deferred() };
  const firstStarted = deferred();
  let started = 0;
  let seconds = 0;
  /** @type {import("./supervisor.mjs").SupervisorHost} */
  const host = {
    poolFile,
    logFile: join(directory, "service-pool.log"),
    deniedFile: join(directory, "pool.denied"),
    start: () => {
      firstStarted.resolve(undefined);
      const run = runs[started++] ?? { exits: new Promise(() => undefined) };
      return {
        lines: (onLine) => (run.lines ?? []).forEach(onLine),
        exited: Promise.resolve(run.exits),
      };
    },
    sleep: (ms) => {
      slept.push(ms);
      restart.asked.resolve();
      return restart.held ? new Promise(() => undefined) : Promise.resolve();
    },
    parentGone: parent.promise.then(() => undefined),
    now: () => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds++)),
  };
  return {
    host,
    runs,
    slept,
    restart,
    started: () => started,
    firstStarted: firstStarted.promise,
    /** The parent ends. */
    parentEnded: () => parent.resolve(undefined),
    log: async () =>
      (await readFile(host.logFile, "utf8")).split("\n").filter(Boolean),
  };
}

test("a run that ends for any reason but a denial is started again after restartDelayMs, and every line is logged in order with its time", async (t) => {
  const { host, runs, slept, started, log } = await serviced(t);
  runs.push(
    { lines: ["placed asg-1", "the plane is unreachable"], exits: 1 },
    { lines: ["killed"], exits: -1 },
    { lines: ["the plane denied this pool"], exits: deniedExitStatus },
  );
  assert.equal(await supervisor(host), 0);
  assert.equal(started(), 3);
  assert.deepEqual(slept, [restartDelayMs, restartDelayMs]);
  assert.deepEqual(await log(), [
    "2026-10-16T12:00:00.000Z placed asg-1",
    "2026-10-16T12:00:01.000Z the plane is unreachable",
    `2026-10-16T12:00:02.000Z run exited 1; starting it again in ${String(restartDelayMs / 1000)}s`,
    "2026-10-16T12:00:03.000Z killed",
    `2026-10-16T12:00:04.000Z run exited -1; starting it again in ${String(restartDelayMs / 1000)}s`,
    "2026-10-16T12:00:05.000Z the plane denied this pool",
    `2026-10-16T12:00:06.000Z the plane denied ${host.poolFile}; the service ends until the pool is registered again`,
  ]);
});

test("a denial is remembered beside the pool file as it stands, so the service starts no run of it again", async (t) => {
  const { host, runs, started, log } = await serviced(t);
  runs.push({ exits: deniedExitStatus });
  assert.equal(await supervisor(host), 0);
  const { size, mtimeMs } = await stat(host.poolFile);
  assert.deepEqual(JSON.parse(await readFile(host.deniedFile, "utf8")), {
    size,
    mtimeMs,
  });
  assert.equal(await supervisor(host), 0);
  assert.equal(started(), 1);
  assert.equal(
    (await log()).at(-1),
    `2026-10-16T12:00:01.000Z the plane denied ${host.poolFile}; register the pool again to serve it`,
  );
});

test("a pool file written again, by its size or its time, forgets the denial and its run is started", async (t) => {
  const { host, runs, started } = await serviced(t);
  runs.push({ exits: deniedExitStatus }, { exits: deniedExitStatus });
  await supervisor(host);
  await writeFile(host.poolFile, '{"pool":"shame","again":true}');
  assert.equal(await supervisorDenied(host), false);
  await assert.rejects(stat(host.deniedFile), { code: "ENOENT" });
  await supervisor(host);
  assert.equal(started(), 2);
  assert.equal(await supervisorDenied(host), true);
  const { mtime } = await stat(host.poolFile);
  await utimes(host.poolFile, mtime, new Date(mtime.getTime() + 1000));
  assert.equal(await supervisorDenied(host), false);
});

test("a denial that cannot be read, or of a pool file that is gone, is forgotten, and no denial is remembered of a file that is gone", async (t) => {
  const { host, runs, started } = await serviced(t);
  assert.equal(await supervisorDenied(host), false);
  await writeFile(host.deniedFile, "not json");
  assert.equal(await supervisorDenied(host), false);
  await assert.rejects(stat(host.deniedFile), { code: "ENOENT" });
  runs.push({ exits: deniedExitStatus });
  await supervisor(host);
  assert.equal(await supervisorDenied(host), true);
  await rm(host.poolFile);
  assert.equal(await supervisorDenied(host), false);
  await assert.rejects(stat(host.deniedFile), { code: "ENOENT" });
  runs.push({ exits: deniedExitStatus });
  assert.equal(await supervisor(host), 0);
  assert.equal(started(), 2);
  await assert.rejects(stat(host.deniedFile), { code: "ENOENT" });
});

test("the service ends once its parent is gone while a run runs, and leaves the run to end itself", async (t) => {
  const { host, slept, parentEnded, started, firstStarted, log } =
    await serviced(t);
  const ended = supervisor(host);
  await firstStarted;
  assert.equal(started(), 1);
  assert.deepEqual(slept, []);
  parentEnded();
  assert.equal(await ended, 0);
  assert.equal(started(), 1);
  assert.deepEqual(await log(), [
    "2026-10-16T12:00:00.000Z the task ended, so the service ends",
  ]);
});

test("the service ends once its parent is gone while it waits to start a run again, and starts none", async (t) => {
  const { host, runs, restart, parentEnded, started, log } = await serviced(t);
  runs.push({ exits: 1 });
  restart.held = true;
  const ended = supervisor(host);
  await restart.asked.promise;
  parentEnded();
  assert.equal(await ended, 0);
  assert.equal(started(), 1);
  assert.deepEqual(await log(), [
    `2026-10-16T12:00:00.000Z run exited 1; starting it again in ${String(restartDelayMs / 1000)}s`,
    "2026-10-16T12:00:01.000Z the task ended, so the service ends",
  ]);
});

test("a log past serviceLogBytesMax is moved aside, to one older copy, before the next line", async (t) => {
  const { host, runs, log } = await serviced(t);
  const old = "x".repeat(serviceLogBytesMax + 1);
  await writeFile(host.logFile, old);
  runs.push({ lines: ["fresh"], exits: deniedExitStatus });
  await supervisor(host);
  assert.equal(await readFile(`${host.logFile}.1`, "utf8"), old);
  assert.deepEqual(await log(), [
    "2026-10-16T12:00:00.000Z fresh",
    `2026-10-16T12:00:01.000Z the plane denied ${host.poolFile}; the service ends until the pool is registered again`,
  ]);
  await writeFile(host.logFile, "y".repeat(serviceLogBytesMax));
  await serviceLogged(host, "kept");
  assert.equal((await stat(host.logFile)).size, serviceLogBytesMax + 30);
  assert.equal(await readFile(`${host.logFile}.1`, "utf8"), old);
});

test("a line the log cannot take is dropped, and nothing is thrown", async (t) => {
  const { host } = await serviced(t);
  await serviceLogged(
    { ...host, logFile: join(host.logFile, "no", "such.log") },
    "lost",
  );
  await assert.rejects(stat(host.logFile), { code: "ENOENT" });
});

test("a supervised run is this Node running the CLI's run for the pool file, told it is supervised, its lines read from both its outputs and its status read back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-windows-child-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, "cli.mjs");
  await writeFile(
    cli,
    `process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
process.stderr.write("supervised " + process.env.${supervisedVariable} + "\\r\\nkept " + process.env.KEPT + "\\n");
process.exitCode = 7;`,
  );
  const child = supervisedChild({
    node: process.execPath,
    cli,
    poolFile: "C:\\Users\\op\\pool.json",
    environment: { ...process.env, KEPT: "yes" },
  });
  /** @type {string[]} */
  const lines = [];
  child.lines((line) => lines.push(line));
  assert.equal(await child.exited, 7);
  // Its outputs may still be draining once it has exited.
  while (lines.length < 3) await tick();
  assert.deepEqual(lines.sort(), [
    '["run","--pool","C:\\\\Users\\\\op\\\\pool.json"]',
    "kept yes",
    "supervised 1",
  ]);
});

test("a run that could not start, or that ended by no status of its own, has status -1", async (t) => {
  const missing = supervisedChild({
    node: join(tmpdir(), "chuggy-windows-no-such-node"),
    cli: "cli.mjs",
    poolFile: "p.json",
    environment: {},
  });
  assert.equal(await missing.exited, -1);
  const directory = await mkdtemp(join(tmpdir(), "chuggy-windows-child-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, "cli.mjs");
  await writeFile(cli, 'process.kill(process.pid, "SIGKILL");');
  const killed = supervisedChild({
    node: process.execPath,
    cli,
    poolFile: "p.json",
    environment: {},
  });
  killed.lines(() => undefined);
  assert.equal(await killed.exited, -1);
});

test("the parent is gone once this process's console input ends or fails, as it does when the console host is ended", async () => {
  for (const ending of [
    (/** @type {PassThrough} */ input) => input.end(),
    (/** @type {PassThrough} */ input) =>
      input.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
  ]) {
    const input = new PassThrough();
    const gone = inputEnded(input);
    let settled = false;
    void gone.then(() => (settled = true));
    await tick();
    assert.equal(settled, false);
    ending(input);
    await gone;
  }
});

test("a denial is remembered of the pool file the denied run started on, so a file registered again while it ran is served", async (t) => {
  const { host, runs, started, firstStarted } = await serviced(t);
  const before = await stat(host.poolFile);
  const rewritten = deferred();
  runs.push({
    exits: rewritten.promise.then(() => deniedExitStatus),
  });
  const ended = supervisor(host);
  await firstStarted;
  await writeFile(host.poolFile, '{"pool":"shame","registered":"again"}');
  rewritten.resolve(undefined);
  assert.equal(await ended, 0);
  assert.deepEqual(JSON.parse(await readFile(host.deniedFile, "utf8")), {
    size: before.size,
    mtimeMs: before.mtimeMs,
  });
  assert.equal(await supervisorDenied(host), false);
  runs.push({ exits: deniedExitStatus });
  await supervisor(host);
  assert.equal(started(), 2);
});

test("lines past serviceLogLinesQueuedMax waiting to be written are dropped, and how many is written before the next line kept", async (t) => {
  const { host, runs, log } = await serviced(t);
  const extra = 3;
  runs.push({
    lines: Array.from(
      { length: serviceLogLinesQueuedMax + extra },
      (_, index) => `line ${String(index)}`,
    ),
    exits: deniedExitStatus,
  });
  await supervisor(host);
  const written = await log();
  assert.equal(written.length, serviceLogLinesQueuedMax + 2);
  assert.match(
    written.at(-2) ?? "",
    new RegExp(
      `dropped ${String(extra)} lines the log could not keep up with$`,
      "u",
    ),
  );
  assert.match(
    written.at(-1) ?? "",
    /the service ends until the pool is registered again$/u,
  );
});
