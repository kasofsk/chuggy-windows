import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  engineEndpoint,
  engineSocketHanded,
  hostJobSpawned,
  hostJobTreeKilled,
  hostPlatform,
  engineMachine,
  jobNetwork,
  ownScratchRemoved,
  poolRuntimeDirectory,
  runnerDirectories,
  runnerDirectoriesChecked,
  runnerSecretDirectories,
  runnerLeftoversRemoved,
  runnerLoop,
  runnerParts,
  runnerSetup,
  scratchRemovedOnEnd,
} from "./runner.mjs";
import {
  fixturePool,
  machineDirectory,
  runnerFixture,
  signalsWatched,
  usersReadAcl,
  usersRefusal,
  hostedPool,
} from "./runner.fixture.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import { deniedExitStatus } from "./serviceTask.mjs";

/** The endpoint Docker Desktop's context names. */
const desktopPipe = "npipe:////./pipe/dockerDesktopLinuxEngine";

const pooledTokens = {
  acquire: async () => ({ acquired: "Token", token: "pool-token" }),
  invalidate: () => undefined,
};

/**
 * A run composed over a fake engine from a machine's files.
 *
 * @param {import("node:test").TestContext} t
 * @param {Parameters<typeof runnerFixture>[1]} [documents]
 * @param {Partial<Parameters<typeof runnerParts>[1]>} [host]
 */
async function composed(t, documents, host = {}) {
  const fixture = await runnerFixture(t, documents);
  const setup = await runnerSetup(
    fixture.poolFile,
    fixture.environment,
    fixture.home,
    fixture.sharedRefusal,
  );
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(setup, {
    log: () => undefined,
    sharedRefusal: fixture.sharedRefusal,
    engine,
    ...host,
  });
  return { ...fixture, setup, runner, engine, state };
}

test("a run the plane denies ends with the status the service does not restart", async () => {
  const client = {
    tokens: pooledTokens,
    plane: {
      poll: async () => ({
        polled: "Denied",
        evidence: "the pool was revoked",
      }),
    },
    backend: { held: async () => [], ended: async () => [] },
    settings: { concurrencyMax: 2, outageBackoffMs: 5000, passesMax: 1 },
  };
  /** @type {string[]} */
  const log = [];
  const status = await runnerLoop(/** @type {any} */ (client), {
    sleep: async () => undefined,
    log: (line) => log.push(line),
  });
  assert.equal(status, deniedExitStatus);
  assert.deepEqual(log, ["the plane denied this pool: the pool was revoked"]);
});

test("a job network another run made between the inspection and the creation is present", async () => {
  const { engine, state } = fakeEngine();
  const raced = {
    ...engine,
    exec: async (
      /** @type {readonly string[]} */ argv,
      /** @type {import("@chuggy/worker-core/engine.mjs").EngineCall | undefined} */ call,
    ) => {
      if (argv[0] === "network" && argv[1] === "create") {
        state.networks.add(argv[2]);
        return {
          code: 1,
          stdout: "",
          stderr: `Error response from daemon: network with name ${argv[2]} already exists\n`,
        };
      }
      return engine.exec(argv, call);
    },
  };
  assert.equal(await jobNetwork(raced, "chuggy-jobs"), "Present");
  const refused = {
    ...raced,
    exec: async (/** @type {readonly string[]} */ argv) =>
      argv[1] === "create"
        ? { code: 1, stdout: "", stderr: "Error: permission denied\n" }
        : engine.exec(["network", "inspect", "missing"]),
  };
  await assert.rejects(jobNetwork(refused, "missing"), {
    message: "network missing could not be created: Error: permission denied",
  });
});

test("the job network is made only where it is missing", async () => {
  const { engine, state } = fakeEngine();
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Created");
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Present");
  assert.deepEqual(
    state.calls.map((call) => call.argv),
    [
      ["network", "inspect", "chuggy-jobs"],
      ["network", "create", "chuggy-jobs"],
      ["network", "inspect", "chuggy-jobs"],
    ],
  );
  state.unreachable = true;
  await assert.rejects(
    jobNetwork(engine, "chuggy-jobs"),
    /^Error: network chuggy-jobs could not be inspected: error during connect: /u,
  );
});

