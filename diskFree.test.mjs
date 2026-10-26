import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers";
import test from "node:test";

import {
  diskFloorSaid,
  diskFreeLogged,
  engineDiskFree,
  engineInfoTimeoutMs,
  vmDiskArgv,
  wslRunner,
  wslText,
} from "./diskFree.mjs";
import { diskFloorCallsMsMax } from "@chuggy/worker-core/diskFloor.mjs";

import { fakeDisk, fakeEngine } from "./engine.fixture.mjs";
import { runnerConfigSchema, runnerPaths } from "./runnerConfig.mjs";

const gib = 2 ** 30;

const paths = runnerPaths({}, "C:\\Users\\op");

/** @param {Record<string, unknown>} [named] */
function configured(named = {}) {
  return runnerConfigSchema.parse({
    claudeTokenFile: "C:\\Users\\op\\claude-token",
    timeoutSecsMax: 3600,
    outputBytesMax: 65536,
    ...named,
  });
}

/** @param {Record<string, unknown> | undefined} [info] Docker Desktop's where none */
function engineSaying(info) {
  const { engine, state } = fakeEngine();
  if (info !== undefined) state.info = info;
  return engine;
}

const drive = "C:\\, holding Docker Desktop's disk image";
const vm = "/mnt/docker-desktop-disk in Docker Desktop's VM";

test("the free disk is the lower of the drive holding Docker Desktop's disk image and its VM's own, the drive measured where the file says it is", async () => {
  const lowDrive = fakeDisk(40, 900);
  assert.deepEqual(
    await engineDiskFree(configured(), paths, engineSaying(), lowDrive),
    {
      free: 40 * gib,
      where: drive,
      drive: true,
      unmeasured: [],
      driveMeasured: true,
    },
  );
  assert.deepEqual(lowDrive.measured, [
    "C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk",
  ]);
  assert.deepEqual(lowDrive.wslCalls, [vmDiskArgv]);
  assert.deepEqual(vmDiskArgv, [
    "-d",
    "docker-desktop",
    "-e",
    "sh",
    "-c",
    'mountpoint -q "$1" || { echo "$1 is not a mount" >&2; exit 1; }; stat -f -c "%a %S" "$1"',
    "sh",
    "/mnt/docker-desktop-disk",
  ]);
  const lowVm = fakeDisk(200, 12.5);
  assert.deepEqual(
    await engineDiskFree(
      configured({ dockerDiskDirectory: "D:\\DockerDesktopWSL\\disk" }),
      paths,
      engineSaying(),
      lowVm,
    ),
    {
      free: 12.5 * gib,
      where: vm,
      drive: false,
      unmeasured: [],
      driveMeasured: true,
    },
  );
  assert.deepEqual(lowVm.measured, ["D:\\DockerDesktopWSL\\disk"]);
});

test("a place that cannot be measured is left out and said, and with neither the free disk is unknown", async () => {
  const noVm = fakeDisk(40, "There is no distribution with the supplied name.");
  assert.deepEqual(
    await engineDiskFree(configured(), paths, engineSaying(), noVm),
    {
      free: 40 * gib,
      where: drive,
      drive: true,
      unmeasured: [
        "Docker Desktop's VM could not be measured at /mnt/docker-desktop-disk: There is no distribution with the supplied name.",
      ],
      driveMeasured: true,
    },
  );
  const noDrive = fakeDisk("ENOENT: no such file or directory", 300);
  assert.deepEqual(
    await engineDiskFree(configured(), paths, engineSaying(), noDrive),
    {
      free: 300 * gib,
      where: vm,
      drive: false,
      unmeasured: [
        "the drive holding Docker Desktop's disk image could not be measured at C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk: ENOENT: no such file or directory",
      ],
      driveMeasured: false,
    },
  );
  assert.deepEqual(
    await engineDiskFree(
      configured(),
      paths,
      engineSaying(),
      fakeDisk("ENOENT: gone", "wsl.exe exited 4294967295"),
    ),
    {
      unknown:
        "the drive holding Docker Desktop's disk image could not be measured at C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk: ENOENT: gone; Docker Desktop's VM could not be measured at /mnt/docker-desktop-disk: wsl.exe exited 4294967295",
    },
  );
});

