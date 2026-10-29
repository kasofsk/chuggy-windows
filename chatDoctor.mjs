/**
 * What `doctor` checks of a member's chat host beyond what it checks of any
 * pool: its settings and the memory its supervisor is capped at; the Claude
 * token file's directory, which the supervisor is given whole; a
 * supervisor's container no service here runs, which refuses every start;
 * and the image the supervisor runs, which doctor pulls where it is not
 * here, as a run would before starting it.
 *
 * A SERVICE THAT HOLDS THE HOST IS THERE, whether or not this copy can read
 * what it says or ask it in time: its supervisor's container is its own, and
 * nothing here says to remove it.
 */

import {
  chatCredentialAloneRefusal,
  chatHostMemoryBytes,
  chatHostStatusAsked,
  chatSupervisorName,
} from "@chuggy/worker-core/chatHost.mjs";
import {
  imageInspectArgv,
  inspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import {
  imageRegistryHost,
  registryPull,
} from "@chuggy/worker-core/registryAuth.mjs";

import { chatHostSettings } from "./chatRunner.mjs";
import { poolServiceFound, poolServiceWithin } from "./poolService.mjs";

/**
 * @typedef {import("@chuggy/worker-core/chatHost.mjs").ChatHostStatus} ChatHostStatus
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").ChatHostIdentity} ChatHostIdentity
 * @typedef {import("./doctor.mjs").DoctorFinding} DoctorFinding
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/registryAuth.mjs").PullSite} PullSite
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {{none: true} | {status: ChatHostStatus} | {unreadable: string}} ChatDoctorService nothing holds the host, or its holder answers what this copy reads, or it answers what it cannot, or not in time
 */

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Whether the Claude token file is in a directory of its own, which the
 * supervisor is given whole.
 *
 * @param {RunnerConfig} config
 * @returns {Promise<DoctorFinding>}
 */
export async function chatCredentialDirectoryFinding(config) {
  const check = "chat credential directory";
  const file = config.claudeTokenFile;
  const refusal = await chatCredentialAloneRefusal(file);
  return refusal === undefined
    ? {
        check,
        passed: true,
        detail: `${file} is alone in its directory, which the chat supervisor is given read-only`,
      }
    : { check, passed: false, detail: refusal };
}

/**
 * Whether the host's settings start a supervisor on Docker Desktop, as a run
 * checks them, and the memory it is capped at: room for each session it runs
 * at once, with no swap past it.
 *
 * @param {ChatHostIdentity} identity
 * @param {RunnerConfig} config
 * @returns {DoctorFinding}
 */
export function chatSettingsFinding(identity, config) {
  const check = "chat settings";
  try {
    const settings = chatHostSettings(identity, config);
    /** @param {number} bytes */
    const mib = (bytes) => String(Math.floor(bytes / 2 ** 20));
    return {
      check,
      passed: true,
      detail: `docker is asked to cap the supervisor at ${mib(chatHostMemoryBytes(settings))} MiB, ${mib(settings.sessionMemoryBytes)} MiB for each of its ${String(settings.sessionsMax)} sessions at once, with no swap past it`,
    };
  } catch (failure) {
    return { check, passed: false, detail: failureMessage(failure) };
  }
}

/**
 * What the service holding the host whose runtime directory is `runtime`
 * says of it, told apart from nothing holding it, which is the only answer
 * read as no service: one that answers what this copy cannot read, or not
 * within the time an ask is given, is still there.
 *
 * @param {string} runtime
 * @param {import("./poolService.mjs").PoolLocking} [locking]
 * @returns {Promise<ChatDoctorService>}
 */
export async function chatServiceAsked(runtime, locking) {
  try {
    const holder = await poolServiceFound(runtime, locking);
    if (holder === undefined) return { none: true };
    const status = await poolServiceWithin(
      holder.pipe,
      chatHostStatusAsked(holder.pipe),
    );
    return status === undefined ? { none: true } : { status };
  } catch (failure) {
    return { unreadable: failureMessage(failure) };
  }
}

/**
 * Whether a supervisor's container is left that no service here runs: one of
 * the host's name that is running while no service answers, or while the
 * one that answers runs no supervisor and is starting none, refuses every
 * start of the host's, which never kills it. One whose service answers what
 * this copy cannot read is that service's, and is warned of, never named for
 * removal. One that has exited is removed by the next start.
 *
 * The service is asked only once the container is seen running, so a start
 * landing between the two finds the service already starting it.
 *
 * @param {Engine} engine
 * @param {ChatHostIdentity} identity
 * @param {() => Promise<ChatDoctorService>} serviceAsked asks the host's service what it says of itself
 * @returns {Promise<DoctorFinding>}
 */
export async function chatSupervisorFinding(engine, identity, serviceAsked) {
  const check = "chat supervisor";
  const container = chatSupervisorName(identity);
  const inspected = await engine.exec(inspectArgv([container]));
  if (inspected.code !== 0)
    return engineFailure(inspected) === "NoSuchContainer"
      ? { check, passed: true, detail: `no container ${container} is here` }
      : { check, passed: false, detail: engineFailureLine(inspected) };
  let running;
  try {
    running = JSON.parse(inspected.stdout)[0]?.State?.Status === "running";
  } catch {
    return {
      check,
      passed: false,
      detail: `docker container inspect ${container} answered no JSON`,
    };
  }
  if (!running)
    return {
      check,
      passed: true,
      detail: `${container} has exited, and the next start removes it`,
    };
  const service = await serviceAsked();
  if ("unreadable" in service)
    return {
      check,
      passed: true,
      warning: true,
      detail: `${container} is running, and the service holding the host answers what this copy could not read, so it is taken as that service's: ${service.unreadable}`,
    };
  const status = "status" in service ? service.status : undefined;
  if (
    status !== undefined &&
    (status.starting ||
      (status.supervisor !== "Absent" && status.supervisor !== "Ended"))
  )
    return {
      check,
      passed: true,
      detail: `${container} is the service's supervisor, ${status.supervisor.toLowerCase()}${status.starting ? ", starting" : ""}`,
    };
  return {
    check,
    passed: false,
    detail: `${container} is running and no service here runs it, so every start of this host's supervisor is refused; remove it with docker rm -f ${container}, which ends every session it runs`,
  };
}

/**
 * Whether the supervisor's image is here or can be pulled, as a run pulls
 * it: the host's own as its setting says, or the one the plane names, under
 * the pool's token where it is in the pool's registry.
 *
 * @param {object} reach
 * @param {Engine} reach.engine
 * @param {PullSite} reach.site
 * @param {PoolCredentials} reach.credentials
 * @param {WorkerPoolClient["tokens"]} reach.tokens
 * @param {RunnerConfig["chat"]} chat
 * @param {string | undefined} named the image the plane named, where it was polled
 * @returns {Promise<DoctorFinding>}
 */
export async function chatImageFinding(reach, chat, named) {
  const check = "chat image";
  const own = chat?.image;
  const image = own?.image ?? named;
  if (image === undefined)
    return {
      check,
      passed: false,
      detail:
        "the plane named no session image and the runner's file sets no chat.image, so no supervisor can start",
    };
  const whose = own === undefined ? "the plane's" : "the host's own";
  if ((await reach.engine.exec(imageInspectArgv(image))).code === 0)
    return {
      check,
      passed: true,
      detail: `${whose} ${image} is here${own?.pull === "always" ? ", and is pulled again before each start" : ""}`,
    };
  if (own?.pull === "never")
    return {
      check,
      passed: false,
      detail: `${whose} ${image} is not here, and chat.image.pull is never`,
    };
  const registry = imageRegistryHost(image);
  let credential;
  if (own === undefined && registry === reach.credentials.registryHost) {
    const acquired = await reach.tokens.acquire();
    if (acquired.acquired !== "Token")
      return {
        check,
        passed: false,
        detail: `the pool has no token to pull ${image} with: ${acquired.evidence}`,
      };
    credential = { host: registry, token: acquired.token };
  }
  const answer = await registryPull(
    reach.site,
    image,
    undefined,
    credential,
    (argv, environment) => reach.engine.exec(argv, { environment }),
  );
  return answer.code === 0
    ? { check, passed: true, detail: `${whose} ${image} was pulled` }
    : {
        check,
        passed: false,
        detail: `${whose} ${image} could not be pulled: ${engineFailureLine(answer)}`,
      };
}
