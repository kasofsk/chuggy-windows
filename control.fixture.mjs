/**
 * A service answering on a pool's pipe for a suite that asks it: its backend
 * is placing what it is given, one assignment unless told otherwise, and
 * stops whatever it is asked to. Off Windows the pipe's name is a socket's
 * path in the suite's working directory.
 */

import { controlServer } from "@chuggy/worker-core/control.mjs";

/** @type {import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement} */
export const inFlightFixture = {
  assignment: "asg-1",
  kind: "Session",
  name: "chuggy-shame-x",
  image: "i",
  phase: "Pulling",
  deadlineEpochSecs: 1,
  memoryMib: 4096,
};

/**
 * @param {import("node:test").TestContext} t
 * @param {string} pipe
 * @param {readonly object[]} inFlight what the service answers it is placing
 */
export async function controlServed(t, pipe, inFlight = [inFlightFixture]) {
  /** @type {string[]} */
  const stopped = [];
  const backend =
    /** @type {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} */ (
      /** @type {unknown} */ ({
        inFlight: () => inFlight,
        stop: async (/** @type {string} */ assignment) => {
          stopped.push(assignment);
          return { stopped: "Stopped" };
        },
      })
    );
  const server = await controlServer(pipe, backend);
  t.after(() => server.close());
  return { stopped, backend };
}
