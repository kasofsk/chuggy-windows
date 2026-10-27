import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";

import {
  sharedFixture,
  usersReadAcl,
  usersRefusal,
} from "./runner.fixture.mjs";
import {
  bindMountNameable,
  claudeTokenFileRefusal,
  runnerConfig,
  runnerConfigLimits,
  runnerPaths,
} from "./runnerConfig.mjs";

/** @param {import("node:test").TestContext} t */
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-windows-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const minimal = {
  claudeTokenFile:
    "C:\\Users\\op\\AppData\\Roaming\\chuggy-windows\\claude-token",
  timeoutSecsMax: 3600,
  outputBytesMax: 65536,
};

const defaults = {
  engine: "docker",
  concurrencyMax: 1,
  sessionsMax: 2,
  environment: {},
  network: "chuggy-jobs",
  engineSocket: false,
  images: [],
  imageUnusedSecsMax: 604800,
  diskFreeGibMin: 20,
  memoryFreeGibMin: 0,
  memoryReservedGib: 0,
};

/** A file no one else may open. */
const ownerOnly = sharedFixture().sharedRefusal;

/**
 * @param {string} directory
 * @param {unknown} document a document, or the text itself
 */
async function written(directory, document) {
  const file = join(directory, "runner.json");
  await writeFile(
    file,
    typeof document === "string" ? document : JSON.stringify(document),
  );
  return file;
}

test("a minimal file is read with every default, Docker Desktop's docker among them", async (t) => {
  const file = await written(await scratch(t), minimal);
  assert.deepEqual(await runnerConfig(file, ownerOnly), {
    ...minimal,
    ...defaults,
  });
});

test("a file Notepad saved with a byte order mark is read as one without", async (t) => {
  const file = await written(
    await scratch(t),
    `\ufeff${JSON.stringify(minimal)}`,
  );
  assert.deepEqual(await runnerConfig(file, ownerOnly), {
    ...minimal,
    ...defaults,
  });
});

test("sessionsMax is a whole number of none or more, read apart from concurrencyMax", async (t) => {
  const directory = await scratch(t);
  for (const sessionsMax of [0, 5])
    assert.deepEqual(
      await runnerConfig(
        await written(directory, {
          ...minimal,
          concurrencyMax: 3,
          sessionsMax,
        }),
        ownerOnly,
      ),
      { ...minimal, ...defaults, concurrencyMax: 3, sessionsMax },
    );
  for (const [sessionsMax, why] of [
    [-1, "Too small: expected number to be >=0"],
    [1.5, "Invalid input: expected int, received number"],
    ["2", "Invalid input: expected number, received string"],
    [null, "Invalid input: expected number, received null"],
  ]) {
    const file = await written(directory, { ...minimal, sessionsMax });
    await assert.rejects(runnerConfig(file, ownerOnly), {
      message: `runner configuration ${file}: sessionsMax ${why}`,
    });
  }
});

test("the disk floor, an image's retention, the memory kept free and the memory reserved from jobs are whole numbers of none or more, and Docker Desktop's disk image is found where the file says", async (t) => {
  const directory = await scratch(t);
  const named = {
    ...minimal,
    diskFreeGibMin: 0,
    imageUnusedSecsMax: 0,
    memoryFreeGibMin: 3,
    memoryReservedGib: 1,
    dockerDiskDirectory: "D:\\DockerDesktopWSL\\disk",
  };
  assert.deepEqual(
    await runnerConfig(await written(directory, named), ownerOnly),
    { ...defaults, ...named },
  );
  for (const [key, value, why] of [
    ["diskFreeGibMin", -1, "Too small: expected number to be >=0"],
    ["diskFreeGibMin", 2.5, "Invalid input: expected int, received number"],
    [
      "diskFreeGibMin",
      Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30) + 1,
      `Too big: expected number to be <=${String(Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30))}`,
    ],
    ["imageUnusedSecsMax", -1, "Too small: expected number to be >=0"],
    [
      "imageUnusedSecsMax",
      "604800",
      "Invalid input: expected number, received string",
    ],
    ["dockerDiskDirectory", "Docker\\wsl\\disk", "must be an absolute path"],
    ["memoryFreeGibMin", -1, "Too small: expected number to be >=0"],
    ["memoryFreeGibMin", 1.5, "Invalid input: expected int, received number"],
    ["memoryReservedGib", -1, "Too small: expected number to be >=0"],
    [
      "memoryReservedGib",
      "2",
      "Invalid input: expected number, received string",
    ],
  ]) {
    const file = await written(directory, { ...minimal, [key]: value });
    await assert.rejects(runnerConfig(file, ownerOnly), {
      message: `runner configuration ${file}: ${String(key)} ${String(why)}`,
    });
  }
});

test("a file anyone besides this account may open is refused, naming the file and who, and is asked of by its path", async (t) => {
  const file = await written(await scratch(t), minimal);
  const { acls, asked, sharedRefusal } = sharedFixture();
  acls.set(file, usersReadAcl);
  await assert.rejects(runnerConfig(file, sharedRefusal), {
    message: `runner configuration ${file} ${usersRefusal}`,
  });
  assert.deepEqual(asked, [file]);
});

