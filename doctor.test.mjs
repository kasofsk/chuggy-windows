import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { win32 } from "node:path";
import test from "node:test";

import {
  chatHostControl,
  chatSupervisorName,
} from "@chuggy/worker-core/chatHost.mjs";
import { controlServer } from "@chuggy/worker-core/control.mjs";
import { hostTimeoutSecsMax } from "@chuggy/worker-core/hostBackend.mjs";

import { doctorFindings, findingLine } from "./doctor.mjs";
import { poolProjectDigest } from "@chuggy/worker-core/poolIdentity.mjs";

import { fakeDisk, fakeEngine } from "./engine.fixture.mjs";
import { poolServiceClaimed } from "./poolService.mjs";
import { registeredChatHostFixture } from "./register.fixture.mjs";
import { poolRuntimeDirectory } from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import {
  fakeLocking,
  fixturePool,
  fixtureUserSid,
  poolFileWritten,
  runnerFixture,
  usersReadAcl,
  usersRefusal,
  hostedPool,
  tokenAloneWritten,
} from "./runner.fixture.mjs";
import { serviceQueryArgv, serviceTask } from "./serviceTask.mjs";
import { fakeTaskScheduler } from "./taskScheduler.fixture.mjs";

/** The copy doctor is run as, and the Node it runs under. */
const copy = {
  arch: "x64",
  node: "C:\\Program Files\\nodejs\\node.exe",
  cli: "C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\chuggy-windows\\cli.mjs",
};

const taskName = "\\chuggy-windows\\pool";

/**
 * @typedef {object} DoctoredOptions
 * @property {Record<string, unknown> | undefined} [runner] the runner's file, or none where it is `undefined`
 * @property {Record<string, unknown>} [pool]
 * @property {string} [poolFileName] a pool file in the profile to ask of in place of the fixture's
 * @property {unknown} [token] what the issuer answers
 * @property {unknown} [polled] what the plane answers
 * @property {(engine: import("./engine.fixture.mjs").FakeEngineState) => void} [engine] what the engine answers
 * @property {import("./diskFree.mjs").DiskFreePorts} [disk] what the free disk is measured by, 100 GiB free everywhere where none
 * @property {(poolFile: string) => string} [task] the definition of the task of the pool file's name, where there is one
 * @property {readonly string[]} [alsoMade] other directories made, by path
 * @property {Record<string, string>} [files] other files written, by path, with their text
 * @property {readonly ("pool" | "runtime" | "logs" | "jobs")[]} [made] which of the runner's directories are made: the pool file's, the runtime directory, the logs and the host jobs'
 * @property {(acls: Map<string, import("./windowsAcl.mjs").Acl>, files: {poolFile: string, config: string, tokenFile: string, pool: string, runtime: string, logs: string, jobs: string}) => void} [shared] who else may open which file
 * @property {(home: string) => Promise<unknown>} [before] what else is made under the profile before doctor runs
 * @property {import("./poolService.mjs").PoolLocking} [locking] how a pool's lock is taken, a lock no one holds where none
 */

/**
 * What doctor reaches: the fake engine, and an issuer and a plane answering
 * as `options` says, every poll recorded in `polls`.
 *
 * @param {DoctoredOptions} options
 * @param {import("@chuggy/worker-core/engine.mjs").Engine} engine
 * @param {unknown[][]} polls
 * @returns {import("./doctor.mjs").DoctorParts}
 */
