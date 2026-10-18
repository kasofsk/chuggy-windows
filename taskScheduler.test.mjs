/**
 * How a command is run and answered, shown with this Node standing in for
 * `schtasks`, which no suite runs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { taskSchedulerCalled } from "./taskScheduler.mjs";

test("a command that ran is answered with its exit code and both streams, whatever the code", async () => {
  assert.deepEqual(
    await taskSchedulerCalled([
      process.execPath,
      "-e",
      'process.stdout.write("SUCCESS: done\\r\\n"); process.stderr.write("noted")',
    ]),
    { code: 0, stdout: "SUCCESS: done\r\n", stderr: "noted" },
  );
  assert.deepEqual(
    await taskSchedulerCalled([
      process.execPath,
      "-e",
      'process.stderr.write("ERROR: Access is denied.\\r\\n"); process.exitCode = 5',
    ]),
    { code: 5, stdout: "", stderr: "ERROR: Access is denied.\r\n" },
  );
});

test("its arguments reach it as given, never through a shell", async () => {
  const argument = '\\chuggy-windows\\pool & echo "x" | more';
  const answer = await taskSchedulerCalled([
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    argument,
    "$env:PATH",
  ]);
  assert.deepEqual(JSON.parse(answer.stdout), [argument, "$env:PATH"]);
});

test("a command that could not start is answered with code -1 and why on its stderr", async () => {
  const answer = await taskSchedulerCalled(["chuggy-windows-no-such-command"]);
  assert.equal(answer.code, -1);
  assert.equal(answer.stdout, "");
  assert.match(answer.stderr, /ENOENT/u);
});
