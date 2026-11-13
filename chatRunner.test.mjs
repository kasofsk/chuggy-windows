import assert from "node:assert/strict";
import test from "node:test";

import {
  chatHostMemoryBytes,
  chatHostSessionsMaxDefault,
  chatHostVolumes,
  chatSessionMemoryBytesDefault,
  chatSupervisorContainer,
  chatSupervisorNaming,
} from "@chuggy/worker-core/chatHost.mjs";
import { chatSupervisorRunArgv } from "@chuggy/worker-core/engineArgv.mjs";

import {
  chatCredentialRefusal,
  chatHostPlaces,
  chatHostSettings,
  chatRunnerLoop,
} from "./chatRunner.mjs";
import {
  fixtureHome,
  machineDirectory,
  sharedFixture,
  tokenAloneWritten,
  usersReadAcl,
  usersRefusal,
} from "./runner.fixture.mjs";
import { deniedExitStatus } from "./serviceTask.mjs";

/** A member's chat host, as its file names it. */
const identity = /** @type {const} */ ({
  kind: "ChatHost",
  tenant: "vteng",
  owner: "28:https://auth.chuggy.example/0f3c9a52-member",
});

const tokenFile = "C:\\Users\\op\\claude\\token";

/** The fields of a runner's file the chat host reads. */
const config = /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
  /** @type {unknown} */ ({
    engine: "docker",
    claudeTokenFile: tokenFile,
    network: "chuggy-jobs",
    outputBytesMax: 65536,
  })
);

/**
 * What a host's places hold, its selector as the credentials it describes.
 *
 * @param {import("@chuggy/worker-core/chatHost.mjs").ChatSupervisorPlaces} places
 */
const placesHeld = ({ credentials, ...places }) => ({
  ...places,
  credentials: credentials?.described(),
});

test("a host's places are its volumes and a selector over the Claude credentials, owned by root as Docker Desktop shows every file it binds", () => {
  assert.deepEqual(placesHeld(chatHostPlaces(identity, config)), {
    volumes: chatHostVolumes(identity),
    credentialOwner: { uid: 0, gid: 0 },
    credentials: [
      {
        name: "claude",
        agent: "Claude",
        type: "OAuth",
        file: tokenFile,
        bench: { state: "Available" },
      },
    ],
  });
});

test("a host's settings are the core's defaults where the file names none, its own where it does", () => {
  const settings = chatHostSettings(identity, config);
  assert.equal(settings.sessionsMax, chatHostSessionsMaxDefault);
  assert.equal(settings.sessionMemoryBytes, chatSessionMemoryBytesDefault);
  assert.equal(settings.outputBytesMax, config.outputBytesMax);
  assert.deepEqual(
    placesHeld(settings.places),
    placesHeld(chatHostPlaces(identity, config)),
  );
  const own = chatHostSettings(identity, {
    ...config,
    chat: {
      sessionsMax: 3,
      sessionMemoryMib: 1024,
      image: { image: "img:1", pull: "never" },
    },
  });
  assert.equal(chatHostMemoryBytes(own), 3 * 1024 * 2 ** 20);
  assert.deepEqual(own.image, { image: "img:1", pull: "never" });
});

test("docker is handed the token file's own Windows directory, read-only, and the credential's tmpfs as root's", () => {
  const settings = chatHostSettings(identity, config);
  const { argv } = chatSupervisorRunArgv(
    "docker",
    chatSupervisorContainer(
      "img:1",
      settings.places,
      chatHostMemoryBytes(settings),
    ),
    chatSupervisorNaming(identity, config.network),
  );
  assert.ok(
    argv.some(
      (word) =>
        word.startsWith("type=bind,source=C:\\Users\\op\\claude,") &&
        word.includes("readonly"),
    ),
    argv.join(" "),
  );
  assert.ok(
    argv.some(
      (word) =>
        word.startsWith("/var/run/chuggy/credentials:") &&
        word.endsWith(",uid=0,gid=0"),
    ),
    argv.join(" "),
  );
  assert.ok(argv.includes("chuggy-jobs"));
});

test("a token file at a drive's root, or written with forward slashes, is refused before any start", () => {
  for (const claudeTokenFile of ["C:\\token", "C:/Users/op/claude/token"])
    assert.throws(
      () => chatHostSettings(identity, { ...config, claudeTokenFile }),
      /the credential's file is (in no directory of its own|no absolute path written plainly)/u,
      claudeTokenFile,
    );
});

test("a token file anyone else may open, or not alone in its directory, is refused", async (t) => {
  await machineDirectory(t);
  const file = await tokenAloneWritten(fixtureHome);
  const at = { ...config, claudeTokenFile: file };
  const { acls, sharedRefusal } = sharedFixture();
  assert.equal(await chatCredentialRefusal(at, sharedRefusal), undefined);
  acls.set(file, usersReadAcl);
  assert.equal(
    await chatCredentialRefusal(at, sharedRefusal),
    `the Claude token file ${file} ${usersRefusal}`,
  );
  acls.clear();
  await tokenAloneWritten(fixtureHome, ["pool.json"]);
  assert.equal(
    await chatCredentialRefusal(at, sharedRefusal),
    `C:\\Users\\op\\claude holds pool.json beside the credential ${file}, and a chat host's supervisor is handed the directory whole; keep the credential in a directory of its own`,
  );
});

/**
 * Catches a chat host started where a Claude credential of its set other
 * than the first is anyone else's to open or shares its directory, which the
 * supervisor is handed whole whichever credential a session runs on.
 */
test("every Claude credential of a set is held to what the supervisor is handed, not just the first", async (t) => {
  await machineDirectory(t);
  const first = await tokenAloneWritten(fixtureHome, [], "max-1");
  const second = await tokenAloneWritten(fixtureHome, [], "max-2");
  const at = /** @type {import("./runnerConfig.mjs").RunnerConfig} */ ({
    ...config,
    claudeTokenFile: undefined,
    claudeCredential: {
      prefer: "OAuthOnly",
      oauth: {
        order: "RoundRobin",
        credentials: [
          { name: "max-1", tokenFile: first },
          { name: "max-2", tokenFile: second },
        ],
      },
    },
  });
  const { acls, sharedRefusal } = sharedFixture();
  assert.equal(await chatCredentialRefusal(at, sharedRefusal), undefined);
  acls.set(second, usersReadAcl);
  assert.equal(
    await chatCredentialRefusal(at, sharedRefusal),
    `the Claude token file ${second} ${usersRefusal}`,
  );
  acls.clear();
  await tokenAloneWritten(fixtureHome, ["other.json"], "max-2");
  assert.equal(
    await chatCredentialRefusal(at, sharedRefusal),
    `C:\\Users\\op\\max-2 holds other.json beside the credential ${second}, and a chat host's supervisor is handed the directory whole; keep the credential in a directory of its own`,
  );
  const binds = chatSupervisorContainer(
    "img:1",
    chatHostPlaces(identity, at),
    2 ** 30,
  ).binds.map(({ source }) => source);
  assert.deepEqual(binds, ["C:\\Users\\op\\max-1", "C:\\Users\\op\\max-2"]);
});

test("a host whose plane denies it exits for the service not to start it again", async () => {
  const host = /** @type {any} */ ({
    run: async () => ({ passed: "Denied", evidence: "revoked" }),
    status: () => undefined,
  });
  assert.equal(await chatRunnerLoop(host), deniedExitStatus);
});