test("the VM's free disk is the last line of two counts it prints, whatever wsl.exe says beside it", async () => {
  for (const stdout of [
    "wsl: A localhost proxy configuration was detected but not mirrored\n4096 4096\n",
    "4096 4096\r\n",
  ]) {
    const disk = {
      ...fakeDisk(900),
      wsl: async () => ({
        code: 0,
        stdout,
        stderr: "wsl: Failed to start the systemd user session\n",
      }),
    };
    const measured = await engineDiskFree(
      configured(),
      paths,
      engineSaying(),
      disk,
    );
    assert.deepEqual(
      "unknown" in measured ? measured : [measured.free, measured.where],
      [2 ** 24, vm],
    );
  }
});

test("a VM answer that is not two counts, a data disk that is not mounted, or a wsl.exe that failed saying nothing, is unmeasured, said by its errors first", async () => {
  for (const [answer, why] of [
    [
      { code: 0, stdout: "stat: applet not found\n", stderr: "" },
      "stat: applet not found",
    ],
    [{ code: 0, stdout: "12 4096 7\n", stderr: "" }, "12 4096 7"],
    [
      {
        code: 1,
        stdout: "",
        stderr: "/mnt/docker-desktop-disk is not a mount\n",
      },
      "/mnt/docker-desktop-disk is not a mount",
    ],
    [{ code: -1, stdout: "", stderr: "" }, "wsl.exe exited -1"],
  ]) {
    const disk = { ...fakeDisk(40), wsl: async () => answer };
    const measured = await engineDiskFree(
      configured(),
      paths,
      engineSaying(),
      disk,
    );
    assert.deepEqual(
      "unmeasured" in measured ? measured.unmeasured : measured,
      [
        `Docker Desktop's VM could not be measured at /mnt/docker-desktop-disk: ${String(why)}`,
      ],
    );
  }
});

test("an engine that is not Docker Desktop's, cannot be asked, or answers what this runner cannot read is unknown, and nothing is measured", async () => {
  const cases = [
    [
      { Name: "rancher-desktop" },
      "docker names its machine rancher-desktop, not Docker Desktop's VM, so this runner cannot measure where it stores what it holds",
    ],
    [{ Name: 7 }, "docker answered an info this runner cannot read"],
  ];
  for (const [info, unknown] of cases) {
    const disk = fakeDisk(40);
    assert.deepEqual(
      await engineDiskFree(
        configured(),
        paths,
        engineSaying(/** @type {Record<string, unknown>} */ (info)),
        disk,
      ),
      { unknown },
    );
    assert.deepEqual([disk.measured, disk.wslCalls], [[], []]);
  }
  const { engine, state } = fakeEngine();
  state.info = undefined;
  const measured = await engineDiskFree(
    configured(),
    paths,
    engine,
    fakeDisk(40),
  );
  assert.match(
    "unknown" in measured ? measured.unknown : "",
    /^docker could not be asked which machine it runs on: error during connect: /u,
  );
});

