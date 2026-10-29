/**
 * A Windows machine's worth of files for a suite: a pool registration, the
 * runner's file and a Claude token file under a profile at `C:\Users\op`,
 * and who besides its owner may open each.
 *
 * Every path the runner builds is a `path.win32` one, which on another system
 * is a single file name with backslashes in it, relative to the working
 * directory. So the suite is moved into a directory of its own for the test,
 * and each Windows path is a file or directory named exactly that in it: the
 * same string always names the same file, as it would on Windows.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { runnerPaths } from "./runnerConfig.mjs";
import { aclSharedRefusal } from "./windowsAcl.mjs";

export const fixturePool = {
  tenant: "vteng",
  project: "chuggy",
  pool: "shame",
  capabilities: ["container"],
  tokenUrl: "https://issuer.chuggy.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  clientId: "pool-client",
  clientSecret: "pool-client-secret",
};

/** A pool registered with `--host`, declaring its containers' platform and this machine's. */
export const hostedPool = {
  ...fixturePool,
  capabilities: ["Platform:Linux:Amd64", "Platform:Windows:Amd64"],
  host: true,
};

/** The profile a suite's machine has, and the account it runs as. */
export const fixtureHome = "C:\\Users\\op";
export const fixtureUserSid = "S-1-5-21-1004336348-1177238915-682003330-1001";

/** The access rules of a file under the profile, as Windows sets them. */
export const ownerOnlyAcl = {
  owner: fixtureUserSid,
  rules: [
    { sid: fixtureUserSid, rights: 2032127, allow: true },
    { sid: "S-1-5-18", rights: 2032127, allow: true },
    { sid: "S-1-5-32-544", rights: 2032127, allow: true },
  ],
};

/** The access rules of a file every user of the machine may read. */
export const usersReadAcl = {
  owner: fixtureUserSid,
  rules: [
    ...ownerOnlyAcl.rules,
    { sid: "S-1-5-32-545", rights: 1179817, allow: true },
  ],
};

/** What the access-rule check says of a file every user may read. */
export const usersRefusal = aclSharedRefusal(usersReadAcl, fixtureUserSid);

/** The suite's own working directory, which each test goes back to. */
const suiteDirectory = process.cwd();

/**
 * A suite's working directory for the test: a directory of its own, left
 * for the suite's own and removed once the test ends. A test may have
 * several, the last made being the one it works in.
 *
 * @param {import("node:test").TestContext} t
 */
export async function machineDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-windows-machine-"));
  process.chdir(directory);
  t.after(async () => {
    process.chdir(suiteDirectory);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * Writes a pool file.
 *
 * @param {string} file
 * @param {Record<string, unknown>} pool
 */
export async function poolFileWritten(file, pool) {
  await writeFile(file, JSON.stringify(pool));
  return file;
}

/**
 * A Claude token file in a directory of its own under `home`, with each of
 * `beside` there too, as a chat host's is kept. Off Windows the file and its
 * directory are two entries of the working directory, each named for its
 * Windows path, so the directory is made to list the file by its name.
 *
 * @param {string} home
 * @param {readonly string[]} [beside]
 */
export async function tokenAloneWritten(home, beside = []) {
  const directory = win32.join(home, "claude");
  const file = win32.join(directory, "token");
  await mkdir(directory, { recursive: true });
  for (const name of [win32.basename(file), ...beside])
    await writeFile(join(directory, name), "");
  await writeFile(file, "claude-token-fixture");
  return file;
}

/**
 * Who besides this account may open a file, answered from access rules a
 * suite sets by path, every file being its owner's alone until it does.
 */
export function sharedFixture() {
  /** @type {Map<string, import("./windowsAcl.mjs").Acl>} */
  const acls = new Map();
  /** @type {string[]} */
  const asked = [];
  /** @type {import("./runnerConfig.mjs").SharedRefusal} */
  const sharedRefusal = async (file) => {
    asked.push(file);
    return aclSharedRefusal(acls.get(file) ?? ownerOnlyAcl, fixtureUserSid);
  };
  return { acls, asked, sharedRefusal };
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, pool?: Record<string, unknown>}} documents the runner's file, or none where it is `undefined`, and the pool file
 */
export async function runnerFixture(t, documents = {}) {
  await machineDirectory(t);
  const home = fixtureHome;
  const environment = {
    APPDATA: win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(home, "AppData", "Local"),
  };
  const paths = runnerPaths(environment, home);
  const poolFile = await poolFileWritten(
    win32.join(home, "pool.json"),
    documents.pool ?? fixturePool,
  );
  const tokenFile = win32.join(home, "claude-token");
  await writeFile(tokenFile, "claude-token-fixture");
  if (!("runner" in documents) || documents.runner !== undefined)
    await writeFile(
      paths.config,
      JSON.stringify({
        claudeTokenFile: tokenFile,
        timeoutSecsMax: 3600,
        outputBytesMax: 65536,
        ...documents.runner,
      }),
    );
  return {
    home,
    environment,
    paths,
    poolFile,
    tokenFile,
    ...sharedFixture(),
  };
}

/**
 * Locks held in memory, standing in for Windows' exclusive opens, which a
 * file opened elsewhere refuses no open of: each lock is held by one taker
 * until released, every take and release recorded in order, and `onRelease`
 * run as a lock is let go, before it is.
 */
export function fakeLocking() {
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Array<["take" | "refuse" | "release", string]>} */
  const events = [];
  const hooks = {
    /** @type {(file: string) => Promise<void> | void} */
    onRelease: () => undefined,
  };
  /** @type {import("./poolService.mjs").PoolLocking} */
  const locking = async (file) => {
    if (held.has(file)) {
      events.push(["refuse", file]);
      return undefined;
    }
    held.add(file);
    events.push(["take", file]);
    return {
      release: async () => {
        await hooks.onRelease(file);
        held.delete(file);
        events.push(["release", file]);
      },
    };
  };
  return { locking, held, events, hooks };
}

/**
 * The signal listeners a test adds to this process, as a run ending on a
 * signal does, removed once it ends, and a hand that calls each added so
 * far as the signal would.
 *
 * @param {import("node:test").TestContext} t
 */
export function signalsWatched(t) {
  const signals = ["SIGINT", "SIGBREAK", "SIGHUP"];
  const before = new Map(
    signals.map((name) => [name, process.listeners(name)]),
  );
  /** @param {string} name */
  const added = (name) =>
    process.listeners(name).filter((each) => !before.get(name)?.includes(each));
  t.after(() => {
    for (const name of signals)
      for (const listener of added(name)) process.off(name, listener);
  });
  return {
    added,
    /** @param {string} name */
    raised: (name) => {
      for (const listener of added(name)) listener(name);
    },
  };
}