test("a file past any runner's size is refused once it is known to be no one else's", async (t) => {
  const file = await written(
    await scratch(t),
    `${JSON.stringify(minimal)}${" ".repeat(64 * 1024)}`,
  );
  const { asked, sharedRefusal } = sharedFixture();
  await assert.rejects(runnerConfig(file, sharedRefusal), {
    message: `runner configuration ${file} is larger than one`,
  });
  assert.deepEqual(asked, [file]);
});

test("what the file may not say is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const refused = [
    [{ ...minimal, enigne: "docker" }, /Unrecognized key: "enigne"/u],
    [
      { ...minimal, engine: "podman" },
      /: engine must be docker, Docker Desktop's engine$/u,
    ],
    [
      {
        ...minimal,
        engineSocket: true,
        environment: { DOCKER_HOST: "tcp://x:2375" },
      },
      /environment\.DOCKER_HOST is the runner's to set while engineSocket is true/u,
    ],
    [{ ...minimal, engineSocket: "yes" }, /engineSocket /u],
    [
      { ...minimal, environment: { NAME: "a\nB=c" } },
      /environment\.NAME may not break a line/u,
    ],
    [{ ...minimal, environment: { "1NAME": "a" } }, /environment\.1NAME/u],
    [{ ...minimal, network: "host" }, /network may not be the host's network/u],
    [{ ...minimal, network: "--privileged" }, /network /u],
    [{ ...minimal, concurrencyMax: 0 }, /concurrencyMax /u],
    [
      { claudeTokenFile: minimal.claudeTokenFile },
      /timeoutSecsMax .*; outputBytesMax /u,
    ],
    ["{", /is not JSON$/u],
  ];
  for (const [document, why] of refused)
    await assert.rejects(
      runnerConfig(await written(directory, document), ownerOnly),
      why,
      JSON.stringify(document),
    );
});

test("every variable a job's runner sets is refused in the environment by name", async (t) => {
  const directory = await scratch(t);
  assert.ok(reservedJobVariables.length > 0);
  for (const name of reservedJobVariables) {
    const file = await written(directory, {
      ...minimal,
      environment: { [name]: "x", OTHER: "kept" },
    });
    await assert.rejects(runnerConfig(file, ownerOnly), {
      message: `runner configuration ${file}: environment.${name} is the runner's to set`,
    });
  }
});

test("the Claude token file is a Windows absolute path a bind mount can name", async (t) => {
  const directory = await scratch(t);
  for (const claudeTokenFile of [
    "D:\\tokens\\claude",
    "\\\\server\\share\\claude-token",
    "C:/Users/op/claude-token",
  ])
    assert.equal(
      (
        await runnerConfig(
          await written(directory, { ...minimal, claudeTokenFile }),
          ownerOnly,
        )
      ).claudeTokenFile,
      claudeTokenFile,
    );
  for (const [claudeTokenFile, why] of [
    ["claude-token", "must be an absolute path"],
    ["C:claude-token", "must be an absolute path"],
    ["C:\\a,readonly=false", "cannot be named in a bind mount"],
    ["C:\\a\nb", "cannot be named in a bind mount"],
  ]) {
    const file = await written(directory, { ...minimal, claudeTokenFile });
    await assert.rejects(runnerConfig(file, ownerOnly), {
      message: `runner configuration ${file}: claudeTokenFile ${why}`,
    });
  }
  assert.equal(bindMountNameable("C:\\Program Files\\t"), true);
  assert.equal(bindMountNameable("C:\\a\rb"), false);
});

test("a directory is not a runner configuration", async (t) => {
  const directory = await scratch(t);
  await mkdir(join(directory, "runner.json"));
  await assert.rejects(
    runnerConfig(join(directory, "runner.json"), ownerOnly),
    /is not a file$/u,
  );
});

test("the runner's file and the pool files are under the roaming application data, and what it makes as it runs under the local", () => {
  assert.deepEqual(
    runnerPaths(
      {
        APPDATA: "D:\\Profiles\\op\\Roaming",
        LOCALAPPDATA: "E:\\Local",
      },
      "C:\\Users\\op",
    ),
    {
      config: "D:\\Profiles\\op\\Roaming\\chuggy-windows\\runner.json",
      pools: "D:\\Profiles\\op\\Roaming\\chuggy\\pools",
      logs: "E:\\Local\\chuggy-windows\\logs",
      jobs: "E:\\Local\\chuggy-windows\\jobs",
      runtime: "E:\\Local\\chuggy-windows\\run",
      images: "E:\\Local\\chuggy-windows\\images",
      dockerDisk: "E:\\Local\\Docker\\wsl\\disk",
    },
  );
});

