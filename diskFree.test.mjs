import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  diskFloorSaid,
  diskFreeLogged,
  engineDiskFree,
  vmDiskArgv,
  wslText,
} from "./diskFree.mjs";
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
    { free: 40 * gib, where: drive, drive: true, unmeasured: [] },
  );
  assert.deepEqual(lowDrive.measured, [
    "C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk",
  ]);
  assert.deepEqual(lowDrive.wslCalls, [vmDiskArgv]);
  assert.deepEqual(vmDiskArgv, [
    "-d",
    "docker-desktop",
    "-e",
    "stat",
    "-f",
    "-c",
    "%a %S",
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

test("a VM answer that is not two counts, or a wsl.exe that failed saying nothing, is unmeasured", async () => {
  for (const [answer, why] of [
    [{ code: 0, stdout: "stat: applet not found\n" }, "stat: applet not found"],
    [{ code: 0, stdout: "12 4096 7\n" }, "12 4096 7"],
    [{ code: -1, stdout: "" }, "wsl.exe exited -1"],
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
    "; if the drive stays low once images are removed, the disk image needs compacting: wsl --shutdown, then Optimize-VHD -Mode Full or diskpart's compact vdisk";
  assert.deepEqual(await said(30, 900), {
    detail: `30 GiB free at ${drive}, over the floor of 30 GiB`,
    warning: false,
  });
  assert.deepEqual(await said(15, 900), {
    detail: `15 GiB free at ${drive}, under the floor of 30 GiB: the service removes the images it may and takes no job until it is over${compact}`,
    warning: true,
  });
  assert.deepEqual(await said(14.5, 900), {
    detail: `14.5 GiB free at ${drive}, under half the floor of 30 GiB: the service removes the images it may, and stops a job each pass it is still under half${compact}`,
    warning: true,
  });
  assert.deepEqual(await said(900, 14), {
    detail: `14 GiB free at ${vm}, under half the floor of 30 GiB: the service removes the images it may, and stops a job each pass it is still under half`,
    warning: true,
  });
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
    },
  );
});

test("the core is handed the lowest measured alone, and the log says each time the places that could not be measured change", async () => {
  /** @type {import("./diskFree.mjs").DockerDiskFree[]} */
  const answers = [
    { free: 5 * gib, where: drive, drive: true, unmeasured: [] },
    { free: 5 * gib, where: drive, drive: true, unmeasured: ["no VM"] },
    { free: 6 * gib, where: drive, drive: true, unmeasured: ["no VM"] },
    { unknown: "no engine" },
    { free: 7 * gib, where: vm, drive: false, unmeasured: [] },
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