function issuerAndPlane(options, engine, polls) {
  return {
    engine: () => engine,
    tokens: () => ({
      acquire: async () =>
        /** @type {any} */ (options.token) ?? {
          acquired: "Token",
          token: "pool-token",
        },
      invalidate: () => undefined,
    }),
    plane: () => ({
      poll: async (token, held, wanted, wantedSessions) => {
        polls.push([token, held, wanted, wantedSessions]);
        return (
          /** @type {any} */ (options.polled) ?? {
            polled: "Reconciled",
            assignments: [],
            stop: [],
          }
        );
      },
      settle: async () => "Settled",
    }),
  };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {DoctoredOptions} options
 */
async function doctored(t, options = {}) {
  const fixture = await runnerFixture(t, {
    ...("runner" in options ? { runner: options.runner } : {}),
    pool: options.pool,
  });
  const poolFile =
    options.poolFileName === undefined
      ? fixture.poolFile
      : await poolFileWritten(
          win32.join(fixture.home, options.poolFileName),
          JSON.parse(JSON.stringify(options.pool ?? {})),
        );
  const directories = {
    pool: win32.dirname(poolFile),
    runtime: fixture.paths.runtime,
    logs: fixture.paths.logs,
    jobs: fixture.paths.jobs,
  };
  for (const made of [
    ...(options.made ?? []).map((name) => directories[name]),
    ...(options.alsoMade ?? []),
  ])
    await mkdir(made, { recursive: true });
  for (const [path, text] of Object.entries(options.files ?? {}))
    await writeFile(path, text);
  await options.before?.(fixture.home);
  options.shared?.(fixture.acls, {
    poolFile,
    config: fixture.paths.config,
    tokenFile: fixture.tokenFile,
    ...directories,
  });
  const { engine, state } = fakeEngine();
  options.engine?.(state);
  const scheduler = fakeTaskScheduler();
  if (options.task !== undefined)
    scheduler.tasks.set(taskName, options.task(poolFile));
  /** @type {unknown[][]} */
  const polls = [];
  const findings = await doctorFindings({
    poolFile,
    paths: fixture.paths,
    sharedRefusal: fixture.sharedRefusal,
    tasks: scheduler.scheduler,
    ...copy,
    disk: options.disk ?? fakeDisk(100),
    locking: options.locking ?? fakeLocking().locking,
    parts: issuerAndPlane(options, engine, polls),
  });
  return {
    ...fixture,
    findings,
    state,
    polls,
    poolFile,
    scheduler,
    directories,
  };
}

/**
 * @param {import("./doctor.mjs").DoctorFinding[]} findings
 * @param {string} check
 */
const finding = (findings, check) =>
  findings.find((found) => found.check === check);

/**
 * What doctor finds the fixture's pool advertises: the platform its
 * containers run and the `container` it was registered with.
 *
 * @param {import("./runnerConfig.mjs").RunnerPaths} paths
 */
const advertisedFrom = (paths) =>
  `a run advertises Platform:Linux:Amd64, container on each poll: the platforms it runs, the agents ${paths.config} can run, and the rest of what the pool was registered with`;

/** What doctor finds of the fixture's issuer and plane, each answering. */
const planeFound = [
  {
    check: "pool token",
    passed: true,
    detail: "issued by https://issuer.chuggy.example/oauth2/token",
  },
  {
    check: "plane",
    passed: true,
    detail: "https://chuggy.example/pool answered a poll",
  },
];

/** What the disk floor finds of a fake disk with 100 GiB free everywhere. */
const diskOver =
  "100 GiB free at C:\\, holding Docker Desktop's disk image, over the floor of 20 GiB";

test("a machine ready to run passes every check, and doctor changes nothing", async (t) => {
  const { findings, state, polls, poolFile, paths, tokenFile, scheduler } =
    await doctored(t);
  assert.deepEqual(findings, [
    {
      check: "pool file",
      passed: true,
      detail: `${poolFile} names pool vteng/chuggy/shame`,
    },
    {
      check: "runner configuration",
      passed: true,
      detail: `${paths.config}: concurrencyMax 1, sessionsMax 2`,
    },
    {
      check: "runner directories",
      passed: true,
      detail: `C:\\Users\\op, ${paths.runtime}, ${paths.logs}, ${paths.jobs} are this account's alone, or are made where they will be`,
    },
    {
      check: "Claude token file",
      passed: true,
      detail: `${tokenFile}, this account's own`,
    },
    {
      check: "service task",
      passed: true,
      detail: `none yet named ${taskName}`,
    },
    { check: "capabilities", passed: true, detail: advertisedFrom(paths) },
    {
      check: "container engine",
      passed: true,
      detail:
        "docker at npipe:////./pipe/dockerDesktopLinuxEngine, on 8 CPUs and 15854 MiB, lists 0 of this pool's containers",
    },
    { check: "engine socket", passed: true, detail: "off" },
    {
      check: "job network",
      passed: true,
      detail: "chuggy-jobs is missing, and a run makes it",
    },
    { check: "volumes", passed: true, detail: "none" },
    { check: "disk floor", passed: true, detail: diskOver },
    ...planeFound,
  ]);
  assert.deepEqual(polls, [["pool-token", [], 0, 0]]);
  for (const directory of [paths.runtime, paths.logs, paths.jobs])
    await assert.rejects(stat(directory), { code: "ENOENT" });
  assert.deepEqual(
    state.calls.map((call) => call.argv.slice(0, 2)),
    [
      ["info", "--format"],
      ["context", "inspect"],
      ["info", "--format"],
      ["ps", "--all"],
      ["network", "inspect"],
      ["info", "--format"],
    ],
  );
  assert.deepEqual(scheduler.argvs(), [serviceQueryArgv(taskName)]);
});

test("the disk floor is warned of where the free disk is under it, or where Docker Desktop's VM could not be measured, and fails where the drive could not be", async (t) => {
  const under = await doctored(t, {
    runner: { diskFreeGibMin: 30 },
    disk: fakeDisk(80, 20),
  });
  assert.deepEqual(finding(under.findings, "disk floor"), {
    check: "disk floor",
    passed: true,
    warning: true,
    detail:
      "20 GiB free at /mnt/docker-desktop-disk in Docker Desktop's VM, under the floor of 30 GiB: the service removes the images it may and takes no job until it is over",
  });
  const unmeasured = await doctored(t, {
    disk: fakeDisk(50, "There is no distribution with the supplied name."),
  });
  assert.deepEqual(finding(unmeasured.findings, "disk floor"), {
    check: "disk floor",
    passed: true,
    warning: true,
    detail:
      "50 GiB free at C:\\, holding Docker Desktop's disk image, over the floor of 20 GiB; only that, since Docker Desktop's VM could not be measured at /mnt/docker-desktop-disk: There is no distribution with the supplied name.",
  });
  const noDrive = await doctored(t, { disk: fakeDisk("ENOENT: gone", 300) });
  assert.deepEqual(finding(noDrive.findings, "disk floor"), {
    check: "disk floor",
    passed: false,
    detail:
      "300 GiB free at /mnt/docker-desktop-disk in Docker Desktop's VM, over the floor of 20 GiB; only that, since the drive holding Docker Desktop's disk image could not be measured at C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk: ENOENT: gone; set dockerDiskDirectory to the directory holding docker_data.vhdx",
  });
  const off = await doctored(t, {
    runner: { diskFreeGibMin: 0 },
    disk: fakeDisk(1),
  });
  assert.deepEqual(finding(off.findings, "disk floor"), {
    check: "disk floor",
    passed: true,
    detail: "none: the runner's file sets diskFreeGibMin to 0",
  });
});

test("doctor names a personal runner's file as one, by its tenant and member", async (t) => {
  const { findings, poolFile } = await doctored(t, {
    pool: {
      kind: "Personal",
      tenant: "vteng",
      owner: "28:https://auth.chuggy.example/0f3c9a52-member",
      capabilities: ["container"],
      tokenUrl: "https://issuer.chuggy.example/oauth2/token",
      audience: "https://chuggy.example",
      planeUrl: "https://chuggy.example/pool",
      clientId: "personal-client",
      clientSecret: "personal-client-secret",
    },
  });
  assert.deepEqual(findings[0], {
    check: "pool file",
    passed: true,
    detail: `${poolFile} names personal runner vteng/28:https:%2F%2Fauth.chuggy.example%2F0f3c9a52-member`,
  });
});

test("a check that failed says why, and what depends on it is not checked", async (t) => {
  const { findings, state } = await doctored(t, {
    runner: undefined,
    token: {
      acquired: "Denied",
      evidence: "the issuer refused the pool's client credential",
    },
  });
  assert.deepEqual(
    findings.map((found) => [found.check, found.passed]),
    [
      ["pool file", true],
      ["runner configuration", false],
      ["runner directories", true],
      ["service task", true],
      ["pool token", false],
    ],
  );
  assert.match(findings[1].detail, /ENOENT/u);
  assert.equal(
    findings[4].detail,
    "the issuer refused the pool's client credential",
  );
  assert.deepEqual(state.calls, []);
});

test("a pool file that cannot be read leaves the engine and the plane unchecked, and the task still checked", async (t) => {
  const { findings, state, polls } = await doctored(t, {
    pool: { tenant: "vteng" },
  });
  assert.deepEqual(
    findings.map((found) => [found.check, found.passed]),
    [
      ["pool file", false],
      ["runner configuration", true],
      ["runner directories", true],
      ["Claude token file", true],
      ["service task", true],
    ],
  );
  assert.match(findings[0].detail, /^pool credentials .*: project /u);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(polls, []);
});

test("a pool file, runner's file or Claude token file anyone else may open fails its check, naming who", async (t) => {
  const { findings, poolFile, paths } = await doctored(t, {
    shared: (acls, files) => {
      for (const file of [files.poolFile, files.config, files.tokenFile])
        acls.set(file, usersReadAcl);
    },
  });
  assert.deepEqual(
    findings.filter((found) => !found.passed),
    [
      {
        check: "pool file",
        passed: false,
        detail: `pool credentials ${poolFile} ${usersRefusal}`,
      },
      {
        check: "runner configuration",
        passed: false,
        detail: `runner configuration ${paths.config} ${usersRefusal}`,
      },
    ],
  );
  assert.equal(finding(findings, "Claude token file"), undefined);
  const token = await doctored(t, {
    shared: (acls, files) => acls.set(files.tokenFile, usersReadAcl),
  });
  assert.deepEqual(finding(token.findings, "Claude token file"), {
    check: "Claude token file",
    passed: false,
    detail: `the Claude token file ${token.tokenFile} ${usersRefusal}`,
  });
});

test("a Claude token file that is not there fails its check, saying what to save there", async (t) => {
  const { findings } = await doctored(t, {
    runner: { claudeTokenFile: "C:\\Users\\op\\missing-token" },
  });
  assert.deepEqual(finding(findings, "Claude token file"), {
    check: "Claude token file",
    passed: false,
    detail:
      "the Claude token file C:\\Users\\op\\missing-token cannot be found; save `claude setup-token`'s output there",
  });
});

test("an engine that is not Docker Desktop as it comes fails the engine check, and the job network is not checked", async (t) => {
  for (const [configure, detail] of [
    [
      (/** @type {any} */ state) => {
        state.securityOptions = ["name=rootless"];
      },
      "docker is running rootless, where a job cannot read the Claude token file; use Docker Desktop as it comes",
    ],
    [
      (/** @type {any} */ state) => {
        state.contextHost = "tcp://192.0.2.10:2376";
      },
      "docker's context names \"tcp://192.0.2.10:2376\", and only a local docker, reached by a named pipe as Docker Desktop's is, is supported",
    ],
    [
      (/** @type {any} */ state) => {
        state.machine = undefined;
      },
      "docker could not say what its machine has: Error: cannot read the machine",
    ],
  ]) {
    const { findings } = await doctored(t, { engine: configure });
    assert.deepEqual(finding(findings, "container engine"), {
      check: "container engine",
      passed: false,
      detail,
    });
    assert.equal(finding(findings, "job network"), undefined);
    assert.equal(finding(findings, "plane")?.passed, true);
  }
});

test("Docker Desktop not running fails the engine check, saying so", async (t) => {
  const { findings } = await doctored(t, {
    engine: (state) => {
      state.unreachable = true;
    },
  });
  assert.match(
    finding(findings, "container engine")?.detail ?? "",
    /^docker could not be asked, so Docker Desktop may not be running: error during connect: /u,
  );
});

test("the job network passes where it is present, and fails where it cannot be inspected", async (t) => {
  const present = await doctored(t, {
    engine: (state) => state.networks.add("chuggy-jobs"),
  });
  assert.deepEqual(finding(present.findings, "job network"), {
    check: "job network",
    passed: true,
    detail: "chuggy-jobs is present",
  });
  const unread = await doctored(t, {
    engine: (state) => {
      state.networkInspectFails = "Error response from daemon: denied";
    },
  });
  assert.deepEqual(finding(unread.findings, "job network"), {
    check: "job network",
    passed: false,
    detail: "Error response from daemon: denied",
  });
});

test("a plane that rejects the token just issued, or answers otherwise, fails the plane check", async (t) => {
  const stale = await doctored(t, {
    polled: { polled: "Stale", evidence: "expired" },
  });
  assert.deepEqual(finding(stale.findings, "plane"), {
    check: "plane",
    passed: false,
    detail: "the plane rejected a token the issuer had just issued",
  });
  const down = await doctored(t, {
    polled: { polled: "Unavailable", evidence: "the plane answered 503" },
  });
  assert.equal(
    finding(down.findings, "plane")?.detail,
    "the plane answered 503",
  );
});

/**
 * The service task finding of a machine whose pool file's task `definition`
 * defines, or that has none.
 *
 * @param {import("node:test").TestContext} t
 * @param {(poolFile: string) => string} [definition]
 */
async function taskFound(t, definition) {
  const found = await doctored(t, { task: definition });
  return { ...found, found: finding(found.findings, "service task") };
}

test("the pool file's task passes where it runs this copy under this Node", async (t) => {
  const same = await taskFound(t, (poolFile) =>
    serviceTask({ ...copy, poolFile }, fixtureUserSid),
  );
  assert.deepEqual(same.found, {
    check: "service task",
    passed: true,
    detail: `${taskName} runs this copy under this Node`,
  });
});

test("a task running another install, or this one under another Node, is warned of with what makes it run this one, and passes", async (t) => {
  const elsewhere = "C:\\Users\\op\\chuggy-windows\\cli.mjs";
  for (const other of [
    { node: "C:\\nodejs\\node.exe", cli: elsewhere },
    { node: "C:\\nodejs\\node.exe", cli: copy.cli },
    { node: copy.node, cli: elsewhere },
  ]) {
    const { found, findings, poolFile } = await taskFound(t, (served) =>
      serviceTask({ ...other, poolFile: served }, fixtureUserSid),
    );
    assert.deepEqual(found, {
      check: "service task",
      passed: true,
      warning: true,
      detail: `${taskName} runs ${other.cli} under ${other.node}, not this copy under this Node; to have it run this one: 'C:\\Program Files\\nodejs\\node.exe' ${copy.cli} install-service --pool ${poolFile}; schtasks /End /TN ${taskName}; schtasks /Run /TN ${taskName}`,
    });
    assert.ok(findings.every((each) => each.passed));
  }
});

test("a task this runner cannot read back, one serving another pool file, and a pool file whose name makes no task name are each warned of, and pass", async (t) => {
  const edited = await taskFound(t, (poolFile) =>
    serviceTask({ ...copy, poolFile }, fixtureUserSid).replace(
      "<Command>conhost.exe</Command>",
      "<Command>node.exe</Command>",
    ),
  );
  assert.deepEqual(edited.found, {
    check: "service task",
    passed: true,
    warning: true,
    detail: `${taskName} runs a command this runner cannot read back, so which copy it runs is unknown`,
  });
  const serving = await taskFound(t, () =>
    serviceTask({ ...copy, poolFile: "D:\\pools\\pool.json" }, fixtureUserSid),
  );
  assert.deepEqual(serving.found, {
    check: "service task",
    passed: true,
    warning: true,
    detail: `${taskName} serves D:\\pools\\pool.json, not this pool file`,
  });
  const unnamed = await doctored(t, { poolFileName: "my pool.json" });
  assert.deepEqual(finding(unnamed.findings, "service task"), {
    check: "service task",
    passed: true,
    warning: true,
    detail: `${unnamed.poolFile} makes a task name with a character other than a letter, digit, ".", "_" or "-"; give the pool file such a name`,
  });
  assert.deepEqual(unnamed.scheduler.calls, []);
});

test("a finding is printed as passed, failed or warned of", () => {
  assert.equal(
    findingLine({ check: "plane", passed: false, detail: "down" }),
    "FAIL  plane: down",
  );
  assert.equal(
    findingLine({ check: "plane", passed: true, detail: "up" }),
    "ok    plane: up",
  );
  assert.equal(
    findingLine({
      check: "service task",
      passed: true,
      warning: true,
      detail: "x",
    }),
    "warn  service task: x",
  );
});

/** What the runner directories finding says where none is refused. */
const directoriesPassed = (/** @type {Record<string, string>} */ made) =>
  `${made.pool}, ${made.runtime}, ${made.logs}, ${made.jobs} are this account's alone, or are made where they will be`;

test("the runner's directories pass where each is this account's alone, made or not, and doctor makes none", async (t) => {
  const all = await doctored(t, { made: ["pool", "runtime", "logs", "jobs"] });
  const { pool, runtime, logs, jobs } = all.directories;
  assert.deepEqual(finding(all.findings, "runner directories"), {
    check: "runner directories",
    passed: true,
    detail: directoriesPassed(all.directories),
  });
  for (const directory of [pool, runtime, logs, jobs])
    assert.ok(all.asked.includes(directory), directory);
  const none = await doctored(t);
  assert.deepEqual(finding(none.findings, "runner directories"), {
    check: "runner directories",
    passed: true,
    detail: directoriesPassed(none.directories),
  });
  for (const directory of Object.values(none.directories))
    await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("a runner directory not made yet is answered by the nearest directory above it, which fails it where anyone else may open that, naming both", async (t) => {
  const local = "C:\\Users\\op\\AppData\\Local";
  const fine = await doctored(t, { alsoMade: [local] });
  assert.equal(finding(fine.findings, "runner directories")?.passed, true);
  assert.ok(fine.asked.includes(local));
  assert.ok(!fine.asked.includes(fine.directories.runtime));
  const shared = await doctored(t, {
    alsoMade: [local],
    shared: (acls) => acls.set(local, usersReadAcl),
  });
  assert.deepEqual(finding(shared.findings, "runner directories"), {
    check: "runner directories",
    passed: false,
    detail: `${shared.directories.runtime}, made under ${local}, which ${usersRefusal}; the runner keeps secrets there`,
  });
  await assert.rejects(stat(shared.directories.runtime), { code: "ENOENT" });
});

test("a runner directory anyone else may open fails its check, the first such named, and the checks after it still run", async (t) => {
  for (const shared of /** @type {const} */ ([
    "pool",
    "runtime",
    "logs",
    "jobs",
  ])) {
    const { findings, directories } = await doctored(t, {
      made: ["pool", "runtime", "logs", "jobs"],
      shared: (acls, files) => {
        acls.set(files[shared], usersReadAcl);
        if (shared === "pool") acls.set(files.logs, usersReadAcl);
      },
    });
    assert.deepEqual(finding(findings, "runner directories"), {
      check: "runner directories",
      passed: false,
      detail: `${directories[shared]} ${usersRefusal}; the runner keeps secrets there`,
    });
    assert.equal(finding(findings, "plane")?.passed, true, shared);
  }
});

test("a task naming this pool file, this Node and this CLI in another case of their paths runs this copy", async (t) => {
  const { found } = await taskFound(t, (poolFile) =>
    serviceTask(
      {
        node: copy.node.toUpperCase(),
        cli: copy.cli.toLowerCase(),
        poolFile: poolFile.toUpperCase(),
      },
      fixtureUserSid,
    ),
  );
  assert.deepEqual(found, {
    check: "service task",
    passed: true,
    detail: `${taskName} runs this copy under this Node`,
  });
});

test("a pool registered with --host is told its imageless jobs run on this machine as this account, after the token file and before the task", async (t) => {
  const { findings } = await doctored(t, { pool: hostedPool });
  const checks = findings.map((found) => found.check);
  assert.deepEqual(
    checks.slice(
      checks.indexOf("Claude token file"),
      checks.indexOf("Claude token file") + 3,
    ),
    ["Claude token file", "host jobs", "service task"],
  );
  assert.deepEqual(finding(findings, "host jobs"), {
    check: "host jobs",
    passed: true,
    detail:
      "a job that pins no image and names this machine's platform runs on the machine itself, as this account, unisolated",
  });
  assert.ok(findings.every((found) => found.passed));
  const unhosted = await doctored(t);
  assert.equal(finding(unhosted.findings, "host jobs"), undefined);
  const unread = await doctored(t, { pool: hostedPool, runner: undefined });
  assert.equal(finding(unread.findings, "host jobs"), undefined);
});

test("doctor warns whenever jobs are handed Docker Desktop's engine, saying what every job can then reach", async (t) => {
  const { findings } = await doctored(t, { runner: { engineSocket: true } });
  const found = finding(findings, "engine socket");
  assert.equal(found?.passed, true);
  assert.equal(found?.warning, true);
  assert.match(
    found?.detail ?? "",
    /^on: each job reaches Docker Desktop's engine at \/var\/run\/docker\.sock in root's group/u,
  );
  assert.match(found?.detail ?? "", /your user folder/u);
});

test("a pool file that says host but declares no Windows platform is warned of, since no job would run on this machine", async (t) => {
  const { findings } = await doctored(t, {
    pool: {
      ...hostedPool,
      capabilities: hostedPool.capabilities.filter(
        (capability) => !capability.startsWith("Platform:Windows:"),
      ),
    },
  });
  assert.deepEqual(finding(findings, "host jobs"), {
    check: "host jobs",
    passed: true,
    warning: true,
    detail:
      "the pool file says host, but declares no Windows platform, so no job runs on this machine itself; register again with --host",
  });
});

test("a runner's file a host job cannot run under fails the host jobs check: an environment naming a place the job is given, whatever its case, or a cap past the host's", async (t) => {
  for (const name of ["HOME", "TMPDIR", "USERPROFILE", "Temp", "tmp"]) {
    const { findings } = await doctored(t, {
      pool: hostedPool,
      runner: { environment: { KEPT: "x", [name]: "C:\\elsewhere" } },
    });
    assert.deepEqual(
      finding(findings, "host jobs"),
      {
        check: "host jobs",
        passed: false,
        detail: `${name} is set for every host job, and the owner's environment cannot name it`,
      },
      name,
    );
  }
  const { findings } = await doctored(t, {
    pool: hostedPool,
    runner: { timeoutSecsMax: hostTimeoutSecsMax + 1 },
  });
  assert.deepEqual(finding(findings, "host jobs"), {
    check: "host jobs",
    passed: false,
    detail: `timeoutSecsMax is at most ${String(hostTimeoutSecsMax)} for a job on this machine itself`,
  });
  const atCap = await doctored(t, {
    pool: hostedPool,
    runner: { timeoutSecsMax: hostTimeoutSecsMax },
  });
  assert.equal(finding(atCap.findings, "host jobs")?.passed, true);
});

test("a pool registered with --host advertises this machine's platform beside its containers', and the agent it runs here; a file declaring too much fails", async (t) => {
  const hosted = await doctored(t, { pool: hostedPool });
  assert.deepEqual(finding(hosted.findings, "capabilities"), {
    check: "capabilities",
    passed: true,
    detail: `a run advertises Platform:Linux:Amd64, Platform:Windows:Amd64, Agent:Claude on each poll: the platforms it runs, the agents ${hosted.paths.config} can run, and the rest of what the pool was registered with`,
  });
  const declared = await doctored(t, {
    runner: { capabilities: ["gpu", "Agent:Claude"] },
  });
  assert.equal(
    finding(declared.findings, "capabilities")?.detail,
    `a run advertises Platform:Linux:Amd64, gpu, Agent:Claude on each poll: the platforms it runs, the agents ${declared.paths.config} can run, and its capabilities`,
  );
  const crowded = await doctored(t, {
    runner: {
      capabilities: Array.from({ length: 64 }, (_, at) => `c${String(at)}`),
    },
  });
  assert.deepEqual(finding(crowded.findings, "capabilities"), {
    check: "capabilities",
    passed: false,
    detail: `runner configuration ${crowded.paths.config}: capabilities: this runner would advertise 65 capabilities, its platforms and agents among them, and a pool advertises at most 64`,
  });
});

const projectMount = {
  source: "sccache",
  target: "/cache/sccache",
  scope: "project",
};
const projectVolume = `sccache-${String(poolProjectDigest(fixturePool))}`;

/**
 * The labels of a volume a runner made as a project's.
 *
 * @param {string} project
 */
const projectLabels = (project) => ({
  "io.chuggy.owner-volume": "",
  "io.chuggy.owner-volume.project": project,
});

test("doctor finds each named volume a job mounts, one listed as its project's by its name for the pool's project, there labelled as that project's or for the first job to make", async (t) => {
  for (const [volumes, detail] of [
    [new Map([["cargo", {}]]), "cargo at /cache/cargo, read-only, present"],
    [
      new Map([[projectVolume, projectLabels("vteng/chuggy")]]),
      `${projectVolume} at /cache/sccache, vteng/chuggy's alone, present`,
    ],
    [
      new Map(),
      `${projectVolume} at /cache/sccache, vteng/chuggy's alone, missing until the first job started through chuggy's runtime makes it`,
    ],
  ]) {
    const unscoped = volumes.has("cargo");
    const { findings } = await doctored(t, {
      runner: {
        volumes: [
          unscoped
            ? { source: "cargo", target: "/cache/cargo", readonly: true }
            : projectMount,
        ],
      },
      engine: (state) => {
        state.volumes = volumes;
      },
    });
    assert.deepEqual(finding(findings, "volumes"), {
      check: "volumes",
      passed: true,
      detail,
    });
  }
});

test("doctor fails a volume another project's label marks where it is listed as its project's, and names a personal runner's as each job's own without looking for it", async (t) => {
  const foreign = await doctored(t, {
    runner: { volumes: [projectMount] },
    engine: (state) => {
      state.volumes.set(projectVolume, projectLabels("vteng/other"));
    },
  });
  assert.deepEqual(finding(foreign.findings, "volumes"), {
    check: "volumes",
    passed: false,
    detail: `${projectVolume} is labelled as vteng/other's, not vteng/chuggy's`,
  });
  const personal = await doctored(t, {
    pool: {
      kind: "Personal",
      tenant: "vteng",
      owner: "28:https://auth.chuggy.example/0f3c9a52-member",
      capabilities: ["container"],
      tokenUrl: "https://issuer.chuggy.example/oauth2/token",
      audience: "https://chuggy.example",
      planeUrl: "https://chuggy.example/pool",
      clientId: "personal-client",
      clientSecret: "personal-client-secret",
    },
    runner: { volumes: [projectMount] },
  });
  assert.deepEqual(finding(personal.findings, "volumes"), {
    check: "volumes",
    passed: true,
    detail:
      "sccache is scoped per project: each job mounts its own project's, which, where it is missing, the first job in that project started through chuggy's runtime makes",
  });
  assert.deepEqual(
    personal.state.calls.filter(({ argv }) => argv[0] === "volume"),
    [],
  );
});

test("doctor holds the Codex credential to the rule a run does and reads it as a JSON object, and warns where this pool would not reach Codex jobs, or reaches them with the Claude token file", async (t) => {
  const authFile = "C:\\Users\\op\\.codex\\auth.json";
  const images = [
    { image: "registry.example/agents", capabilities: ["Agent:Codex"] },
  ];
  /**
   * @param {Record<string, unknown>} runner
   * @param {string} [text] the auth file's, none where it is not there
   */
  const codexFound = async (runner, text) =>
    finding(
      (
        await doctored(t, {
          runner,
          files: text === undefined ? {} : { [authFile]: text },
        })
      ).findings,
      "Codex credential",
    );
  const named = { codexCredential: { authFile }, images };
  const remedy =
    "run codex login, which writes it to %USERPROFILE%\\.codex\\auth.json";
  const check = "Codex credential";
  assert.deepEqual(await codexFound(named), {
    check,
    passed: false,
    detail: `the Codex auth file ${authFile} cannot be found; ${remedy}`,
  });
  assert.deepEqual(await codexFound(named, "[1]"), {
    check,
    passed: false,
    detail: `the Codex auth file ${authFile} is not a JSON object; ${remedy}`,
  });
  assert.deepEqual(await codexFound(named, '{"tokens":{}}'), {
    check,
    passed: true,
    detail: `the Codex auth file ${authFile}, this account's own`,
  });
  assert.deepEqual(await codexFound({ codexCredential: { authFile } }, "{}"), {
    check,
    passed: true,
    warning: true,
    detail: `the Codex auth file ${authFile}, this account's own; this pool does not advertise Agent:Codex, since no images entry declares it and it was not registered with --host, so no job requiring Agent:Codex reaches it`,
  });
  assert.equal(await codexFound({ images }), undefined);
  const declared = await doctored(t, {
    runner: { capabilities: ["Agent:Codex"] },
  });
  assert.deepEqual(finding(declared.findings, check), {
    check,
    passed: true,
    warning: true,
    detail: `this pool advertises Agent:Codex and ${declared.paths.config} names no codexCredential, so its Codex jobs are handed the Claude token file; add codexCredential to hand them a Codex auth.json`,
  });
});

/** A session image in the chat host's own registry. */
const chatImage = "chuggy-registry.chuggy.example/chuggy/chat:1";

/** The Claude token file a chat host's runner's file names, alone in its directory. */
const chatTokenFile = "C:\\Users\\op\\claude\\token";

/**
 * doctor's findings for a chat host's file, its Claude token file alone in a
 * directory of its own unless `beside` names more there or `before` makes
 * it otherwise, and the plane naming `chatImage` unless `polled` says
 * otherwise.
 *
 * @param {import("node:test").TestContext} t
 * @param {DoctoredOptions & {beside?: readonly string[]}} [options]
 */
function doctoredChat(t, options = {}) {
  const { beside, ...rest } = options;
  return doctored(t, {
    pool: registeredChatHostFixture,
    polled: {
      polled: "Reconciled",
      assignments: [],
      stop: [],
      chatImage,
    },
    ...rest,
    runner: { claudeTokenFile: chatTokenFile, ...options.runner },
    before: rest.before ?? ((home) => tokenAloneWritten(home, beside)),
  });
}

/** What doctor names the fixture's chat host's file as. */
const chatHostNamed =
  "chat host newtenant/28:https:%2F%2Fauth.chuggy.example%2F0f3c9a52-member/chat/host";

test("doctor checks a chat host's file for what its run needs, and nothing a pool's jobs do", async (t) => {
  const { findings, poolFile, paths, state, polls } = await doctoredChat(t, {
    engine: (engine) => engine.images.add(chatImage),
  });
  assert.deepEqual(
    findings.map((found) => [found.check, found.passed, found.warning]),
    [
      ["pool file", true, undefined],
      ["runner configuration", true, undefined],
      ["runner directories", true, undefined],
      ["Claude token file", true, undefined],
      ["chat credential directory", true, undefined],
      ["chat settings", true, undefined],
      ["service task", true, undefined],
      ["container engine", true, undefined],
      ["job network", true, undefined],
      ["chat supervisor", true, undefined],
      ["pool token", true, undefined],
      ["plane", true, undefined],
      ["chat image", true, undefined],
    ],
  );
  const detail = (/** @type {string} */ check) =>
    finding(findings, check)?.detail;
  assert.equal(detail("pool file"), `${poolFile} names ${chatHostNamed}`);
  assert.equal(
    detail("runner configuration"),
    `${paths.config}: sessionsMax 4, sessionMemoryMib 2048, the supervisor's cap asked of the engine 8192 MiB, idleSecs 600, outputBytesMax 65536, running the image chuggy names`,
  );
  assert.equal(
    detail("chat credential directory"),
    `${chatTokenFile} is alone in its directory, which the chat supervisor is given read-only`,
  );
  assert.equal(
    detail("chat settings"),
    "docker is asked to cap the supervisor at 8192 MiB, 2048 MiB for each of its 4 sessions at once, with no swap past it",
  );
  assert.equal(
    detail("container engine"),
    "docker at npipe:////./pipe/dockerDesktopLinuxEngine lists 0 of this chat host's containers",
  );
  assert.match(detail("chat supervisor") ?? "", /^no container chuggy-chat-/u);
  assert.equal(detail("chat image"), `the plane's ${chatImage} is here`);
  assert.deepEqual(polls, [["pool-token", [], 0, 0]]);
  assert.ok(!state.calls.some((call) => call.argv[0] === "pull"));
});

test("a chat host's image not here is pulled under the pool's token from its registry, its own as its pull says, and none named fails", async (t) => {
  const pulled = await doctoredChat(t);
  assert.deepEqual(finding(pulled.findings, "chat image"), {
    check: "chat image",
    passed: true,
    detail: `the plane's ${chatImage} was pulled`,
  });
  const pull = pulled.state.calls.find((call) => call.argv[0] === "pull");
  assert.ok(pull?.authFile?.includes("chuggy-registry.chuggy.example"));
  assert.ok(!pull?.argv.some((word) => word.includes("pool-token")));
  const never = await doctoredChat(t, {
    runner: { chat: { image: { image: "localhost/mine:1", pull: "never" } } },
  });
  assert.deepEqual(never.findings.at(-1), {
    check: "chat image",
    passed: false,
    detail:
      "the host's own localhost/mine:1 is not here, and chat.image.pull is never",
  });
  const unnamed = await doctoredChat(t, {
    polled: { polled: "Reconciled", assignments: [], stop: [] },
  });
  assert.match(
    finding(unnamed.findings, "chat image")?.detail ?? "",
    /^the plane named no session image and the runner's file sets no chat\.image/u,
  );
});

test("a chat host's token file not alone in its directory fails, and so do settings no supervisor starts from", async (t) => {
  const beside = await doctoredChat(t, { beside: ["notes.txt"] });
  const directory = finding(beside.findings, "chat credential directory");
  assert.equal(directory?.passed, false);
  assert.match(
    directory?.detail ?? "",
    /holds notes\.txt beside the credential/u,
  );
  const rooted = await doctoredChat(t, {
    runner: { claudeTokenFile: "C:\\token" },
    files: { "C:\\token": "claude-token-fixture" },
  });
  assert.deepEqual(finding(rooted.findings, "chat settings"), {
    check: "chat settings",
    passed: false,
    detail: "the credential's file is in no directory of its own",
  });
});

test("a chat host whose runner directories anyone else may open is not pulled for", async (t) => {
  const { findings, state } = await doctoredChat(t, {
    made: ["runtime"],
    shared: (acls, { runtime }) => acls.set(runtime, usersReadAcl),
  });
  assert.equal(finding(findings, "runner directories")?.passed, false);
  assert.equal(finding(findings, "chat image"), undefined);
  assert.ok(!state.calls.some((call) => call.argv[0] === "pull"));
});

test("a chat host's supervisor container no service here runs fails, naming its removal; the service's own, or an exited one, passes, and one whose service cannot be asked is warned of", async (t) => {
  const name = chatSupervisorName(
    /** @type {any} */ (registeredChatHostFixture),
  );
  /** @param {string} status */
  const contained = (status) => (/** @type {any} */ engine) =>
    engine.containers.set(name, {
      id: "c1",
      name,
      labels: {},
      status,
      image: chatImage,
    });
  const left = await doctoredChat(t, { engine: contained("running") });
  assert.deepEqual(finding(left.findings, "chat supervisor"), {
    check: "chat supervisor",
    passed: false,
    detail: `${name} is running and no service here runs it, so every start of this host's supervisor is refused; remove it with docker rm -f ${name}, which ends every session it runs`,
  });
  const exited = await doctoredChat(t, { engine: contained("exited") });
  assert.equal(
    finding(exited.findings, "chat supervisor")?.detail,
    `${name} has exited, and the next start removes it`,
  );
  for (const [served, passed, warning, detail] of /** @type {const} */ ([
    [
      { status: () => ({ supervisor: "Ready", starting: false }) },
      true,
      undefined,
      new RegExp(`^${name} is the service's supervisor, ready$`, "u"),
    ],
    [
      undefined,
      true,
      true,
      new RegExp(
        `^${name} is running, and the service holding the host answers what this copy could not read, so it is taken as that service's: `,
        "u",
      ),
    ],
  ])) {
    const locks = fakeLocking();
    const found = await doctoredChat(t, {
      engine: contained("running"),
      locking: locks.locking,
      before: async (home) => {
        await tokenAloneWritten(home);
        await chatServiceHeld(t, home, locks, served);
      },
    });
    const supervisor = finding(found.findings, "chat supervisor");
    assert.equal(supervisor?.passed, passed);
    assert.equal(supervisor?.warning, warning);
    assert.match(supervisor?.detail ?? "", detail);
  }
});

/**
 * The chat host held by another process, answering on its pipe with what
 * `chat` says of it, or dropping every ask where there is none.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} home
 * @param {ReturnType<typeof fakeLocking>} locks
 * @param {{status: () => unknown} | undefined} chat
 */
async function chatServiceHeld(t, home, locks, chat) {
  const paths = runnerPaths(
    {
      APPDATA: win32.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    },
    home,
  );
  const runtime = poolRuntimeDirectory(
    paths,
    /** @type {any} */ (registeredChatHostFixture),
  );
  await mkdir(runtime, { recursive: true });
  const hold = await poolServiceClaimed(runtime, 4242, "run", locks.locking);
  const server =
    chat === undefined
      ? createServer((socket) => socket.destroy())
      : await controlServer(
          hold.pipe,
          chatHostControl(/** @type {any} */ (chat)),
        );
  if (chat === undefined)
    await new Promise((resolve) =>
      server.listen(hold.pipe, () => resolve(undefined)),
    );
  t.after(() => server.close());
}

test("doctor fails a chat host's file declaring what a pool's or a personal runner's does, and checks nothing of a chat host", async (t) => {
  for (const declared of [{ capabilities: [] }, { host: true }]) {
    const { findings } = await doctoredChat(t, {
      pool: { ...registeredChatHostFixture, ...declared },
    });
    assert.equal(findings[0]?.check, "pool file");
    assert.equal(findings[0]?.passed, false);
    assert.ok(
      !findings.some((found) => found.check.startsWith("chat ")),
      JSON.stringify(findings),
    );
  }
});