test("the floor is said against what is free: over it, under it, under half of it, compacting named only for the drive", async () => {
  const config = configured({ diskFreeGibMin: 30 });
  const said = (/** @type {number} */ free, /** @type {number} */ vmFree) =>
    diskFloorSaid(config, paths, engineSaying(), fakeDisk(free, vmFree));
  const compact =
    "; if the drive stays low once images are removed, the disk image needs compacting: quit Docker Desktop, wsl --shutdown, then diskpart's compact vdisk, or Optimize-VHD -Mode Full where Hyper-V is installed";
  assert.deepEqual(await said(30, 900), {
    detail: `30 GiB free at ${drive}, over the floor of 30 GiB`,
    warning: false,
    failed: false,
  });
  assert.deepEqual(await said(15, 900), {
    detail: `15 GiB free at ${drive}, under the floor of 30 GiB: the service removes the images it may and takes no job until it is over${compact}`,
    warning: true,
    failed: false,
  });
  assert.deepEqual(await said(14.5, 900), {
    detail: `14.5 GiB free at ${drive}, under half the floor of 30 GiB: the service removes the images it may, and stops a job each pass it is still under half${compact}`,
    warning: true,
    failed: false,
  });
  assert.deepEqual(await said(900, 14), {
    detail: `14 GiB free at ${vm}, under half the floor of 30 GiB: the service removes the images it may, and stops a job each pass it is still under half`,
    warning: true,
    failed: false,
  });
});

test("a floor held on the VM alone, the drive unmeasured, fails", async () => {
  assert.deepEqual(
    await diskFloorSaid(
      configured(),
      paths,
      engineSaying(),
      fakeDisk("ENOENT: no such file or directory", 300),
    ),
    {
      detail: `300 GiB free at ${vm}, over the floor of 20 GiB; only that, since the drive holding Docker Desktop's disk image could not be measured at C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk: ENOENT: no such file or directory`,
      warning: true,
      failed: true,
    },
  );
});

test("a floor of 0 is none and measures nothing, and a free disk that could not be measured holds none and is warned of", async () => {
  const disk = fakeDisk(1);
  assert.deepEqual(
    await diskFloorSaid(
      configured({ diskFreeGibMin: 0 }),
      paths,
      engineSaying(),
      disk,
    ),
    {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
      failed: false,
    },
  );
  assert.deepEqual([disk.measured, disk.wslCalls], [[], []]);
  assert.deepEqual(
    await diskFloorSaid(
      configured(),
      paths,
      engineSaying({ Name: "elsewhere" }),
      fakeDisk(1),
    ),
    {
      detail:
        "none held, since the free disk could not be measured: docker names its machine elsewhere, not Docker Desktop's VM, so this runner cannot measure where it stores what it holds",
      warning: true,
      failed: false,
    },
  );
});

test("the core is handed the lowest measured alone, and the log says each time the places that could not be measured change", async () => {
  const at = { drive: true, driveMeasured: true };
  /** @type {import("./diskFree.mjs").DockerDiskFree[]} */
  const answers = [
    { free: 5 * gib, where: drive, ...at, unmeasured: [] },
    { free: 5 * gib, where: drive, ...at, unmeasured: ["no VM"] },
    { free: 6 * gib, where: drive, ...at, unmeasured: ["no VM"] },
    { unknown: "no engine" },
    { free: 7 * gib, where: vm, ...at, drive: false, unmeasured: [] },
  ];
  /** @type {string[]} */
  const log = [];
  const measured = diskFreeLogged(
    async () => answers.shift() ?? { unknown: "done" },
    (line) => log.push(line),
  );
  const handed = [];
  for (let pass = 0; pass < 5; pass += 1) handed.push(await measured());
  assert.deepEqual(handed, [
    { free: 5 * gib, where: drive },
    { free: 5 * gib, where: drive },
    { free: 6 * gib, where: drive },
    { unknown: "no engine" },
    { free: 7 * gib, where: vm },
  ]);
  assert.deepEqual(log, [
    `this runner measures its free disk only at ${drive}, since no VM`,
    "this runner measures its free disk everywhere it looks again",
  ]);
});

test("wsl.exe's own words are read as the UTF-16 it writes, and a Linux program's as UTF-8", () => {
  assert.equal(
    wslText(Buffer.from("There is no distribution\r\n", "utf16le")),
    "There is no distribution\r\n",
  );
  assert.equal(wslText(Buffer.from("222707232 4096\n")), "222707232 4096\n");
  assert.equal(wslText(Buffer.alloc(0)), "");
});