test("either application data folder unset, or not absolute, is its default under the profile", () => {
  const fallen = {
    config: "C:\\Users\\op\\AppData\\Roaming\\chuggy-windows\\runner.json",
    pools: "C:\\Users\\op\\AppData\\Roaming\\chuggy\\pools",
    logs: "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\logs",
    jobs: "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\jobs",
    runtime: "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\run",
    images: "C:\\Users\\op\\AppData\\Local\\chuggy-windows\\images",
    dockerDisk: "C:\\Users\\op\\AppData\\Local\\Docker\\wsl\\disk",
  };
  for (const environment of [
    {},
    { APPDATA: "", LOCALAPPDATA: "" },
    { APPDATA: "Roaming", LOCALAPPDATA: "C:Local" },
  ])
    assert.deepEqual(
      runnerPaths(environment, "C:\\Users\\op"),
      fallen,
      JSON.stringify(environment),
    );
});

test("the limits are said in the file's own terms", () => {
  assert.equal(
    runnerConfigLimits({
      .../** @type {any} */ (minimal),
      ...defaults,
      concurrencyMax: 3,
      sessionsMax: 0,
    }),
    "concurrencyMax 3, sessionsMax 0",
  );
});

test("a Claude token file a job cannot be handed is refused, and one only this account may open is not", async (t) => {
  const directory = await scratch(t);
  const file = join(directory, "claude-token");
  const { acls, asked, sharedRefusal } = sharedFixture();
  /** @param {string} path */
  const refusal = async (path) =>
    (await claudeTokenFileRefusal(path, sharedRefusal)) ?? "";
  assert.equal(
    await refusal(file),
    `the Claude token file ${file} cannot be found; save \`claude setup-token\`'s output there`,
  );
  await writeFile(file, "");
  assert.equal(await refusal(file), `the Claude token file ${file} is empty`);
  assert.equal(
    await refusal(directory),
    `the Claude token file ${directory} is not a file`,
  );
  assert.deepEqual(asked, []);
  await writeFile(file, "claude-token-fixture");
  assert.equal(await claudeTokenFileRefusal(file, sharedRefusal), undefined);
  acls.set(file, usersReadAcl);
  assert.equal(
    await refusal(file),
    `the Claude token file ${file} ${usersRefusal}`,
  );
  assert.deepEqual(asked, [file, file]);
});

test("the images a job that pins none runs in are read as listed, each with the capabilities its owner declares, and none is a platform", async (t) => {
  const directory = await scratch(t);
  const images = [
    {
      image: "registry.chuggy.example/a@sha256:" + "a".repeat(64),
      capabilities: [],
    },
    {
      image: "registry.chuggy.example/b:1",
      capabilities: ["Tool:Bazel", "Agent:Claude"],
    },
  ];
  assert.deepEqual(
    (
      await runnerConfig(
        await written(directory, { ...minimal, images }),
        ownerOnly,
      )
    ).images,
    images,
  );
  for (const [listed, why] of [
    [
      [{ image: "i", capabilities: ["Platform:Windows:Amd64"] }],
      /images\.0\.capabilities\.0 names a platform, which is the engine's/u,
    ],
    [[{ image: "", capabilities: [] }], /images\.0\.image /u],
    [[{ image: "i" }], /images\.0\.capabilities /u],
    [[{ image: "i", capabilities: [], tag: "x" }], /Unrecognized key: "tag"/u],
    [{ image: "i", capabilities: [] }, /images /u],
  ])
    await assert.rejects(
      runnerConfig(
        await written(directory, { ...minimal, images: listed }),
        ownerOnly,
      ),
      why,
      JSON.stringify(listed),
    );
});

test("engineSocket hands every job Docker Desktop's engine where it is true, and the variables that tell a job of it are then the runner's alone", async (t) => {
  const directory = await scratch(t);
  const file = await written(directory, {
    ...minimal,
    engineSocket: true,
    environment: { CI: "1" },
  });
  const read = await runnerConfig(file, ownerOnly);
  assert.equal(read.engineSocket, true);
  assert.deepEqual(read.environment, { CI: "1" });
  const off = await runnerConfig(
    await written(directory, {
      ...minimal,
      environment: { DOCKER_HOST: "tcp://x:2375" },
    }),
    ownerOnly,
  );
  assert.equal(off.engineSocket, false);
});

test("a file may declare what its machine meets, read as written, and a platform or a token named twice is refused, naming where", async (t) => {
  const directory = await scratch(t);
  const file = await written(directory, {
    ...minimal,
    capabilities: ["gpu", "Agent:Claude"],
  });
  assert.deepEqual((await runnerConfig(file, ownerOnly)).capabilities, [
    "gpu",
    "Agent:Claude",
  ]);
  for (const [capabilities, why] of [
    [
      ["gpu", "Platform:Windows:Amd64"],
      /capabilities\.1 is a platform, which the runner finds of this machine/u,
    ],
    [["gpu", "gpu"], /capabilities\.1 is named by an earlier entry/u],
    [["no spaces"], /capabilities\.0 /u],
  ])
    await assert.rejects(
      runnerConfig(
        await written(directory, { ...minimal, capabilities }),
        ownerOnly,
      ),
      why,
      JSON.stringify(capabilities),
    );
});
