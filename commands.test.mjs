import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { heldCreateArgv } from "@chuggy/worker-core/engineArgv.mjs";

import { cliMain } from "./commands.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";
import { deferred, fakeDisk, fakeEngine } from "./engine.fixture.mjs";
import {
  poolServiceAsked,
  poolServiceClaimed,
  poolServicePipeFresh,
} from "./poolService.mjs";
import {
  answeringFetch,
  registeredFixture,
  registeredPersonalFixture,
} from "./register.fixture.mjs";
import { poolRuntimeDirectory } from "./runner.mjs";
import {
  fakeLocking,
  fixturePool,
  hostedPool,
  fixtureUserSid,
  poolFileWritten,
  runnerFixture,
  sharedFixture,
  signalsWatched,
  usersReadAcl,
  usersRefusal,
} from "./runner.fixture.mjs";
import {
  deniedExitStatus,
  serviceQueryArgv,
  serviceTask,
  serviceTaskFileBytes,
} from "./serviceTask.mjs";
import { fakeTaskScheduler } from "./taskScheduler.fixture.mjs";

/**
 * @typedef {object} Machine
 * @property {Record<string, string>} [environment]
 * @property {string} [home]
 * @property {string} [hostname]
 * @property {string} [arch]
 * @property {typeof globalThis.fetch} [fetch]
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine]
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens]
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["plane"] | null} [plane] the one doctor polls, which a suite never reaches unless it sets it, and `null` for the pool's own
 * @property {import("./taskScheduler.mjs").TaskScheduler} [tasks]
 * @property {import("./runnerConfig.mjs").SharedRefusal} [sharedRefusal]
 * @property {import("./supervisor.mjs").SupervisorHost["start"]} [startRun]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [nowMs]
 * @property {import("./poolService.mjs").PoolLocking} [locking]
 * @property {import("./diskFree.mjs").DiskFreePorts} [disk]
 */

/** A token source whose issuer has revoked the pool, so a pass ends without the network. */
const deniedTokens = {
  acquire: async () => ({
    acquired: "Denied",
    evidence: "the pool was revoked",
  }),
  invalidate: () => undefined,
};

/** A plane a suite never reaches. */
const unreachedPlane = {
  poll: async () => {
    throw new Error("a suite reaches no network");
  },
  settle: async () => {
    throw new Error("a suite reaches no network");
  },
};

/** A pool's issuer and plane answering as chuggy's do, so every check doctor makes passes. */
const ready = {
  tokens: {
    acquire: async () => ({ acquired: "Token", token: "pool-token" }),
    invalidate: () => undefined,
  },
  plane: {
    poll: async () => ({ polled: "Reconciled", assignments: [], stop: [] }),
    settle: async () => "Settled",
  },
};

/** The copy a suite's calls are made of, and the Node they run under. */
const copyVersion = "9.8.7";
const copyNode = "C:\\Program Files\\nodejs\\node.exe";
const copyCli =
  "C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\chuggy-windows\\cli.mjs";

/** What doctor says first, of the copy a suite's calls are made of. */
const copyLine = `chuggy-windows ${copyVersion} at ${copyCli}, under Node 24.8.0 at ${copyNode}`;

/** The task serving the fixture's pool file. */
const poolTask = "\\chuggy-windows\\pool";

/**
 * @param {readonly string[]} argv
 * @param {Machine} machine
 */