test("a measurement asked for while one is still being made shares it, and the next is made afresh", async () => {
  /** @type {Array<(free: number) => void>} */
  const pending = [];
  const measured = diskFreeLogged(
    () =>
      new Promise((resolve) =>
        pending.push((free) =>
          resolve({
            free,
            where: drive,
            drive: true,
            driveMeasured: true,
            unmeasured: [],
          }),
        ),
      ),
    () => undefined,
  );
  const first = measured();
  const second = measured();
  assert.equal(pending.length, 1);
  pending[0](3);
  assert.deepEqual(await Promise.all([first, second]), [
    { free: 3, where: drive },
    { free: 3, where: drive },
  ]);
  const third = measured();
  assert.equal(pending.length, 2);
  pending[1](4);
  assert.deepEqual(await third, { free: 4, where: drive });
});

test("an engine that does not say which machine it runs on in time is unknown, and nothing is measured", async () => {
  const disk = fakeDisk(40);
  /** @type {Array<AbortSignal | undefined>} */
  const signals = [];
  /** @type {import("@chuggy/worker-core/engine.mjs").Engine} */
  const hung = {
    ...fakeEngine().engine,
    exec: async (_argv, call = {}) => {
      signals.push(call.signal);
      throw new globalThis.DOMException(
        "The operation timed out.",
        "TimeoutError",
      );
    },
  };
  assert.deepEqual(await engineDiskFree(configured(), paths, hung, disk), {
    unknown: "docker did not say which machine it runs on in time",
  });
  assert.ok(signals[0] instanceof globalThis.AbortSignal);
  assert.equal(signals[0]?.aborted, false);
  assert.deepEqual([disk.measured, disk.wslCalls], [[], []]);
});

/**
 * A child `wslRunner` starts, writing `out` and `err` and then closing with
 * `code`, or never closing where `code` is undefined, recording what it was
 * started with.
 *
 * @param {{out?: Buffer, err?: Buffer, code?: number | null, error?: Error}} child
 * @param {unknown[][]} started
 */
function fakeWsl(child, started) {
  return /** @type {any} */ (
    (/** @type {unknown[]} */ ...args) => {
      started.push(args);
      const emitter = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      setImmediate(() => {
        if (child.error !== undefined) {
          emitter.emit("error", child.error);
          return;
        }
        if (child.out !== undefined) emitter.stdout.write(child.out);
        if (child.err !== undefined) emitter.stderr.write(child.err);
        setImmediate(() => emitter.emit("close", child.code ?? null));
      });
      return emitter;
    }
  );
}

test("wsl.exe is run with no input, no window, a cap and its own words in UTF-8, each stream kept apart", async () => {
  /** @type {unknown[][]} */
  const started = [];
  const answer = await wslRunner(
    fakeWsl(
      {
        out: Buffer.from("4096 4096\n"),
        err: Buffer.from("wsl: a warning\r\n", "utf16le"),
        code: 0,
      },
      started,
    ),
  )(vmDiskArgv);
  assert.deepEqual(answer, {
    code: 0,
    stdout: "4096 4096\n",
    stderr: "wsl: a warning\r\n",
  });
  const [command, argv, options] = /** @type {[string, string[], any]} */ (
    started[0]
  );
  assert.match(command, /\\System32\\wsl\.exe$/u);
  assert.deepEqual(argv, [...vmDiskArgv]);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.WSL_UTF8, "1");
  assert.ok(options.timeout > 0);
  assert.ok(
    options.timeout + engineInfoTimeoutMs < diskFloorCallsMsMax,
    "a measurement answers within the core's cap",
  );
});

test("a wsl.exe killed at its cap, or that could not start, answers -1", async () => {
  assert.deepEqual(await wslRunner(fakeWsl({ code: null }, []))(["-l"]), {
    code: -1,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(
    await wslRunner(fakeWsl({ error: new Error("spawn ENOENT") }, []))(["-l"]),
    { code: -1, stdout: "", stderr: "spawn ENOENT" },
  );
});