test("each pool has a runtime directory of its own under the runner's", () => {
  const paths = {
    runtime: "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\run",
  };
  const own = poolRuntimeDirectory(/** @type {any} */ (paths), fixturePool);
  assert.match(
    own,
    /^C:\\Users\\op\\AppData\\Local\\chuggy-windows\\run\\pools\\[0-9a-f]{20}$/u,
  );
  assert.equal(
    own,
    poolRuntimeDirectory(/** @type {any} */ (paths), { ...fixturePool }),
  );
  assert.notEqual(
    own,
    poolRuntimeDirectory(/** @type {any} */ (paths), {
      ...fixturePool,
      tenant: "newtenant",
      project: "arbbot",
    }),
  );
});

test("the directories the runner keeps secrets in are the pool file's, the runtime directory, the logs and the host jobs'", () => {
  const paths = runnerPaths({}, "C:\\Users\\op");
  assert.deepEqual(runnerSecretDirectories(paths, "D:\\pools\\pool.json"), [
    "D:\\pools",
    paths.runtime,
    paths.logs,
    paths.jobs,
  ]);
});

test("the directories the runner keeps secrets in are made and checked, and one anyone else may open is refused, naming it", async (t) => {
  const { paths, poolFile, acls, asked, sharedRefusal } =
    await runnerFixture(t);
  const directories = runnerSecretDirectories(paths, poolFile);
  await runnerDirectoriesChecked(paths, poolFile, sharedRefusal);
  for (const directory of directories)
    assert.ok((await stat(directory)).isDirectory(), directory);
  assert.deepEqual(asked, directories);
  for (const directory of directories) {
    acls.clear();
    acls.set(directory, usersReadAcl);
    await assert.rejects(
      runnerDirectoriesChecked(paths, poolFile, sharedRefusal),
      {
        message: `the directory ${directory} ${usersRefusal}; the runner keeps secrets there`,
      },
    );
  }
});