async function called(argv, machine = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const status = await cliMain(argv, {
    environment: machine.environment ?? {},
    home: machine.home ?? "C:\\Users\\nobody",
    hostname: machine.hostname ?? "shame",
    arch: machine.arch ?? "x64",
    fetch:
      machine.fetch ??
      (async () => {
        throw new Error("a suite reaches no network");
      }),
    engine: machine.engine ?? fakeEngine().engine,
    tokens: machine.tokens ?? deniedTokens,
    ...(machine.plane === null
      ? {}
      : { plane: machine.plane ?? unreachedPlane }),
    disk: machine.disk ?? fakeDisk(100),
    tasks: machine.tasks ?? fakeTaskScheduler().scheduler,
    sharedRefusal: machine.sharedRefusal ?? sharedFixture().sharedRefusal,
    userSid: async () => fixtureUserSid,
    startRun: machine.startRun,
    sleep: machine.sleep,
    nowMs: machine.nowMs,
    locking: machine.locking ?? fakeLocking().locking,
    stdin: new PassThrough(),
    exit: () => assert.fail("a suite's command ends no process"),
    version: copyVersion,
    node: copyNode,
    nodeVersion: "24.8.0",
    cli: copyCli,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/**
 * A machine's files, and the machine a call is made on with them.
 *
 * @param {import("node:test").TestContext} t
 * @param {Parameters<typeof runnerFixture>[1]} [documents]
 */
async function machined(t, documents) {
  const fixture = await runnerFixture(t, documents);
  signalsWatched(t);
  const tasks = fakeTaskScheduler();
  const locks = fakeLocking();
  return {
    ...fixture,
    tasks,
    locks,
    /** @type {Machine} */
    machine: {
      home: fixture.home,
      environment: fixture.environment,
      sharedRefusal: fixture.sharedRefusal,
      tasks: tasks.scheduler,
      locking: locks.locking,
    },
  };
}

test("help is asked for and answered", async () => {
  for (const argv of [["--help"], ["help"], ["-h"]]) {
    const { status, out } = await called(argv);
    assert.equal(status, 0);
    assert.match(out, /^usage: chuggy-windows <command>/u);
  }
});

test("--version names this copy, whatever else is asked, and usage names it", async () => {
  for (const argv of [["--version"], ["doctor", "--version"]]) {
    const { status, out, err } = await called(argv);
    assert.equal(status, 0, argv.join(" "));
    assert.equal(out, `chuggy-windows ${copyVersion}`);
    assert.equal(err, "");
  }
  assert.match(
    (await called(["help"])).out,
    /^ {7}chuggy-windows --version$/mu,
  );
});

test("a call asked wrongly exits 2 with the usage", async () => {
  for (const argv of [
    [],
    ["launch", "--pool", "C:\\p.json"],
    ["run", "--pool"],
    ["run", "--pools", "C:\\p.json"],
    ["stop", "--pool", "C:\\p.json"],
    ["stop", "a", "b", "--pool", "C:\\p.json"],
    ["status", "extra", "--pool", "C:\\p.json"],
    ["service", "extra", "--pool", "C:\\p.json"],
  ]) {
    const { status, err } = await called(argv);
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, /usage: chuggy-windows/u, argv.join(" "));
  }
});

test("a command needs a pool file, named by --pool or CHUGGY_WINDOWS_POOL", async (t) => {
  const { status, err } = await called(["doctor"]);
  assert.equal(status, 2);
  assert.match(
    err,
    /^no pool file: name one with --pool or CHUGGY_WINDOWS_POOL/u,
  );
  const { poolFile, machine } = await machined(t);
  const named = await called(["doctor"], {
    ...machine,
    environment: { ...machine.environment, CHUGGY_WINDOWS_POOL: poolFile },
    ...ready,
  });
  assert.equal(named.status, 0, named.err);
  assert.match(
    named.out,
    /^ok {4}pool file: C:\\Users\\op\\pool\.json names /mu,
  );
});

test("install-service registers the pool file's own task from a definition file it removes, which runs this CLI under this Node, and prints how to start it", async (t) => {
  const { poolFile, paths, machine, tasks } = await machined(t);
  const { status, out, err } = await called(
    ["install-service", "--pool", poolFile],
    machine,
  );
  assert.equal(status, 0, err);
  const file = win32.join(
    paths.runtime,
    `task-pool-${String(process.pid)}.xml`,
  );
  assert.deepEqual(tasks.argvs(), [
    serviceQueryArgv(poolTask),
    ["schtasks", "/Create", "/TN", poolTask, "/XML", file, "/F"],
  ]);
  assert.deepEqual(
    tasks.calls[1].file,
    serviceTaskFileBytes(
      serviceTask({ node: copyNode, cli: copyCli, poolFile }, fixtureUserSid),
    ),
  );
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(
    out,
    [
      `registered the task ${poolTask}, which starts at each logon; start it now with:`,
      `  schtasks /Run /TN ${poolTask}`,
    ].join("\n"),
  );
});

test("install-service registers nothing for a pool file it cannot read, or that anyone else may open", async (t) => {
  const unread = await machined(t, { pool: { tenant: "vteng" } });
  const bad = await called(
    ["install-service", "--pool", unread.poolFile],
    unread.machine,
  );
  assert.equal(bad.status, 1);
  assert.match(bad.err, /^pool credentials .*: project /u);
  assert.deepEqual(unread.tasks.calls, []);

  const shared = await machined(t);
  shared.acls.set(shared.poolFile, usersReadAcl);
  const refused = await called(
    ["install-service", "--pool", shared.poolFile],
    shared.machine,
  );
  assert.equal(refused.status, 1);
  assert.equal(
    refused.err,
    `pool credentials ${shared.poolFile} ${usersRefusal}`,
  );
  assert.deepEqual(shared.tasks.calls, []);
});

test("install-service refuses a task of the pool file's name serving another pool file, or none this runner named, and registers nothing", async (t) => {
  const { poolFile, machine, tasks } = await machined(t);
  for (const [definition, serves] of [
    [
      serviceTask(
        { node: copyNode, cli: copyCli, poolFile: "D:\\elsewhere\\pool.json" },
        fixtureUserSid,
      ),
      "D:\\elsewhere\\pool.json",
    ],
    [
      "<Task><Exec><Command>notepad.exe</Command></Exec></Task>",
      "no pool file this runner named",
    ],
  ]) {
    tasks.tasks.set(poolTask, definition);
    tasks.calls.length = 0;
    const { status, err } = await called(
      ["install-service", "--pool", poolFile],
      machine,
    );
    assert.equal(status, 1);
    assert.equal(
      err,
      `the task ${poolTask} serves ${serves}, not ${poolFile}; delete that task if it is stale, or rename the pool file`,
    );
    assert.deepEqual(tasks.argvs(), [serviceQueryArgv(poolTask)]);
    assert.equal(tasks.tasks.get(poolTask), definition);
  }
});

test("install-service replaces the pool file's own task, so it runs this copy under this Node", async (t) => {
  const { poolFile, machine, tasks } = await machined(t);
  tasks.tasks.set(
    poolTask,
    serviceTask(
      { node: "C:\\old\\node.exe", cli: "C:\\old\\cli.mjs", poolFile },
      fixtureUserSid,
    ),
  );
  const { status } = await called(
    ["install-service", "--pool", poolFile],
    machine,
  );
  assert.equal(status, 0);
  assert.equal(
    tasks.tasks.get(poolTask),
    serviceTask({ node: copyNode, cli: copyCli, poolFile }, fixtureUserSid),
  );
});

test("install-service says what schtasks said where it could not register the task, and removes the definition's file still", async (t) => {
  const { poolFile, paths, machine, tasks } = await machined(t);
  const file = win32.join(
    paths.runtime,
    `task-pool-${String(process.pid)}.xml`,
  );
  const create = `schtasks /Create /TN ${poolTask} /XML ${file} /F`;
  for (const [answer, said] of [
    [
      { code: 1, stderr: "ERROR: Access is denied.\r\nmore\r\n" },
      "ERROR: Access is denied.",
    ],
    [{ code: 2147942402 }, "exited 2147942402"],
  ]) {
    tasks.failing[create] = answer;
    const { status, out, err } = await called(
      ["install-service", "--pool", poolFile],
      machine,
    );
    assert.equal(status, 1);
    assert.equal(out, "");
    assert.equal(err, `${create}: ${said}`);
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(tasks.tasks.size, 0);
  }
});

test("install-service that cannot replace the pool file's own task says a task an elevated PowerShell registered is replaced only from one", async (t) => {
  const { poolFile, paths, machine, tasks } = await machined(t);
  const before = serviceTask(
    { node: "C:\\old\\node.exe", cli: "C:\\old\\cli.mjs", poolFile },
    fixtureUserSid,
  );
  tasks.tasks.set(poolTask, before);
  const file = win32.join(
    paths.runtime,
    `task-pool-${String(process.pid)}.xml`,
  );
  const create = `schtasks /Create /TN ${poolTask} /XML ${file} /F`;
  tasks.failing[create] = { code: 1, stderr: "ERROR: Access is denied.\r\n" };
  const { status, err } = await called(
    ["install-service", "--pool", poolFile],
    machine,
  );
  assert.equal(status, 1);
  assert.equal(
    err,
    `${create}: ERROR: Access is denied.; a task registered from an elevated PowerShell can be replaced only from one, so run this there, or delete the task there with schtasks /Delete /TN ${poolTask} /F and run this again`,
  );
  assert.equal(tasks.tasks.get(poolTask), before);
});

test("two pools' files get two tasks, and installing one leaves the other's alone", async (t) => {
  const { home, poolFile, machine, tasks } = await machined(t);
  const other = await poolFileWritten(
    win32.join(home, "newtenant.arbbot.shame.json"),
    { ...fixturePool, tenant: "newtenant", project: "arbbot" },
  );
  assert.equal(
    (await called(["install-service", "--pool", poolFile], machine)).status,
    0,
  );
  const first = tasks.tasks.get(poolTask);
  const { status, out } = await called(
    ["install-service", "--pool", other],
    machine,
  );
  assert.equal(status, 0);
  assert.deepEqual([...tasks.tasks.keys()].sort(), [
    "\\chuggy-windows\\newtenant.arbbot.shame",
    poolTask,
  ]);
  assert.equal(tasks.tasks.get(poolTask), first);
  assert.match(
    out,
    /^ {2}schtasks \/Run \/TN \\chuggy-windows\\newtenant\.arbbot\.shame$/mu,
  );
});

test("doctor exits 1 on a failed check, printing every check it made", async (t) => {
  const { poolFile, paths, machine } = await machined(t, {
    pool: { tenant: "vteng" },
    runner: undefined,
  });
  const { status, out, err } = await called(
    ["doctor", "--pool", poolFile],
    machine,
  );
  assert.equal(status, 1);
  assert.equal(
    out,
    [
      copyLine,
      `ok    runner directories: C:\\Users\\op, ${paths.runtime}, ${paths.logs}, ${paths.jobs} are this account's alone, or are made where they will be`,
      `ok    service task: none yet named ${poolTask}`,
    ].join("\n"),
  );
  assert.match(
    err,
    new RegExp(
      `^FAIL {2}pool file: pool credentials .*\\nFAIL {2}runner configuration: ENOENT: .*runner\\.json'$`,
      "u",
    ),
  );
  assert.ok(err.includes(paths.config), err);
});

test("doctor says first which copy is speaking under which Node, and warns where the pool file's task runs another, passing still", async (t) => {
  const { poolFile, machine, tasks } = await machined(t);
  const old = { node: "C:\\nodejs\\node.exe", cli: "C:\\old\\cli.mjs" };
  tasks.tasks.set(poolTask, serviceTask({ ...old, poolFile }, fixtureUserSid));
  const { status, out, err } = await called(["doctor", "--pool", poolFile], {
    ...machine,
    ...ready,
  });
  assert.equal(status, 0, err);
  assert.equal(out.split("\n")[0], copyLine);
  assert.equal(
    err,
    `warn  service task: ${poolTask} runs ${old.cli} under ${old.node}, not this copy under this Node; to have it run this one: '${copyNode}' ${copyCli} install-service --pool ${poolFile}; schtasks /End /TN ${poolTask}; schtasks /Run /TN ${poolTask}`,
  );
  assert.equal(
    (await called(["install-service", "--pool", poolFile], machine)).status,
    0,
  );
  const again = await called(["doctor", "--pool", poolFile], {
    ...machine,
    ...ready,
  });
  assert.equal(again.err, "");
  assert.match(
    again.out,
    /^ok {4}service task: \\chuggy-windows\\pool runs this copy under this Node$/mu,
  );
});

/** The pid another process holding a suite's pool has. */
const holderPid = 4242;

/**
 * What holds `identity`'s pool, as `kind` and process `holderPid`, through
 * the machine's locks, answering on the pipe its record names with what it
 * is placing.
 *
 * @param {import("node:test").TestContext} t
 * @param {{paths: import("./runnerConfig.mjs").RunnerPaths, locks: ReturnType<typeof fakeLocking>}} machine
 * @param {import("@chuggy/worker-core/poolIdentity.mjs").PoolIdentity} identity
 * @param {{kind?: "run" | "once", inFlight?: readonly object[]}} [held]
 */
async function heldBy(t, machine, identity, held = {}) {
  const runtime = poolRuntimeDirectory(machine.paths, identity);
  await mkdir(runtime, { recursive: true });
  const hold = await poolServiceClaimed(
    runtime,
    holderPid,
    held.kind ?? "run",
    machine.locks.locking,
  );
  const served = await controlServed(t, hold.pipe, held.inFlight);
  return { runtime, ...hold, ...served };
}

/**
 * What a run that ended without letting go leaves: its record, its lock let
 * go, and something still answering on the pipe it names.
 *
 * @param {import("node:test").TestContext} t
 * @param {Parameters<typeof heldBy>[1]} machine
 */
async function leftBehind(t, machine) {
  const held = await heldBy(t, machine, fixturePool);
  machine.locks.held.clear();
  return held;
}

/** What a claim of a pool another process's run holds is refused with. */
const heldLine = `this pool is already held here, by a runner's service as process ${String(holderPid)}`;

test("once is refused while a run of this pool holds it, and not while another pool's run does", async (t) => {
  const fixture = await machined(t);
  const { poolFile, machine } = fixture;
  await heldBy(t, fixture, { ...fixturePool, project: "arbbot" });
  const passed = await called(["once", "--pool", poolFile], machine);
  assert.equal(passed.status, deniedExitStatus, passed.err);
  assert.equal(passed.err, "Denied: the pool was revoked");
  await heldBy(t, fixture, fixturePool);
  const refused = await called(["once", "--pool", poolFile], machine);
  assert.equal(refused.status, 1);
  assert.equal(refused.err, `${heldLine}; stop it before a pass of your own`);
});

test("a pass holds the pool as a run does: status names it, and a run is refused, until it ends and lets the pool go", async (t) => {
  const { poolFile, paths, machine, locks } = await machined(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  const asked = deferred();
  const answer = deferred();
  const tokens = {
    acquire: () => {
      asked.resolve(undefined);
      return answer.promise;
    },
    invalidate: () => undefined,
  };
  const passing = called(["once", "--pool", poolFile], { ...machine, tokens });
  await asked.promise;
  const status = await called(["status", "--pool", poolFile], machine);
  assert.equal(
    status.out.split("\n")[0],
    `service: not running; a pass holds the pool as process ${String(process.pid)}`,
  );
  const run = await called(["run", "--pool", poolFile], machine);
  assert.equal(run.status, 1);
  assert.equal(
    run.err,
    `this pool is already held here, by a pass as process ${String(process.pid)}`,
  );
  answer.resolve({ acquired: "Denied", evidence: "the pool was revoked" });
  assert.equal((await passing).status, deniedExitStatus);
  await assert.rejects(stat(win32.join(runtime, "control.json")), {
    code: "ENOENT",
  });
  assert.deepEqual([...locks.held], []);
  const after = await called(["status", "--pool", poolFile], machine);
  assert.equal(after.out.split("\n")[0], "service: not running");
});

test("once makes the job network, and a pass the plane denies ends with the denial's status", async (t) => {
  const { poolFile, machine } = await machined(t);
  const { engine, state } = fakeEngine();
  const { status, out, err } = await called(["once", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(status, deniedExitStatus);
  assert.equal(out, "");
  assert.equal(err, "Denied: the pool was revoked");
  assert.ok(state.networks.has("chuggy-jobs"));
});

/**
 * Two containers of the fixture's pool, a job and a session.
 *
 * @param {import("./engine.fixture.mjs").FakeEngineState} state
 */
function containersPlaced(state) {
  for (const [name, labels, gib] of /** @type {const} */ ([
    ["chuggy-shame-a", { "io.chuggy.assignment": "asg-2" }, 4],
    [
      "chuggy-shame-b",
      { "io.chuggy.assignment": "ses-1", "io.chuggy.kind": "Session" },
      2,
    ],
  ]))
    state.containers.set(name, {
      id: `id-${name}`,
      name,
      status: "running",
      image: "i",
      labels: {
        "io.chuggy.pool": "vteng/chuggy/shame",
        "io.chuggy.deadline": "1800000000",
        ...labels,
      },
      memoryBytes: gib * 2 ** 30,
    });
}

test("status and stop reach this pool's service, and status names each workload's kind and the runner's limits", async (t) => {
  const fixture = await machined(t, {
    runner: { concurrencyMax: 3, sessionsMax: 4 },
  });
  const { poolFile, machine } = fixture;
  const { stopped } = await heldBy(t, fixture, fixturePool);
  const { engine, state } = fakeEngine();
  containersPlaced(state);
  const status = await called(["status", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(
    status.out,
    [
      "service: running",
      "limits: concurrencyMax 3, sessionsMax 4",
      "disk floor: 100 GiB free at C:\\, holding Docker Desktop's disk image, over the floor of 20 GiB",
      "memory: 10 GiB room · 16 GiB budget · 16 GiB ceiling · 2 GiB sessions · Taking",
      `${inFlightFixture.name}  session  pulling  i  asg-1`,
      "chuggy-shame-a  job  running  deadline 2027-01-15T08:00:00.000Z  asg-2",
      "chuggy-shame-b  session  running  deadline 2027-01-15T08:00:00.000Z  ses-1",
    ].join("\n"),
  );
  const stop = await called(["stop", "asg-1", "--pool", poolFile], machine);
  assert.equal(stop.status, 0);
  assert.equal(stop.out, "stopped asg-1");
  assert.deepEqual(stopped, ["asg-1"]);
});

/**
 * Status's and stop's answers on a machine whose engine has the pool's two
 * containers.
 *
 * @param {Machine} machine
 * @param {string} poolFile
 */
async function statusAndStop(machine, poolFile) {
  const { engine, state } = fakeEngine();
  containersPlaced(state);
  const status = await called(["status", "--pool", poolFile], {
    ...machine,
    engine,
  });
  const stop = await called(["stop", "asg-2", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(status.status, 0);
  assert.equal(stop.status, 0, stop.err);
  assert.match(
    stop.out,
    /^chuggy-shame-a was stopped; logs saved to .*, container removed\nstopped asg-2$/u,
  );
  assert.ok(!state.containers.has("chuggy-shame-a"));
  return status.out.split("\n").slice(0, 2).join("\n");
}

test("status and stop of a host pool still run where the runner's file has what no host job can run under, which doctor names", async (t) => {
  const { poolFile, machine } = await machined(t, {
    pool: hostedPool,
    runner: { environment: { USERPROFILE: "C:\\x" } },
  });
  const status = await called(["status", "--pool", poolFile], machine);
  assert.equal(status.status, 0, status.err);
  assert.match(status.out, /^service: not running/u);
  const run = await called(["once", "--pool", poolFile], machine);
  assert.equal(run.status, 1);
  assert.match(run.err, /USERPROFILE is set for every host job/u);
});

test("status and stop believe no record whose lock is not held, stop reaching the container itself", async (t) => {
  const fixture = await machined(t);
  const left = await leftBehind(t, fixture);
  assert.equal(
    await statusAndStop(fixture.machine, fixture.poolFile),
    "service: not running\nlimits: concurrencyMax 1, sessionsMax 2",
  );
  assert.deepEqual(left.stopped, []);
});

/**
 * The pool held by process `holderPid`, whose pipe drops every ask, beside an
 * engine holding the placed containers.
 *
 * @param {import("node:test").TestContext} t
 * @param {Awaited<ReturnType<typeof machined>>} fixture
 */
async function heldUnasked(t, { paths, locks }) {
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await mkdir(runtime, { recursive: true });
  const hold = await poolServiceClaimed(
    runtime,
    holderPid,
    "run",
    locks.locking,
  );
  const hanging = createServer((socket) => socket.destroy());
  await new Promise((resolve) =>
    hanging.listen(hold.pipe, () => resolve(undefined)),
  );
  t.after(() => hanging.close());
  const { engine, state } = fakeEngine();
  containersPlaced(state);
  return { engine, state };
}

test("stop reaches the container itself where what holds the pool cannot be asked", async (t) => {
  const { poolFile, paths, machine, locks } = await machined(t);
  const { engine, state } = await heldUnasked(t, { paths, locks });
  const stop = await called(["stop", "asg-2", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(stop.status, 0, stop.err);
  assert.match(stop.out, /\nstopped asg-2$/u);
  assert.ok(!state.containers.has("chuggy-shame-a"));
});

test("status says what holds the pool could not be asked where it drops the ask, and still lists the containers", async (t) => {
  const { poolFile, paths, machine, locks } = await machined(t);
  const { engine } = await heldUnasked(t, { paths, locks });
  const status = await called(["status", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(status.status, 0, status.err);
  assert.match(
    status.out,
    /^service: holds the pool, but could not be asked: /u,
  );
  assert.match(status.out, /chuggy-shame-a/u);
});

test("status names a job what a service from before sessions answers it is placing, which carries no kind", async (t) => {
  const fixture = await machined(t);
  const { poolFile, machine } = fixture;
  const { assignment, name, image, phase, deadlineEpochSecs } = inFlightFixture;
  await heldBy(t, fixture, fixturePool, {
    inFlight: [{ assignment, name, image, phase, deadlineEpochSecs }],
  });
  const status = await called(["status", "--pool", poolFile], machine);
  assert.equal(status.status, 0);
  assert.equal(
    status.out,
    [
      "service: running",
      "limits: concurrencyMax 1, sessionsMax 2",
      "disk floor: 100 GiB free at C:\\, holding Docker Desktop's disk image, over the floor of 20 GiB",
      "memory: 16 GiB room · 16 GiB budget · 16 GiB ceiling · 0 GiB sessions · Taking",
      `${inFlightFixture.name}  job  pulling  i  asg-1`,
    ].join("\n"),
  );
});

test("status names a job held for room and what it waits for, and the memory it waits on", async (t) => {
  const fixture = await machined(t);
  const { poolFile, machine } = fixture;
  await heldBy(t, fixture, fixturePool, {
    inFlight: [
      {
        ...inFlightFixture,
        kind: "Job",
        phase: "Held",
        memoryMib: 8192,
        waiting: "needs 8 GiB, room 8 GiB",
      },
    ],
  });
  const { engine, state } = fakeEngine();
  state.containers.set("chuggy-jobs-postgres", {
    id: "id-postgres",
    name: "chuggy-jobs-postgres",
    labels: {},
    status: "running",
    image: "postgres",
    usedBytes: 8 * 2 ** 30,
  });
  await engine.exec(
    heldCreateArgv({
      name: `${inFlightFixture.name}-held`,
      pool: "vteng/chuggy/shame",
      assignment: inFlightFixture.assignment,
      memoryMib: 8192,
      heldMs: 1,
      pid: process.pid,
      untilMs: Date.now() + 3_600_000,
      starting: false,
    }),
  );
  const status = await called(["status", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.deepEqual(status.out.split("\n").slice(3), [
    "memory: 0 GiB room · 16 GiB budget · 16 GiB ceiling · 0 GiB sessions · Held",
    `${inFlightFixture.name}  job  held  i  asg-1  waiting: needs 8 GiB, room 8 GiB`,
  ]);
});

/**
 * Catches a run that advertises nothing, or what its pool file recorded in
 * place of what its machine and its file are, and a doctor whose poll
 * changes what the pool advertises.
 */
test("a run advertises its capabilities on each poll, and doctor's poll advertises none", async (t) => {
  /** @type {(string | null)[]} */
  const advertised = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
      advertised.push(
        new globalThis.Headers(init.headers).get("chuggy-capabilities"),
      );
      return globalThis.Response.json({
        assignments: [],
        sessions: [],
        stop: [],
      });
    },
  );
  const { poolFile, machine } = await machined(t, {
    pool: {
      ...fixturePool,
      capabilities: ["Platform:Linux:Amd64", "container"],
      host: true,
    },
    runner: { capabilities: ["gpu"] },
  });
  let acquired = 0;
  const { status } = await called(["run", "--pool", poolFile], {
    ...machine,
    arch: "arm64",
    fetch: globalThis.fetch,
    tokens: {
      acquire: async () =>
        (acquired += 1) <= 2
          ? { acquired: "Token", token: "pool-token" }
          : deniedTokens.acquire(),
      invalidate: () => undefined,
    },
  });
  assert.equal(status, deniedExitStatus);
  assert.deepEqual(
    advertised,
    Array(3).fill(
      "Platform:Linux:Arm64,Platform:Windows:Arm64,gpu,Agent:Claude",
    ),
  );
  advertised.length = 0;
  const doctor = await called(["doctor", "--pool", poolFile], {
    ...machine,
    tokens: ready.tokens,
    plane: null,
  });
  assert.match(
    doctor.out,
    /^ok {4}capabilities: a run advertises Platform:Linux:Amd64, Platform:Windows:Amd64, gpu, Agent:Claude on each poll: /mu,
  );
  assert.deepEqual(advertised, [null]);
});

test("a run makes the job network, answers on the pool's pipe while it runs and ends with the denial's status", async (t) => {
  const { poolFile, paths, machine } = await machined(t);
  const { engine, state } = fakeEngine();
  const { status, out, err } = await called(["run", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(status, deniedExitStatus, err);
  assert.equal(
    out,
    [
      "made the job network chuggy-jobs",
      "the plane denied this pool: the pool was revoked",
    ].join("\n"),
  );
  assert.ok(state.networks.has("chuggy-jobs"));
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  assert.deepEqual(await readdir(runtime), []);
  await assert.rejects(stat(win32.join(runtime, "control.json")), {
    code: "ENOENT",
  });
  const again = await called(["run", "--pool", poolFile], {
    ...machine,
    engine,
  });
  assert.equal(again.out, "the plane denied this pool: the pool was revoked");
});

test("a second run of a pool is refused before it removes anything of the first's", async (t) => {
  const fixture = await machined(t);
  const { runtime } = await heldBy(t, fixture, fixturePool);
  await mkdir(join(runtime, "pull-1-inflight"));
  const { status, err } = await called(
    ["run", "--pool", fixture.poolFile],
    fixture.machine,
  );
  assert.equal(status, 1);
  assert.equal(err, heldLine);
  assert.deepEqual(await readdir(runtime), ["pull-1-inflight"]);
});

// What a holder half wrote is removed by entries read from the runtime
// directory and joined with Windows' separator, which off Windows name
// nothing in it; poolService's suite shows the removal.
test("a run holds a pool whose last run left its record, replacing it", async (t) => {
  const fixture = await machined(t);
  const left = await leftBehind(t, fixture);
  const record = win32.join(left.runtime, "control.json");
  /** @type {unknown[]} */
  const during = [];
  const tokens = {
    acquire: async () => {
      during.push(JSON.parse(await readFile(record, "utf8")).pid);
      return { acquired: "Denied", evidence: "the pool was revoked" };
    },
    invalidate: () => undefined,
  };
  const { status, err } = await called(["run", "--pool", fixture.poolFile], {
    ...fixture.machine,
    tokens,
  });
  assert.equal(status, deniedExitStatus, err);
  assert.deepEqual(during, [process.pid]);
  await assert.rejects(stat(record), { code: "ENOENT" });
  assert.deepEqual(left.stopped, []);
});

test("a run letting go removes its record, then lets go of the lock, and only then stops answering", async (t) => {
  const { poolFile, paths, machine, locks } = await machined(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  const record = win32.join(runtime, "control.json");
  let pipe = "";
  /** @type {unknown[]} */
  const atRelease = [];
  locks.hooks.onRelease = async (file) => {
    if (!file.endsWith("run.lock") || pipe === "") return;
    atRelease.push(existsSync(record), [...locks.held].length);
    atRelease.push(await poolServiceAsked(pipe, { op: "status" }));
  };
  const tokens = {
    acquire: async () => {
      pipe = JSON.parse(await readFile(record, "utf8")).pipe;
      return { acquired: "Denied", evidence: "the pool was revoked" };
    },
    invalidate: () => undefined,
  };
  const { status } = await called(["run", "--pool", poolFile], {
    ...machine,
    tokens,
  });
  assert.equal(status, deniedExitStatus);
  assert.deepEqual(atRelease, [false, 1, { inFlight: [] }]);
  assert.deepEqual([...locks.held], []);
  assert.equal(await poolServiceAsked(pipe, { op: "status" }), undefined);
});

test("the service starts run, and on the plane's denial ends, logging it under the task's name and remembering it, so the next starts nothing", async (t) => {
  const { poolFile, paths, machine } = await machined(t);
  let started = 0;
  /** @type {Machine} */
  const serviced = {
    ...machine,
    startRun: () => {
      started++;
      return {
        lines: (onLine) => onLine("the plane denied this pool"),
        exited: Promise.resolve(deniedExitStatus),
      };
    },
  };
  const first = await called(["service", "--pool", poolFile], serviced);
  assert.equal(first.status, 0, first.err);
  assert.equal(started, 1);
  const log = win32.join(paths.logs, "service-pool.log");
  assert.match(
    await readFile(log, "utf8"),
    /^\S+Z the plane denied this pool\n\S+Z the plane denied C:\\Users\\op\\pool\.json; the service ends until the pool is registered again\n$/u,
  );
  const denied = win32.join(paths.runtime, "service", "pool.denied");
  assert.equal(
    JSON.parse(await readFile(denied, "utf8")).size,
    (await stat(poolFile)).size,
  );
  const second = await called(["service", "--pool", poolFile], serviced);
  assert.equal(second.status, 0);
  assert.equal(started, 1);
  assert.match(
    await readFile(log, "utf8"),
    /\n\S+Z the plane denied C:\\Users\\op\\pool\.json; register the pool again to serve it\n$/u,
  );
});

const registerArgv = [
  "register",
  "--api",
  "https://chuggy.example",
  "--token=registration-token-fixture",
];

/**
 * A machine to register the pool on, with where its file goes and the task
 * that serves it. The core writes the file by its own platform's join, which
 * on Windows is Windows'.
 *
 * @param {import("node:test").TestContext} t
 */
async function registering(t) {
  const fixture = await machined(t);
  const file = join(fixture.paths.pools, "newtenant.arbbot.shame.json");
  return {
    ...fixture,
    file,
    name: "\\chuggy-windows\\newtenant.arbbot.shame",
    /** @param {Machine} [machine] where every check passes unless it says otherwise */
    registered: (machine = {}) =>
      called(registerArgv, {
        ...fixture.machine,
        fetch: answeringFetch(201, registeredFixture).fetch,
        ...ready,
        ...machine,
      }),
  };
}

/**
 * What register says on stderr before doctor's checks, on a machine where it
 * wrote the file.
 *
 * @param {string} file
 */
const checking = (file) =>
  `wrote ${file}, and the token is spent; checking this machine before starting its service`;

/** @param {string} name */
const queried = (name) => serviceQueryArgv(name);

/**
 * @param {string} name
 * @param {string} runtime
 */
const created = (name, runtime) => [
  "schtasks",
  "/Create",
  "/TN",
  name,
  "/XML",
  win32.join(
    runtime,
    `task-${win32.basename(name)}-${String(process.pid)}.xml`,
  ),
  "/F",
];

test("register writes the pool file it redeems the token for, and where every check passes registers its task and runs it, printing no secret", async (t) => {
  const { file, name, paths, tasks, machine } = await registering(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, out, err } = await called(registerArgv, {
    ...machine,
    environment: { ...machine.environment, CHUGGY_WINDOWS_POOL: "C:\\x.json" },
    hostname: "Shame.lan",
    fetch,
    ...ready,
  });
  assert.equal(status, 0, err);
  assert.equal(out, `wrote ${file}; its service is running: started ${name}`);
  assert.equal(err, checking(file));
  assert.deepEqual(tasks.argvs(), [
    queried(name),
    queried(name),
    queried(name),
    created(name, paths.runtime),
    ["schtasks", "/Run", "/TN", name],
  ]);
  assert.equal(
    tasks.tasks.get(name),
    serviceTask(
      { node: copyNode, cli: copyCli, poolFile: file },
      fixtureUserSid,
    ),
  );
  assert.equal(JSON.parse(String(requests[0].init.body)).pool, "shame");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registeredFixture);
  const secret = registeredFixture.clientSecret;
  assert.ok(!`${out}${err}`.includes(secret));
  assert.ok(
    !tasks
      .argvs()
      .flat()
      .some((word) => word.includes(secret)),
  );
  assert.ok(!(tasks.tasks.get(name) ?? "").includes(secret));
});

test("register --personal redeems a member's personal token for their runner's file, named for its tenant and member, asking for no pool", async (t) => {
  const { paths, machine } = await machined(t);
  const { fetch, requests } = answeringFetch(201, registeredPersonalFixture);
  const { status, out } = await called([...registerArgv, "--personal"], {
    ...machine,
    fetch,
    ...ready,
  });
  assert.equal(status, 0);
  const base =
    "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member";
  const file = join(paths.pools, `${base}.json`);
  assert.equal(
    out,
    `wrote ${file}; its service is running: started \\chuggy-windows\\${base}`,
  );
  assert.equal(
    requests[0].url,
    "https://chuggy.example/api/v1/personal-runner-registrations",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    token: "registration-token-fixture",
    capabilities: ["Platform:Linux:Amd64"],
  });
  assert.deepEqual(
    JSON.parse(await readFile(file, "utf8")),
    registeredPersonalFixture,
  );
});

test("register starts nothing where a check fails, and prints the failed check and what is left", async (t) => {
  const { file, name, tasks, registered } = await registering(t);
  const { status, out, err } = await registered({ tokens: deniedTokens });
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since a check failed; next:`,
      `  chuggy-windows doctor --pool ${file}`,
      `  chuggy-windows install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    err,
    [checking(file), "FAIL  pool token: the pool was revoked"].join("\n"),
  );
  assert.deepEqual(tasks.argvs(), [queried(name), queried(name)]);
});

test("register says why and what is left where schtasks cannot register the task, or cannot run it", async (t) => {
  const creating = await registering(t);
  const create = created(creating.name, creating.paths.runtime);
  creating.tasks.failing[create.join(" ")] = {
    stderr: "ERROR: Access is denied.\r\n",
  };
  const uncreated = await creating.registered();
  assert.equal(uncreated.status, 0);
  assert.equal(
    uncreated.out,
    [
      `wrote ${creating.file}; its service is not running, since its task could not be registered; next:`,
      `  chuggy-windows install-service --pool ${creating.file}`,
    ].join("\n"),
  );
  assert.equal(
    uncreated.err,
    [
      checking(creating.file),
      `${create.join(" ")}: ERROR: Access is denied.`,
    ].join("\n"),
  );

  const running = await registering(t);
  const run = `schtasks /Run /TN ${running.name}`;
  running.tasks.failing[run] = { stderr: "ERROR: The task is disabled.\r\n" };
  const unrun = await running.registered();
  assert.equal(unrun.status, 0);
  assert.equal(
    unrun.out,
    [
      `wrote ${running.file}; its service is not running, since ${run} failed; next:`,
      `  ${run}`,
    ].join("\n"),
  );
  assert.equal(
    unrun.err,
    [checking(running.file), `${run}: ERROR: The task is disabled.`].join("\n"),
  );
  assert.ok(running.tasks.tasks.has(running.name));
});

test("register refuses, as install-service does, a task of the file's name serving another pool file, and starts nothing", async (t) => {
  const { file, name, tasks, registered } = await registering(t);
  const elsewhere = "D:\\pools\\newtenant.arbbot.shame.json";
  const definition = serviceTask(
    { node: copyNode, cli: copyCli, poolFile: elsewhere },
    fixtureUserSid,
  );
  tasks.tasks.set(name, definition);
  const { status, out, err } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since its task could not be registered; next:`,
      `  chuggy-windows install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    err,
    [
      checking(file),
      `warn  service task: ${name} serves ${elsewhere}, not this pool file`,
      `the task ${name} serves ${elsewhere}, not ${file}; delete that task if it is stale, or rename the pool file`,
    ].join("\n"),
  );
  assert.deepEqual(tasks.argvs(), [
    queried(name),
    queried(name),
    queried(name),
  ]);
  assert.equal(tasks.tasks.get(name), definition);
});

test("register exits 0 once the file is written, saying why and what is left, whatever it could not ask of Task Scheduler", async (t) => {
  const { file, registered } = await registering(t);
  const { status, out, err } = await registered({
    tasks: async () => {
      throw new Error("schtasks could not be started");
    },
  });
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `wrote ${file}; its service is not running, since it could not be started; next:`,
      `  chuggy-windows doctor --pool ${file}`,
      `  chuggy-windows install-service --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(err, "schtasks could not be started");
});

test("registering a pool its own task here serves registers that task again, then ends, enables and runs it, and checks nothing", async (t) => {
  const { file, name, paths, tasks, registered } = await registering(t);
  tasks.tasks.set(
    name,
    serviceTask(
      { node: "C:\\old\\node.exe", cli: "C:\\old\\cli.mjs", poolFile: file },
      fixtureUserSid,
    ),
  );
  const { status, out, err } = await registered({ tokens: deniedTokens });
  assert.equal(status, 0, err);
  assert.equal(out, `wrote ${file}; its service is running: restarted ${name}`);
  assert.equal(err, "");
  assert.deepEqual(tasks.argvs(), [
    queried(name),
    queried(name),
    created(name, paths.runtime),
    ["schtasks", "/End", "/TN", name],
    ["schtasks", "/Change", "/TN", name, "/ENABLE"],
    ["schtasks", "/Run", "/TN", name],
  ]);
  assert.equal(
    tasks.tasks.get(name),
    serviceTask(
      { node: copyNode, cli: copyCli, poolFile: file },
      fixtureUserSid,
    ),
  );
  const again = await registered();
  assert.equal(
    again.out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
});

test("ending a task that is not running is no failure of a restart", async (t) => {
  const { file, name, registered, tasks } = await registering(t);
  assert.equal((await registered()).status, 0);
  tasks.failing[`schtasks /End /TN ${name}`] = {
    stderr: "ERROR: The scheduled task is not running.\r\n",
  };
  const { status, out, err } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(err, "");
});

test("a restart that fails says where, and leaves the operator every command from that one on", async (t) => {
  const { file, name, tasks, registered } = await registering(t);
  assert.equal((await registered()).status, 0);
  const steps = [
    ["schtasks", "/Change", "/TN", name, "/ENABLE"],
    ["schtasks", "/Run", "/TN", name],
  ];
  for (const [index, failing] of steps.entries()) {
    tasks.failing[failing.join(" ")] = { stderr: "ERROR: Failed.\r\n" };
    const failed = await registered();
    delete tasks.failing[failing.join(" ")];
    assert.equal(failed.status, 0);
    assert.equal(
      failed.out,
      [
        `replaced ${file}; its service is not running, since chuggy denies the pool's earlier registration and ${failing.join(" ")} failed; next:`,
        ...steps.slice(index).map((argv) => `  ${argv.join(" ")}`),
      ].join("\n"),
    );
    assert.equal(failed.err, `${failing.join(" ")}: ERROR: Failed.`);
  }
});

test("a restart whose task cannot be registered again ends, enables and runs nothing, and says what is left", async (t) => {
  const { file, name, paths, tasks, registered } = await registering(t);
  assert.equal((await registered()).status, 0);
  const create = created(name, paths.runtime).join(" ");
  tasks.failing[create] = { stderr: "ERROR: Access is denied.\r\n" };
  tasks.calls.length = 0;
  const { status, out, err } = await registered();
  assert.equal(status, 0);
  assert.equal(
    out,
    [
      `replaced ${file}; its service is not running, since chuggy denies the pool's earlier registration and its task could not be registered; next:`,
      `  chuggy-windows install-service --pool ${file}`,
      `  schtasks /End /TN ${name}`,
      `  schtasks /Run /TN ${name}`,
    ].join("\n"),
  );
  assert.equal(
    err,
    `${create}: ERROR: Access is denied.; a task registered from an elevated PowerShell can be replaced only from one, so run this there, or delete the task there with schtasks /Delete /TN ${name} /F and run this again`,
  );
  assert.deepEqual(tasks.argvs(), [
    queried(name),
    queried(name),
    created(name, paths.runtime),
  ]);
});

test("registering a personal runner its task here serves restarts the task named for its file, and where the restart fails says so of the runner", async (t) => {
  const { paths, tasks, machine } = await machined(t);
  const argv = [...registerArgv, "--personal"];
  const personal = {
    ...machine,
    fetch: answeringFetch(201, registeredPersonalFixture).fetch,
    ...ready,
  };
  const base =
    "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member";
  const name = `\\chuggy-windows\\${base}`;
  const file = join(paths.pools, `${base}.json`);
  assert.equal((await called(argv, personal)).status, 0);
  const again = await called(argv, personal);
  assert.equal(
    again.out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  tasks.failing[`schtasks /Run /TN ${name}`] = {
    stderr: "ERROR: The task is disabled.\r\n",
  };
  const failed = await called(argv, personal);
  assert.equal(failed.status, 0);
  assert.equal(
    failed.out,
    [
      `replaced ${file}; its service is not running, since chuggy denies this personal runner's earlier registration and schtasks /Run /TN ${name} failed; next:`,
      `  schtasks /Run /TN ${name}`,
    ].join("\n"),
  );
});

test("register asked wrongly exits 2 before the token is spent", async (t) => {
  const { paths, machine } = await machined(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  for (const [argv, asked, line] of [
    [registerArgv, { arch: "ia32" }, /^this machine is ia32/u],
    [
      [...registerArgv, "--pool", "Shame"],
      {},
      /^--pool Shame is not a pool name/u,
    ],
    [
      ["register", "--api", "https://chuggy.example"],
      {},
      /^register needs --api and --token$/u,
    ],
    [
      [...registerArgv, "--personal", "--pool", "shame"],
      {},
      /^--pool names a pool, and a personal runner names none/u,
    ],
    [[...registerArgv, "extra"], {}, /^usage: chuggy-windows/u],
    [
      ["run", "--pool", "C:\\p.json", "--token", "t"],
      {},
      /^usage: chuggy-windows/u,
    ],
    [
      ["doctor", "--pool", "C:\\p.json", "--personal"],
      {},
      /^usage: chuggy-windows/u,
    ],
    [
      ["status", "--pool", "C:\\p.json", "--api", "https://chuggy.example"],
      {},
      /^usage: chuggy-windows/u,
    ],
  ]) {
    const { status, err } = await called(argv, { ...machine, fetch, ...asked });
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, line, argv.join(" "));
  }
  assert.deepEqual(requests, []);
  await assert.rejects(stat(paths.pools), { code: "ENOENT" });
});

test("register writes nothing when chuggy refuses the token, and exits 1 with why", async (t) => {
  const { paths, machine } = await machined(t);
  const { status, out, err } = await called(registerArgv, {
    ...machine,
    fetch: answeringFetch(404, { error: { code: "NotFound" } }).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.equal(
    err,
    "the registration token is unknown, spent or expired; mint another in chuggy's console",
  );
  assert.deepEqual(await readdir(paths.pools), []);
});

test("register spends no token where it could not make the pools directory", async (t) => {
  const { paths, machine } = await machined(t);
  await writeFile(paths.pools, "");
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, err } = await called(registerArgv, { ...machine, fetch });
  assert.equal(status, 1);
  assert.match(
    err,
    /cannot be made a directory only you can write, so no token was spent: E(NOTDIR|EXIST)/u,
  );
  assert.deepEqual(requests, []);
});

test("register says the token is spent where chuggy answered but the pool file could not be written", async (t) => {
  const { paths, machine } = await machined(t);
  await mkdir(join(paths.pools, "newtenant.arbbot.shame.json", "blocking"), {
    recursive: true,
  });
  const { status, out, err } = await called(registerArgv, {
    ...machine,
    fetch: answeringFetch(201, registeredFixture).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.match(
    err,
    /^the pool file could not be written, and the token is spent, so mint another: E/u,
  );
  assert.ok(!err.includes(registeredFixture.clientSecret));
  await rm(paths.pools, { recursive: true });
});

test("a token beginning with a dash is taken as --token=<token>, as usage says, and the space form keeps working for one that does not", async (t) => {
  const { machine } = await machined(t);
  const dashed = `-${"a".repeat(42)}`;
  for (const [argv, token] of [
    [
      ["register", "--api", "https://chuggy.example", `--token=${dashed}`],
      dashed,
    ],
    [["register", "--api", "https://chuggy.example", "--token", "t-1"], "t-1"],
  ]) {
    const { fetch, requests } = answeringFetch(201, registeredFixture);
    const { status, err } = await called(argv, { ...machine, fetch });
    assert.equal(status, 0, err);
    assert.equal(JSON.parse(String(requests[0].init.body)).token, token);
  }
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const spaced = await called(
    ["register", "--api", "https://chuggy.example", "--token", dashed],
    { ...machine, fetch },
  );
  assert.equal(spaced.status, 2);
  assert.match(spaced.err, /--token=-XYZ/u);
  assert.deepEqual(requests, []);
  assert.match(
    (await called(["help"])).out,
    /^ {7}chuggy-windows register --api <origin> --token=<token> \[--pool <name> \| --personal\]\n {31}\[--host\] \[--capability <token>\]\.\.\.$/mu,
  );
});

test("run, once, status, stop, service and install-service refuse a directory the runner keeps secrets in that anyone else may open, naming it", async (t) => {
  const { poolFile, paths, acls, machine, tasks } = await machined(t);
  for (const directory of [
    win32.dirname(poolFile),
    paths.runtime,
    paths.logs,
    paths.jobs,
  ]) {
    acls.clear();
    acls.set(directory, usersReadAcl);
    for (const argv of [
      ["run"],
      ["once"],
      ["status"],
      ["stop", "asg-1"],
      ["service"],
      ["install-service"],
    ]) {
      const { status, err } = await called([...argv, "--pool", poolFile], {
        ...machine,
        startRun: () => assert.fail("no run is started"),
      });
      assert.equal(status, 1, argv[0]);
      assert.equal(
        err,
        `the directory ${directory} ${usersRefusal}; the runner keeps secrets there`,
        argv[0],
      );
    }
  }
  assert.deepEqual(tasks.calls, []);
});

test("register refuses a pools directory anyone else may open before it spends the token", async (t) => {
  const { paths, acls, machine } = await machined(t);
  acls.set(paths.pools, usersReadAcl);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const { status, out, err } = await called(registerArgv, {
    ...machine,
    fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.equal(
    err,
    `the directory ${paths.pools} ${usersRefusal}; the pool file's secret would be written there, so no token was spent`,
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(await readdir(paths.pools), []);
});

/**
 * A machine whose pool `register` has already registered and served, its
 * run holding the pool until `register` has waited `waits` times on a clock
 * each wait moves on, and the task calls made by when each wait began.
 *
 * @param {import("node:test").TestContext} t
 * @param {number} [waits]
 */
async function reregistering(t, waits = 0) {
  const fixture = await registering(t);
  const locks = fakeLocking();
  const machine = { locking: locks.locking };
  assert.equal((await fixture.registered(machine)).status, 0);
  const runtime = poolRuntimeDirectory(fixture.paths, registeredFixture);
  const hold =
    waits === 0
      ? undefined
      : await poolServiceClaimed(runtime, holderPid, "run", locks.locking);
  /** @type {number[]} */
  const waited = [];
  let now = 0;
  const clock = {
    ...machine,
    nowMs: () => now,
    sleep: async (/** @type {number} */ ms) => {
      assert.equal(ms, 500);
      waited.push(fixture.tasks.calls.length);
      now += ms;
      if (waited.length === waits) await hold?.release();
    },
  };
  fixture.tasks.calls.length = 0;
  return { ...fixture, runtime, locks, waited, clock };
}

const restartedArgvs = (/** @type {string} */ name) => [
  ["schtasks", "/Change", "/TN", name, "/ENABLE"],
  ["schtasks", "/Run", "/TN", name],
];

test("registering again waits, after ending the task, until its service lets the pool go before running it", async (t) => {
  const { file, name, tasks, registered, waited, clock } = await reregistering(
    t,
    3,
  );
  const { status, out, err } = await registered(clock);
  assert.equal(status, 0);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(err, "");
  const ended = tasks.argvs().findIndex((argv) => argv[1] === "/End");
  assert.deepEqual(waited, [ended + 1, ended + 1, ended + 1]);
  assert.deepEqual(tasks.argvs().slice(ended + 1), restartedArgvs(name));
});

test("registering again runs the task still where its ended service has not let the pool go within the wait, and says so", async (t) => {
  const { file, name, tasks, registered, waited, clock } = await reregistering(
    t,
    Infinity,
  );
  const { status, out, err } = await registered(clock);
  assert.equal(status, 0);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(
    err,
    "the ended service still held the pool after 30s; the new one starts its run once it lets go",
  );
  assert.equal(waited.length, 30_000 / 500);
  assert.deepEqual(tasks.argvs().slice(-2), restartedArgvs(name));
});

test("registering again waits on no record whose lock is not held", async (t) => {
  const { file, name, runtime, registered, waited, clock } =
    await reregistering(t);
  await mkdir(runtime, { recursive: true });
  await writeFile(
    win32.join(runtime, "control.json"),
    JSON.stringify({
      pipe: poolServicePipeFresh(),
      pid: holderPid,
      kind: "run",
    }),
  );
  const { out, err } = await registered(clock);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(err, "");
  assert.deepEqual(waited, []);
});

test("registering again runs the task still where whether its ended service let go could not be asked, and says why", async (t) => {
  const { file, name, paths, tasks, registered, clock, sharedRefusal } =
    await reregistering(t);
  const ended = () => tasks.argvs().some((argv) => argv[1] === "/End");
  const { status, out, err } = await registered({
    ...clock,
    // The runtime directory is found shared only once the task is ended,
    // after install-service's own check of it passed.
    sharedRefusal: async (path) =>
      ended() && path === paths.runtime ? usersRefusal : sharedRefusal(path),
  });
  assert.equal(status, 0);
  assert.equal(
    out,
    `replaced ${file}; its service is running: restarted ${name}`,
  );
  assert.equal(
    err,
    `whether the ended service let go could not be asked: the directory ${paths.runtime} ${usersRefusal}; the runner keeps secrets there`,
  );
  assert.deepEqual(tasks.argvs().slice(-2), restartedArgvs(name));
});

test("a task serving the pool file under another case of its path is the pool file's own, to install-service and to register", async (t) => {
  const { poolFile, machine, tasks } = await machined(t);
  const other = { node: "C:\\old\\node.exe", cli: "C:\\old\\cli.mjs" };
  tasks.tasks.set(
    poolTask,
    serviceTask({ ...other, poolFile: poolFile.toUpperCase() }, fixtureUserSid),
  );
  const installed = await called(
    ["install-service", "--pool", poolFile],
    machine,
  );
  assert.equal(installed.status, 0, installed.err);
  assert.equal(
    tasks.tasks.get(poolTask),
    serviceTask({ node: copyNode, cli: copyCli, poolFile }, fixtureUserSid),
  );

  const again = await registering(t);
  again.tasks.tasks.set(
    again.name,
    serviceTask(
      { ...other, poolFile: again.file.toLowerCase().replaceAll("/", "\\") },
      fixtureUserSid,
    ),
  );
  const { status, out, err } = await again.registered();
  assert.equal(status, 0, err);
  assert.equal(
    out,
    `wrote ${again.file}; its service is running: restarted ${again.name}`,
  );
});

/**
 * Registers the pool on a machine of `arch`, chuggy answering with a pool
 * file declaring `capabilities`, and answers what was posted and written.
 *
 * @param {import("node:test").TestContext} t
 * @param {readonly string[]} extra register's arguments after the token
 * @param {readonly string[]} capabilities
 */
async function registeredAs(t, extra, capabilities, arch = "x64") {
  const { file, machine } = await registering(t);
  const { fetch, requests } = answeringFetch(201, {
    ...registeredFixture,
    capabilities,
  });
  const { status, err } = await called([...registerArgv, ...extra], {
    ...machine,
    arch,
    fetch,
    ...ready,
  });
  assert.equal(status, 0, err);
  return {
    posted: JSON.parse(String(requests[0].init.body)),
    written: JSON.parse(await readFile(file, "utf8")),
  };
}

test("register declares the platform its containers run, then with --host this machine's own, then each --capability, and writes --host into the pool file", async (t) => {
  const declared = ["Agent:Claude", "Tool:Bazel"];
  const flags = declared.flatMap((capability) => ["--capability", capability]);
  for (const [extra, arch, capabilities] of [
    [flags, "x64", ["Platform:Linux:Amd64", ...declared]],
    [
      ["--host", ...flags],
      "x64",
      ["Platform:Linux:Amd64", "Platform:Windows:Amd64", ...declared],
    ],
    [["--host"], "arm64", ["Platform:Linux:Arm64", "Platform:Windows:Arm64"]],
  ]) {
    const hosted = extra.includes("--host");
    const { posted, written } = await registeredAs(
      t,
      extra,
      capabilities,
      arch,
    );
    assert.deepEqual(posted.capabilities, capabilities);
    assert.equal("host" in posted, false);
    assert.deepEqual(written, {
      ...registeredFixture,
      capabilities,
      ...(hosted ? { host: true } : {}),
    });
  }
});

test("register --host on a machine no pool runs work on the host of is refused before the token is spent", async (t) => {
  const { paths, machine } = await machined(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  const refused = await called([...registerArgv, "--host"], {
    ...machine,
    arch: "riscv64",
    fetch,
  });
  assert.equal(refused.status, 2);
  assert.equal(
    refused.err,
    "this machine is riscv64, and no pool runs work on the host of one",
  );
  assert.deepEqual(requests, []);
  await assert.rejects(stat(paths.pools), { code: "ENOENT" });
});

test("a --capability that is a platform, named twice or not a capability is refused before the token is spent, and no other command takes --host or --capability", async (t) => {
  const { paths, machine } = await machined(t);
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  for (const [extra, why] of [
    [
      ["--capability", "Platform:Windows:Amd64"],
      "--capability Platform:Windows:Amd64 names a platform, which register finds of this machine",
    ],
    [
      ["--capability", "Tool:Bazel", "--capability", "Tool:Bazel"],
      "--capability names one capability twice",
    ],
    [
      ["--capability", "has space"],
      "--capability has space is not a capability: letters, digits, _, : and -, beginning with a letter or digit",
    ],
  ]) {
    const { status, err } = await called([...registerArgv, ...extra], {
      ...machine,
      fetch,
    });
    assert.equal(status, 2, extra.join(" "));
    assert.equal(err, why);
  }
  assert.deepEqual(requests, []);
  await assert.rejects(stat(paths.pools), { code: "ENOENT" });
  for (const argv of [
    ["status", "--pool", "C:\\p.json", "--capability", "Tool:Bazel"],
    ["run", "--pool", "C:\\p.json", "--host"],
    ["install-service", "--pool", "C:\\p.json", "--host"],
  ]) {
    const { status, err } = await called(argv, machine);
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, /^usage: chuggy-windows/u);
  }
});

test("doctor tells a pool registered with --host that its imageless jobs run on this machine", async (t) => {
  const { machine, environment } = await machined(t, { pool: hostedPool });
  const { status, out } = await called(
    ["doctor", "--pool", "C:\\Users\\op\\pool.json"],
    { ...machine, ...ready, environment },
  );
  assert.equal(status, 0);
  assert.match(
    out,
    /^ok {4}host jobs: a job that pins no image and names this machine's platform runs on the machine itself, as this account, unisolated$/mu,
  );
});
