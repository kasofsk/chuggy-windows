/**
 * A member's chat host composed: the worker core's chat host over Docker
 * Desktop, from the runner's file, with what of this machine the core cannot
 * know: who owns the Claude token file as Docker Desktop shows it.
 *
 * THE SUPERVISOR READS THE CLAUDE TOKEN FILE AS ROOT. Docker Desktop shows
 * every file and directory it binds from Windows as root's, open to every
 * user, inside a container, so root is the owner it is told and a session's
 * user, never root, reaches the file only through the copy it is handed.
 * Windows has no uid a session's could be, so no user is refused.
 *
 * THE HOST IS NOT UPDATED: it passes until the plane denies it, as a pool's
 * run does, since this runner does not install a release of itself.
 */

import { setTimeout as delay } from "node:timers/promises";

import {
  chatCredentialAloneRefusal,
  chatHost,
  chatHostConfigured,
  chatHostVolumes,
  chatSupervisorNaming,
  chatSupervisorStarted,
  checkedChatHostSettings,
} from "@chuggy/worker-core/chatHost.mjs";
import { chatSessionLogs } from "@chuggy/worker-core/chatHostLog.mjs";

import {
  engineEndpoint,
  poolRuntimeDirectory,
  runnerEngine,
} from "./runner.mjs";
import {
  credentialFileRefusal,
  runnerClaudeCredential,
} from "./runnerConfig.mjs";
import { deniedExitStatus } from "./serviceTask.mjs";

/**
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatHost} ChatHost
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatHostSettings} ChatHostSettings
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatSupervisorPlaces} ChatSupervisorPlaces
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./runner.mjs").RunnerSetup} RunnerSetup
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").SharedRefusal} SharedRefusal
 *
 * @typedef {object} ChatRunnerHost
 * @property {(line: string) => void} log
 * @property {SharedRefusal} sharedRefusal who besides this account may open a file
 * @property {Engine} [engine] when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] when not the host's issuer
 * @property {typeof globalThis.fetch} [fetch] what the plane is reached by, when not the global fetch
 * @property {typeof import("node:child_process").spawn} [spawn] what starts the engine's `run`, when not Node's own
 * @property {() => number} [nowMs]
 */

/** Who owns the Claude token file as Docker Desktop shows it inside a container: root. */
export const chatCredentialOwner = Object.freeze({ uid: 0, gid: 0 });

/**
 * What the supervisor's container is given of this machine: the host's
 * volumes, the Claude token file, owned as `chatCredentialOwner` says, and
 * its kind.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @returns {ChatSupervisorPlaces}
 */
export function chatHostPlaces(identity, config) {
  return {
    volumes: chatHostVolumes(identity),
    credentialFile: config.claudeTokenFile,
    credentialOwner: { ...chatCredentialOwner },
    claudeCredential: runnerClaudeCredential,
  };
}

/**
 * A chat host's settings from the runner's file, checked as the core checks
 * them against Docker Desktop.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @returns {ChatHostSettings}
 */
export function chatHostSettings(identity, config) {
  return checkedChatHostSettings(
    {
      ...chatHostConfigured(config.chat, config.outputBytesMax),
      places: chatHostPlaces(identity, config),
    },
    config.engine,
  );
}

/**
 * Why the Claude token file cannot be handed to the supervisor, or nothing:
 * it is not this account's alone, as a job's is not handed it, or is not
 * alone in its directory, which the supervisor is given whole.
 *
 * @param {RunnerConfig} config
 * @param {SharedRefusal} sharedRefusal
 * @returns {Promise<string | undefined>}
 */
export async function chatCredentialRefusal(config, sharedRefusal) {
  const file = config.claudeTokenFile;
  return (
    (await credentialFileRefusal(file, sharedRefusal)) ??
    (await chatCredentialAloneRefusal(file))
  );
}

/**
 * A member's chat host from the files read, its settings checked against
 * Docker Desktop and its credential against what the supervisor is handed,
 * and the runtime directory its pulls are made in.
 *
 * @param {RunnerSetup} setup
 * @param {ChatRunnerHost} host
 */
export async function chatRunnerParts(setup, host) {
  const { config, paths } = setup;
  const identity = /** @type {ChatHostIdentity} */ (setup.credentials);
  const settings = chatHostSettings(identity, config);
  const refusal = await chatCredentialRefusal(config, host.sharedRefusal);
  if (refusal !== undefined) throw new Error(refusal);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(engine);
  const runtime = poolRuntimeDirectory(paths, identity);
  const nowMs = host.nowMs ?? Date.now;
  const chat = chatHost(identity, settings, {
    engine,
    site: { engine: config.engine, runtimeDir: runtime, dockerHost },
    started: chatSupervisorStarted({
      engine,
      naming: chatSupervisorNaming(identity, config.network),
      ...(host.spawn === undefined ? {} : { spawn: host.spawn }),
    }),
    log: host.log,
    logFor: chatSessionLogs(paths.logs, identity, { log: host.log, nowMs }),
    sleep: (ms) => delay(ms),
    nowMs,
    ...(host.tokens === undefined ? {} : { tokens: host.tokens }),
    ...(host.fetch === undefined ? {} : { fetch: host.fetch }),
  });
  return { chat, engine, runtime };
}

/**
 * The chat host until the plane denies it, which the service does not start
 * again after; its supervisor has ended by then, and every session with it.
 *
 * @param {ChatHost} chat
 * @returns {Promise<number>} the exit status
 */
export async function chatRunnerLoop(chat) {
  await chat.run();
  return deniedExitStatus;
}