test("a pool's directories are made, the pool's runtime directory and the runner's logs", async (t) => {
  const { paths } = await runnerFixture(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await runnerDirectories(paths, runtime);
  assert.deepEqual(await readdir(runtime), []);
  assert.deepEqual(await readdir(paths.logs), []);
});

/**
 * Leftovers are removed by a path the runner joins with Windows' separator,
 * which names the entry only where the runtime directory is the working one,
 * so the suite works from inside it. The machine's directory goes back to
 * the suite's own once the test ends.
 *
 * @param {string} directory
 */
function workingIn(directory) {
  process.chdir(directory);
}

test("what a killed run left in its pool's runtime directory is removed, and nothing of another pool's", async (t) => {
  const machine = await machineDirectory(t);
  for (const pool of ["own", "other"]) {
    await mkdir(join(machine, pool, "pull-1-left"), { recursive: true });
    await mkdir(join(machine, pool, "job-1-left"));
    await writeFile(join(machine, pool, "jobs.log"), "");
  }
  workingIn(join(machine, "own"));
  await runnerLeftoversRemoved(".");
  assert.deepEqual(await readdir("."), ["jobs.log"]);
  assert.deepEqual((await readdir(join(machine, "other"))).sort(), [
    "job-1-left",
    "jobs.log",
    "pull-1-left",
  ]);
});

/**
 * Writes the pool's record, in the working directory, as process `pid`'s.
 *
 * @param {number} pid
 * @param {string} [runtime]
 */
async function recordWritten(pid, runtime = ".") {
  const file = win32.join(runtime, "control.json");
  await writeFile(
    file,
    JSON.stringify({
      pipe: `\\\\.\\pipe\\chuggy-windows-${"0".repeat(32)}`,
      pid,
      kind: "run",
    }),
  );
  return file;
}

test("a process removes only the pull credentials and env files it made, and the pool's record only where it is its own", async (t) => {
  const machine = await machineDirectory(t);
  for (const entry of ["pull-12-a", "job-12-b", "pull-123-c", "job-1-d"])
    await mkdir(join(machine, entry));
  await writeFile(join(machine, "jobs.log"), "");
  workingIn(machine);
  await recordWritten(13);
  ownScratchRemoved(".", 12);
  assert.deepEqual((await readdir(machine)).sort(), [
    "control.json",
    "job-1-d",
    "jobs.log",
    "pull-123-c",
  ]);
  await recordWritten(12);
  ownScratchRemoved(".", 12);
  assert.ok(!(await readdir(machine)).includes("control.json"));
});

test(
  "an entry that cannot be removed stops none of the rest, and the record is let go still, even where the directory cannot be read",
  { skip: process.getuid?.() === 0 && "root removes whatever the mode" },
  async (t) => {
    const machine = await machineDirectory(t);
    workingIn(machine);
    const locked = join("pull-12-a", "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "auth.json"), "{}");
    await mkdir("job-12-b");
    await recordWritten(12);
    await chmod(locked, 0o500);
    try {
      ownScratchRemoved(".", 12);
      assert.deepEqual(await readdir("."), ["pull-12-a"]);
    } finally {
      await chmod(locked, 0o700);
    }
    const unread = await recordWritten(12, "gone");
    assert.throws(() => ownScratchRemoved("gone", 12), { code: "ENOENT" });
    assert.ok(!(await readdir(".")).includes(unread));
  },
);

/**
 * A run ending as `scratchRemovedOnEnd` ends it, in a runtime directory that
 * is the working one, holding its own scratch and another process's.
 *
 * @param {import("node:test").TestContext} t
 * @param {boolean} supervised
 */
async function ending(t, supervised) {
  const signals = signalsWatched(t);
  workingIn(await machineDirectory(t));
  await mkdir(`${runtimeScratch("pull")}a`);
  await mkdir("pull-1-another");
  /** @type {number[]} */
  const exits = [];
  const host = {
    supervised,
    stdin: new PassThrough(),
    outputs: [new PassThrough(), new PassThrough()],
    exit: (/** @type {number} */ status) => exits.push(status),
  };
  scratchRemovedOnEnd(".", host);
  return { ...host, exits, signals };
}

test("a supervised run removes its own scratch and ends once its input closes, and an unsupervised one does not listen for it or its outputs", async (t) => {
  const unsupervised = await ending(t, false);
  assert.equal(unsupervised.stdin.listenerCount("end"), 0);
  for (const output of unsupervised.outputs)
    assert.equal(output.listenerCount("error"), 0);
  for (const name of ["SIGINT", "SIGBREAK", "SIGHUP"])
    assert.equal(unsupervised.signals.added(name).length, 1, name);
  const { stdin, exits } = await ending(t, true);
  stdin.end();
  await once(stdin, "end");
  assert.deepEqual(exits, [1]);
  assert.deepEqual(await readdir("."), ["pull-1-another"]);
});

test("a supervised run whose output the service no longer reads removes its own scratch and ends", async (t) => {
  const { outputs, exits } = await ending(t, true);
  outputs[1].emit(
    "error",
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
  );
  assert.deepEqual(exits, [1]);
  assert.deepEqual(await readdir("."), ["pull-1-another"]);
});

test("a run ends once however many of its ends come", async (t) => {
  const { stdin, outputs, exits, signals } = await ending(t, true);
  for (const output of outputs) output.emit("error", new Error("write EPIPE"));
  signals.raised("SIGHUP");
  signals.raised("SIGINT");
  stdin.end();
  await once(stdin, "end");
  assert.deepEqual(exits, [1]);
});

test("a Ctrl+C removes the process's own scratch and ends it with status 1", async (t) => {
  const machine = await machineDirectory(t);
  await mkdir(join(machine, "pull-1-another"));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdirSync } from "node:fs";
import { runtimeScratch } from ${JSON.stringify(import.meta.resolve("@chuggy/worker-core/runtimeScratch.mjs"))};
import { scratchRemovedOnEnd } from ${JSON.stringify(import.meta.resolve("./runner.mjs"))};
process.chdir(process.argv[1]);
mkdirSync(runtimeScratch("pull") + "a");
mkdirSync(runtimeScratch("job") + "b");
scratchRemovedOnEnd(".", { supervised: false, stdin: process.stdin, exit: (status) => process.exit(status) });
setInterval(() => undefined, 1000);
process.stdout.write("ready\\n");`,
      machine,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  assert.equal((await readdir(machine)).length, 3);
  child.kill("SIGINT");
  assert.deepEqual(await once(child, "exit"), [1, null]);
  assert.deepEqual(await readdir(machine), ["pull-1-another"]);
});

test("Docker Desktop's engine is taken at the local named pipe its context names, whatever the case it is written in", async () => {
  for (const host of [
    desktopPipe,
    "npipe:////./pipe/docker_engine",
    "NPIPE:////./PIPE/dockerDesktopLinuxEngine",
  ]) {
    const { engine, state } = fakeEngine();
    state.contextHost = `${host}  `;
    assert.equal(await engineEndpoint(engine), host);
    assert.deepEqual(
      state.calls.map((call) => call.argv),
      [
        ["info", "--format", "{{json .SecurityOptions}}"],
        ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      ],
    );
  }
});

test("docker is refused where its context names anything but a local named pipe", async () => {
  const { engine, state } = fakeEngine();
  for (const host of [
    "unix:///var/run/docker.sock",
    "tcp://192.0.2.10:2376",
    "ssh://op@build",
    "npipe:////build/pipe/docker_engine",
    "",
  ]) {
    state.contextHost = host;
    await assert.rejects(engineEndpoint(engine), {
      message: `docker's context names "${host}", and only a local docker, reached by a named pipe as Docker Desktop's is, is supported`,
    });
  }
  state.contextHost = undefined;
  await assert.rejects(engineEndpoint(engine), {
    message:
      'docker\'s context could not be read: context "default": context not found',
  });
});

test("docker that maps a job's uid, rootless or by userns-remap, is refused before anything else is asked of it", async () => {
  for (const [option, running] of [
    ["name=rootless", "rootless"],
    ["name=userns", "with userns-remap"],
  ]) {
    const { engine, state } = fakeEngine();
    state.securityOptions = ["name=seccomp,profile=builtin", option];
    await assert.rejects(engineEndpoint(engine), {
      message: `docker is running ${running}, where a job cannot read the Claude token file; use Docker Desktop as it comes`,
    });
    assert.deepEqual(
      state.calls.map((call) => call.argv[0]),
      ["info"],
    );
  }
});

test("docker that cannot be asked is said to be Docker Desktop not running, with docker's own words", async () => {
  const { engine, state } = fakeEngine();
  state.unreachable = true;
  await assert.rejects(
    engineEndpoint(engine),
    /^Error: docker could not be asked, so Docker Desktop may not be running: error during connect: .*dockerDesktopLinuxEngine: The system cannot find the file specified\.$/u,
  );
});

test("the machine a job runs on is Docker Desktop's, as docker says its CPUs and memory", async () => {
  const { engine, state } = fakeEngine();
  state.machine = "8 16624349184";
  assert.deepEqual(await engineMachine(engine), {
    cpuMillis: 8000,
    memoryMib: 15854,
  });
  assert.deepEqual(state.calls.at(-1)?.argv, [
    "info",
    "--format",
    "{{.NCPU}} {{.MemTotal}}",
  ]);
  state.machine = "1 1048576\r\n";
  assert.deepEqual(await engineMachine(engine), {
    cpuMillis: 1000,
    memoryMib: 1,
  });
});

test("an answer that names no CPUs or no memory is refused, and so is docker failing to answer", async () => {
  const { engine, state } = fakeEngine();
  for (const answer of [
    "",
    "8",
    "0 16624349184",
    "8 0",
    "8 16G",
    "a b",
    "8  1",
  ]) {
    state.machine = answer;
    await assert.rejects(engineMachine(engine), {
      message: `docker answered "${answer}" when asked for its CPUs and memory`,
    });
  }
  state.machine = undefined;
  await assert.rejects(engineMachine(engine), {
    message:
      "docker could not say what its machine has: Error: cannot read the machine",
  });
});

test("a run is composed from both files, each asked whether anyone else may open it", async (t) => {
  const { runner, asked, poolFile, paths, state } = await composed(t, {
    runner: { concurrencyMax: 3 },
  });
  assert.equal(runner.client.settings.concurrencyMax, 3);
  assert.equal(runner.client.settings.sessionsMax, 2);
  assert.equal(typeof runner.client.sessions?.end, "function");
  assert.deepEqual(runner.backend.inFlight(), []);
  assert.equal(runner.runtime, poolRuntimeDirectory(paths, fixturePool));
  assert.deepEqual(asked, [poolFile, paths.config]);
  assert.deepEqual(
    state.calls.map((call) => call.argv.slice(0, 3).join(" ")),
    [
      "info --format {{json .SecurityOptions}}",
      "context inspect --format",
      "info --format {{.NCPU}} {{.MemTotal}}",
    ],
  );
});

test("a run whose file sets sessionsMax to 0 is given no room for a session", async (t) => {
  const { runner } = await composed(t, { runner: { sessionsMax: 0 } });
  assert.equal(runner.client.settings.concurrencyMax, 1);
  assert.equal(runner.client.settings.sessionsMax, 0);
});

test("a run refuses a pool file or a runner's file anyone else may open, naming which", async (t) => {
  const { poolFile, paths, environment, home, acls, sharedRefusal } =
    await runnerFixture(t);
  acls.set(poolFile, usersReadAcl);
  await assert.rejects(
    runnerSetup(poolFile, environment, home, sharedRefusal),
    { message: `pool credentials ${poolFile} ${usersRefusal}` },
  );
  acls.delete(poolFile);
  acls.set(paths.config, usersReadAcl);
  await assert.rejects(
    runnerSetup(poolFile, environment, home, sharedRefusal),
    { message: `runner configuration ${paths.config} ${usersRefusal}` },
  );
});

const registryImage = `registry.chuggy.example/worker@sha256:${"a".repeat(64)}`;

/**
 * @param {string} assignment
 * @param {string} image
 */
function runnerAssignment(assignment, image, cpuMillis = 1000) {
  return {
    assignment,
    capabilities: ["container"],
    image,
    cpuMillis,
    memoryMib: 512,
    deadlineSecs: 600,
    callbackUrl: "https://chuggy.example/worker",
    bearer: `bearer-of-${assignment}`,
  };
}

test("a run's backend refuses an assignment while the token file is anyone else's to open, asking nothing of the engine", async (t) => {
  const { runner, state, tokenFile, acls } = await composed(t);
  acls.set(tokenFile, usersReadAcl);
  const calls = state.calls.length;
  const placed = await runner.backend.place(
    runnerAssignment("asg-1", registryImage),
    "Job",
  );
  assert.deepEqual(placed, {
    placed: "Refused",
    evidence: `the Claude token file ${tokenFile} ${usersRefusal}`,
  });
  assert.equal(state.calls.length, calls);
});

test("a run's backend refuses an assignment asking for more CPU than Docker Desktop's machine has", async (t) => {
  const { runner } = await composed(t);
  const placed = await runner.backend.place(
    runnerAssignment("asg-1", registryImage, 8001),
    "Job",
  );
  assert.equal(placed.placed, "Refused");
  assert.equal(
    placed.evidence,
    "the assignment asks for 8001 CPU millis and this machine has 8000",
  );
});

test("a pull is made at the endpoint Docker Desktop's context names, presenting the pool's token only to the registry its file names and docker's own empty credential to any other", async (t) => {
  const { runner, state } = await composed(
    t,
    { pool: { ...fixturePool, registryHost: "registry.chuggy.example" } },
    { tokens: pooledTokens },
  );
  const elsewhere = `elsewhere.example/w@sha256:${"b".repeat(64)}`;
  for (const [assignment, image] of [
    ["asg-1", registryImage],
    ["asg-2", elsewhere],
  ])
    assert.deepEqual(
      await runner.backend.place(runnerAssignment(assignment, image), "Job"),
      { placed: "Placed" },
    );
  await runner.backend.settled();
  const pulls = state.calls.filter((call) => call.argv[0] === "pull");
  assert.deepEqual(
    pulls.map((pull) => [pull.argv.at(-1), pull.environment.DOCKER_HOST]),
    [
      [registryImage, desktopPipe],
      [elsewhere, desktopPipe],
    ],
  );
  assert.deepEqual(JSON.parse(pulls[0].authFile ?? ""), {
    auths: {
      "registry.chuggy.example": {
        auth: Buffer.from("chuggy-pool:pool-token").toString("base64"),
      },
    },
  });
  assert.deepEqual(JSON.parse(pulls[1].authFile ?? ""), {
    auths: {},
    credHelpers: { "chuggy.invalid": "" },
  });
  for (const pull of pulls)
    assert.ok(
      pull.authDirectory?.startsWith(`${runner.runtime}/pull-`),
      pull.authDirectory,
    );
});

test("with engineSocket a job, and never a session, is handed Docker Desktop's socket read-only and added to root's group", async (t) => {
  const { runner, state } = await composed(t, {
    runner: { engineSocket: true },
  });
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.place(
    runnerAssignment("asg-2", registryImage),
    "Session",
  );
  await runner.backend.settled();
  const runs = state.calls.filter((call) => call.argv[0] === "run");
  assert.equal(runs.length, 2);
  const [job, session] = runs.map((run) => run.argv);
  assert.ok(
    job.includes(
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
    ),
    job.join(" "),
  );
  assert.equal(job[job.indexOf("--group-add") + 1], "0");
  const told = runs[0].envFile ?? "";
  assert.match(told, /^DOCKER_HOST=unix:\/\/\/var\/run\/docker\.sock$/mu);
  assert.match(
    told,
    /^TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=\/var\/run\/docker\.sock$/mu,
  );
  assert.ok(
    !session.some((flag) => flag.includes("docker.sock")),
    session.join(" "),
  );
  assert.ok(!session.includes("--group-add"), session.join(" "));
});

test("without engineSocket, and for a run that places nothing, no job is handed the socket", async (t) => {
  const { runner, state } = await composed(t);
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  const run = state.calls.find((call) => call.argv[0] === "run");
  assert.ok(!(run?.argv ?? []).some((flag) => flag.includes("docker.sock")));
  assert.equal(engineSocketHanded({ engineSocket: false }), undefined);
  assert.deepEqual(engineSocketHanded({ engineSocket: true }), {
    path: "/var/run/docker.sock",
    gid: 0,
    rootGroup: true,
  });
});

test("a job runs on the runner's network with its limits, the Claude token file mounted from its Windows path", async (t) => {
  const { runner, state, tokenFile } = await composed(t, {
    runner: { network: "jobs-net", timeoutSecsMax: 1200 },
  });
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  const run = state.calls.find((call) => call.argv[0] === "run");
  const argv = run?.argv ?? [];
  assert.equal(argv[argv.indexOf("--network") + 1], "jobs-net");
  assert.ok(
    argv.some((flag) => flag.includes(`source=${tokenFile},`)),
    argv.join(" "),
  );
  assert.ok(
    argv.some((label) => label.startsWith("io.chuggy.deadline=")),
    argv.join(" "),
  );
  assert.equal(win32.isAbsolute(tokenFile), true);
});

/**
 * A run over a fake engine whose jobs' and sessions' planes answer every call
 * and record it, polled by a plane answering `polls` in turn and recording
 * what each poll asked, its held assignments sorted.
 *
 * @param {import("node:test").TestContext} t
 * @param {unknown[]} polls
 */
async function endingRunner(t, polls) {
  /** @type {Array<{url: string, method: string | undefined, authorization: string, body: string}>} */
  const asked = [];
  const { runner, state } = await composed(t, undefined, {
    tokens: pooledTokens,
    fetch: async (url, init = {}) => {
      asked.push({
        url: String(url),
        method: init.method,
        authorization: /** @type {Record<string, string>} */ (init.headers)
          .authorization,
        body: String(init.body),
      });
      return new globalThis.Response(null, { status: 204 });
    },
  });
  /** @type {unknown[][]} */
  const pollsAsked = [];
  const client =
    /** @type {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} */ ({
      ...runner.client,
      plane: {
        poll: async (
          /** @type {string} */ token,
          /** @type {readonly string[]} */ held,
          /** @type {unknown[]} */ ...wanted
        ) => polls[pollsAsked.push([token, [...held].sort(), ...wanted]) - 1],
        settle: async () => "Settled",
      },
    });
  return { runner, client, state, asked, pollsAsked };
}

const quietPoll = {
  polled: "Reconciled",
  assignments: [],
  sessions: [],
  stop: [],
};

test("a pass ends the attempt of a job whose container exited unreported, at its plane under its own bearer, with the runner's reason", async (t) => {
  const { runner, client, state, asked } = await endingRunner(t, [quietPoll]);
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  const [container] = state.containers.values();
  container.status = "exited";
  container.exitCode = 1;

  assert.deepEqual(await workerPoolClientPass(client), {
    passed: "Reconciled",
    placed: 0,
    stopped: 0,
    refused: 0,
    ended: 1,
  });
  assert.deepEqual(asked, [
    {
      url: "https://chuggy.example/v1/artifacts/.chuggy/worker-error.txt",
      method: "PUT",
      authorization: "Bearer bearer-of-asg-1",
      body: "Worker exited before reporting: its container exited with status 1\n",
    },
    {
      url: "https://chuggy.example/v1/run/ended",
      method: "POST",
      authorization: "Bearer bearer-of-asg-1",
      body: '{"evidence":"RunFailed"}',
    },
  ]);
});

/**
 * What a run asked of an attempt's plane under that attempt's bearer.
 *
 * @param {Array<{url: string, method: string | undefined, authorization: string, body: string}>} asked
 * @param {string} assignment
 */
function askedUnder(asked, assignment) {
  return asked
    .filter(
      ({ authorization }) => authorization === `Bearer bearer-of-${assignment}`,
    )
    .map(({ url, method, body }) => [method, url, body]);
}

test("a pass places a session the plane offers as a session, and its end reaches the session's plane while a job's still reaches the job's", async (t) => {
  const { runner, client, state, asked, pollsAsked } = await endingRunner(t, [
    {
      polled: "Reconciled",
      assignments: [runnerAssignment("asg-1", registryImage)],
      sessions: [runnerAssignment("ses-1", registryImage)],
      stop: [],
    },
    quietPoll,
    quietPoll,
  ]);
  state.images.add(registryImage);
  const quiet = { passed: "Reconciled", stopped: 0, refused: 0 };
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 2,
    ended: 0,
  });
  await runner.backend.settled();
  assert.deepEqual(
    [...state.containers.values()]
      .map((container) => [
        container.labels["io.chuggy.assignment"],
        container.labels["io.chuggy.kind"],
      ])
      .sort(),
    [
      ["asg-1", "Job"],
      ["ses-1", "Session"],
    ],
  );
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 0,
    ended: 0,
  });
  for (const container of state.containers.values()) {
    container.status = "exited";
    container.exitCode =
      container.labels["io.chuggy.kind"] === "Session" ? 0 : 1;
  }
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    placed: 0,
    ended: 2,
  });
  assert.deepEqual(pollsAsked, [
    ["pool-token", [], 1, 2],
    ["pool-token", ["asg-1", "ses-1"], 0, 1],
    ["pool-token", [], 1, 2],
  ]);
  assert.deepEqual(askedUnder(asked, "ses-1"), [
    [
      "POST",
      "https://chuggy.example/v1/session/ended",
      '{"phase":"Succeeded"}',
    ],
  ]);
  assert.deepEqual(askedUnder(asked, "asg-1"), [
    [
      "PUT",
      "https://chuggy.example/v1/artifacts/.chuggy/worker-error.txt",
      "Worker exited before reporting: its container exited with status 1\n",
    ],
    ["POST", "https://chuggy.example/v1/run/ended", '{"evidence":"RunFailed"}'],
  ]);
  assert.equal(asked.length, 3);
});

test("a job stopped on the plane's word is never ended, though its container outlives the pass that stopped it", async (t) => {
  const { runner, client, state, asked } = await endingRunner(t, [
    {
      polled: "Reconciled",
      assignments: [],
      sessions: [],
      stop: ["asg-1", "asg-2"],
    },
    quietPoll,
  ]);
  state.images.add(registryImage);
  await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job");
  await runner.backend.settled();
  state.pull = () => new Promise(() => undefined);
  await runner.backend.place(
    runnerAssignment("asg-2", `elsewhere.example/w@sha256:${"b".repeat(64)}`),
    "Job",
  );
  state.logsFail = true;

  const quiet = { passed: "Reconciled", placed: 0, refused: 0, ended: 0 };
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    stopped: 2,
  });
  assert.equal(state.containers.size, 1);
  state.logsFail = false;
  assert.deepEqual(await workerPoolClientPass(client), {
    ...quiet,
    stopped: 0,
  });
  assert.equal(state.containers.size, 0);
  assert.deepEqual(asked, []);
});

test("a Windows machine's own platform is its architecture's, and one no pool runs work on the host of is none", () => {
  assert.equal(hostPlatform("x64"), "Platform:Windows:Amd64");
  assert.equal(hostPlatform("arm64"), "Platform:Windows:Arm64");
  for (const arch of ["ia32", "arm", "riscv64", "", "constructor"])
    assert.equal(hostPlatform(arch), undefined, arch);
});

test("a host job's core is started with the options it asks for, but in this process's group and with no window", async () => {
  const child = hostJobSpawned(
    process.execPath,
    [
      "-e",
      'process.stdout.write(require("node:fs").readFileSync("/proc/self/stat", "utf8"))',
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: false },
  );
  let stat = "";
  child.stdout?.on("data", (chunk) => (stat += chunk));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.deepEqual(child.spawnargs.slice(1, 2), ["-e"]);
  /** @param {string} text the process group, as /proc says it */
  const group = (text) => text.slice(text.lastIndexOf(")") + 2).split(" ")[2];
  if (existsSync("/proc/self/stat"))
    assert.equal(
      group(stat),
      group(readFileSync(`/proc/${String(process.pid)}/stat`, "utf8")),
    );
});

test("killing the tree of a host job that is gone, or where taskkill cannot run, is no failure", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  assert.doesNotThrow(() =>
    hostJobTreeKilled(/** @type {number} */ (child.pid)),
  );
});

/**
 * An imageless job naming `platform`.
 *
 * @param {string} assignment
 * @param {string} platform
 */
function imagelessJob(assignment, platform, cpuMillis = 1000) {
  const { image, ...job } = runnerAssignment(assignment, "", cpuMillis);
  assert.equal(image, "");
  return { ...job, capabilities: [platform] };
}

/**
 * The exit listeners a test's host backends add to this process, removed
 * once it ends.
 *
 * @param {import("node:test").TestContext} t
 */
function exitWatched(t) {
  const before = process.listeners("exit");
  t.after(() => {
    for (const listener of process.listeners("exit"))
      if (!before.includes(listener)) process.off("exit", listener);
  });
}

test("a pool registered with --host places a job pinning no image and naming this machine's platform on the machine itself, sized against it and not Docker Desktop's VM", async (t) => {
  exitWatched(t);
  const { runner, state } = await composed(t, { pool: hostedPool });
  const calls = state.calls.length;
  const cpuMillis = availableParallelism() * 1000;
  const placed = await runner.backend.place(
    imagelessJob("asg-1", "Platform:Windows:Amd64", cpuMillis + 1),
    "Job",
  );
  assert.deepEqual(placed, {
    placed: "Refused",
    evidence: `the assignment asks for ${String(cpuMillis + 1)} CPU millis and this machine has ${String(cpuMillis)}`,
  });
  assert.equal(state.calls.length, calls);
});

test("a host job is refused, asking nothing of the engine, while the Claude token file is anyone else's to open", async (t) => {
  exitWatched(t);
  const { runner, state, tokenFile, acls } = await composed(t, {
    pool: hostedPool,
  });
  acls.set(tokenFile, usersReadAcl);
  const calls = state.calls.length;
  assert.deepEqual(
    await runner.backend.place(
      imagelessJob("asg-1", "Platform:Windows:Amd64"),
      "Job",
    ),
    {
      placed: "Refused",
      evidence: `the Claude token file ${tokenFile} ${usersRefusal}`,
    },
  );
  assert.equal(state.calls.length, calls);
});

test("beside a host, a job pinning an image and a session run in containers still", async (t) => {
  exitWatched(t);
  const { runner, state } = await composed(t, { pool: hostedPool });
  state.images.add(registryImage);
  assert.deepEqual(
    await runner.backend.place(runnerAssignment("asg-1", registryImage), "Job"),
    { placed: "Placed" },
  );
  assert.deepEqual(
    await runner.backend.place(
      imagelessJob("ses-1", "Platform:Windows:Amd64"),
      "Session",
    ),
    {
      placed: "Refused",
      evidence:
        "the assignment pins no image, and no image this pool's owner listed meets it: a Linux one declaring every capability it names",
    },
  );
  await runner.backend.settled();
  assert.ok(state.calls.some((call) => call.argv[0] === "run"));
});

test("a pool registered without --host places no job on the machine itself, whatever platform it names", async (t) => {
  const { runner } = await composed(t, {
    pool: { ...hostedPool, host: undefined },
  });
  assert.deepEqual(
    await runner.backend.place(
      imagelessJob("asg-1", "Platform:Windows:Amd64"),
      "Job",
    ),
    {
      placed: "Refused",
      evidence:
        "the assignment pins no image, and no image this pool's owner listed meets it: a Linux one declaring every capability it names",
    },
  );
});

test("a job pinning no image runs in the first image the runner's file lists that declares every capability it names", async (t) => {
  const listed = `registry.chuggy.example/bazel@sha256:${"b".repeat(64)}`;
  const { runner, state } = await composed(t, {
    runner: {
      images: [
        { image: registryImage, capabilities: ["Agent:Claude"] },
        { image: listed, capabilities: ["Agent:Claude", "Tool:Bazel"] },
      ],
    },
  });
  state.images.add(listed);
  const job = {
    ...imagelessJob("asg-1", "Platform:Linux:Amd64"),
    capabilities: ["Platform:Linux:Amd64", "Tool:Bazel"],
  };
  assert.deepEqual(await runner.backend.place(job, "Job"), {
    placed: "Placed",
  });
  await runner.backend.settled();
  const run = state.calls.find((call) => call.argv[0] === "run");
  assert.equal(run?.argv.at(-1), listed);
});

test("a run of a pool registered with --host refuses a runner's file no host job can run under, naming why", async (t) => {
  exitWatched(t);
  await assert.rejects(
    composed(t, {
      pool: hostedPool,
      runner: { environment: { userprofile: "C:\\elsewhere" } },
    }),
    {
      name: "RangeError",
      message:
        "userprofile is set for every host job, and the owner's environment cannot name it",
    },
  );
  await assert.rejects(
    composed(t, { pool: hostedPool, runner: { timeoutSecsMax: 2 ** 31 } }),
    {
      name: "RangeError",
      message: /^a host job's timeout is at most \d+ seconds$/u,
    },
  );
  const { runner } = await composed(t, {
    runner: { environment: { userprofile: "C:\\elsewhere" } },
  });
  assert.deepEqual(runner.backend.inFlight(), []);
});
