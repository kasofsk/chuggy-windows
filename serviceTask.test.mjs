import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";

import { registerPoolFileName } from "@chuggy/worker-core/register.mjs";
import {
  registeredFixture,
  registeredPersonalFixture,
} from "./register.fixture.mjs";
import {
  commandLine,
  powershellQuoted,
  samePath,
  serviceCommands,
  serviceCreateArgv,
  serviceDisableArgv,
  serviceEnableArgv,
  serviceEndArgv,
  serviceQueryArgv,
  taskQueried,
  serviceRunArgv,
  serviceStopCommands,
  serviceTask,
  serviceTaskBaseCharsMax,
  serviceTaskFileBytes,
  serviceTaskFolder,
  serviceTaskName,
  serviceTaskRepetition,
  taskArgumentQuoted,
  taskPoolFile,
  taskService,
} from "./serviceTask.mjs";

const pools = "C:\\Users\\op\\AppData\\Roaming\\chuggy\\pools";
const sid = "S-1-5-21-1004336348-1177238915-682003330-1001";

/** A service as an install under the profile runs it. */
const service = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  cli: "C:\\Users\\op\\AppData\\Roaming\\npm\\node_modules\\chuggy-windows\\cli.mjs",
  poolFile: `${pools}\\newtenant.arbbot.shame.json`,
};

test("a pool file's task is named for the file less .json, in the runner's own folder", () => {
  assert.equal(serviceTaskFolder, "\\chuggy-windows\\");
  assert.equal(
    serviceTaskName(service.poolFile),
    "\\chuggy-windows\\newtenant.arbbot.shame",
  );
  assert.equal(serviceTaskName("D:\\pools\\pool"), "\\chuggy-windows\\pool");
  assert.equal(
    serviceTaskName("C:\\p\\a.json.json"),
    "\\chuggy-windows\\a.json",
  );
  assert.equal(
    serviceTaskName(`${pools}/vteng.chuggy.my_pool-2.json`),
    "\\chuggy-windows\\vteng.chuggy.my_pool-2",
  );
});

test("a pool file whose name carries a character Task Scheduler may reserve makes no task name, and says what to name it", () => {
  for (const base of ["my pool", "a&b", "a%b", "naïve", "a:b", "a'b", "a(1)"])
    assert.throws(
      () => serviceTaskName(`C:\\p\\${base}.json`),
      {
        name: "RangeError",
        message: `C:\\p\\${base}.json makes a task name with a character other than a letter, digit, ".", "_" or "-"; give the pool file such a name`,
      },
      base,
    );
});

test("a task name is at most serviceTaskBaseCharsMax characters less its folder", () => {
  const longest = "a".repeat(serviceTaskBaseCharsMax);
  assert.equal(
    serviceTaskName(`C:\\p\\${longest}.json`),
    `\\chuggy-windows\\${longest}`,
  );
  assert.throws(() => serviceTaskName(`C:\\p\\${longest}a.json`), {
    name: "RangeError",
    message: `C:\\p\\${longest}a.json makes a task name longer than this runner gives one; give the pool file a shorter name`,
  });
});

test("every pool file register writes under the bound makes a task name, a long identity's digest too", () => {
  const long = { ...registeredFixture, tenant: "t".repeat(250) };
  for (const identity of [registeredFixture, registeredPersonalFixture, long]) {
    const name = registerPoolFileName(identity, serviceTaskBaseCharsMax);
    assert.ok(
      serviceTaskName(`${pools}\\${name}`).startsWith(serviceTaskFolder),
      name,
    );
  }
});

test("a task argument is quoted where it holds anything but a path's plain characters, and refused where quoting cannot carry it", () => {
  for (const bare of ["--headless", "service", "C:\\x\\node.exe", "a/b-c_d.e"])
    assert.equal(taskArgumentQuoted(bare), bare);
  for (const quoted of ["C:\\Program Files\\x", "a&b", "a'b", "ä", ""])
    assert.equal(taskArgumentQuoted(quoted), `"${quoted}"`);
  for (const refused of ['a"b', "C:\\x\\", "C:\\%USERNAME%\\x", "a%b"])
    assert.throws(() => taskArgumentQuoted(refused), {
      name: "RangeError",
      message: `${refused} cannot be quoted in a task's command line`,
    });
});

test("the task runs the service headless at each logon and on its repetition, as this account only while it is logged on, never twice at once and never stopped for running long", () => {
  const definition = serviceTask(service, sid);
  assert.ok(
    definition.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n'),
  );
  assert.ok(definition.endsWith("</Task>\r\n"));
  assert.ok(!/[^\r]\n/u.test(definition), "every line ends CRLF");
  for (const element of [
    `<LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger>`,
    `<Repetition><Interval>${serviceTaskRepetition}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`,
    `<Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<StartWhenAvailable>true</StartWhenAvailable>",
    "<Priority>5</Priority>",
    `<Exec><Command>conhost.exe</Command><Arguments>--headless &quot;${service.node}&quot; ${service.cli} service --pool ${service.poolFile}</Arguments></Exec>`,
  ])
    assert.ok(definition.includes(element), element);
  assert.equal(serviceTaskRepetition, "PT5M");
});

test("what a task runs is read back from its definition, whatever its paths hold that XML or a command line must escape", () => {
  for (const paths of [
    service,
    {
      node: "C:\\Program Files (x86)\\node & co\\node.exe",
      cli: "C:\\Users\\O'Brien\\npm\\<chuggy>\\cli.mjs",
      poolFile: "C:\\Users\\R&D\\AppData\\Roaming\\chuggy\\pools\\a&b.json",
    },
    { node: "C:\\n\\node.exe", cli: "C:\\ü\\cli.mjs", poolFile: "C:\\p.json" },
  ]) {
    const definition = serviceTask(paths, sid);
    const raw = /<Arguments>([^<]*)<\/Arguments>/u.exec(definition)?.[1] ?? "";
    assert.ok(!/&(?!amp;|lt;|gt;|quot;)|>/u.test(raw), raw);
    assert.deepEqual(taskService(definition), paths);
    assert.equal(taskPoolFile(definition), paths.poolFile);
  }
  const escaped = serviceTask(
    { node: "C:\\n.exe", cli: "C:\\c.mjs", poolFile: "C:\\R&D\\p.json" },
    sid,
  );
  assert.match(
    escaped,
    /--pool &quot;C:\\R&amp;D\\p\.json&quot;<\/Arguments>/u,
  );
});

test("a definition is read back as Task Scheduler prints it, with its own escapes and the console host's name in any case", () => {
  const quoted = { ...service, cli: "C:\\Users\\O'Brien\\cli.mjs" };
  const printed = serviceTask(quoted, sid)
    .replace("conhost.exe", "CONHOST.EXE")
    .replace("O'Brien", "O&apos;Brien");
  assert.ok(printed.includes("O&apos;Brien"));
  assert.deepEqual(taskService(printed), quoted);
});

test("a task this runner did not write serves no pool file", () => {
  const definition = serviceTask(service, sid);
  const arguments_ = /<Arguments>[^<]*<\/Arguments>/u;
  for (const other of [
    definition.replace("conhost.exe", "C:\\Windows\\System32\\conhost.exe"),
    definition.replace("conhost.exe", "node.exe"),
    definition.replace(
      arguments_,
      "<Arguments>--headless a b run --pool c</Arguments>",
    ),
    definition.replace(
      arguments_,
      "<Arguments>a b c service --pool d</Arguments>",
    ),
    definition.replace(
      arguments_,
      "<Arguments>--headless a b service -p c</Arguments>",
    ),
    definition.replace(
      arguments_,
      "<Arguments>--headless a b service --pool c d</Arguments>",
    ),
    definition.replace(arguments_, ""),
    "",
  ]) {
    assert.equal(taskService(other), undefined, other);
    assert.equal(taskPoolFile(other), undefined);
  }
});

test("the definition's file is UTF-16 little-endian behind its byte order mark", () => {
  const definition = serviceTask(service, sid);
  const bytes = serviceTaskFileBytes(definition);
  assert.deepEqual([...bytes.subarray(0, 4)], [0xff, 0xfe, 0x3c, 0x00]);
  assert.equal(bytes.length, 2 * (definition.length + 1));
  assert.equal(bytes.subarray(2).toString("utf16le"), definition);
  assert.deepEqual(
    [...serviceTaskFileBytes("ü&")],
    [0xff, 0xfe, 0xfc, 0x00, 0x26, 0x00],
  );
});

test("a command the operator is told to run is quoted for PowerShell only where an argument needs it", () => {
  for (const bare of [
    "schtasks",
    "/Run",
    "\\chuggy-windows\\pool",
    "C:\\p.json",
    "--token=t",
  ])
    assert.equal(powershellQuoted(bare), bare);
  for (const [argument, quoted] of [
    ["C:\\Program Files\\x", "'C:\\Program Files\\x'"],
    ["O'Brien", "'O''Brien'"],
    ["$env:APPDATA", "'$env:APPDATA'"],
    ["a&b;c", "'a&b;c'"],
    ["", "''"],
  ])
    assert.equal(powershellQuoted(argument), quoted);
  assert.equal(
    commandLine([
      "chuggy-windows",
      "doctor",
      "--pool",
      "C:\\Users\\O'Brien\\p.json",
    ]),
    "chuggy-windows doctor --pool 'C:\\Users\\O''Brien\\p.json'",
  );
});

test("each schtasks command names the task by /TN, and registering one replaces one of the name", () => {
  const name = "\\chuggy-windows\\pool";
  assert.deepEqual(serviceCreateArgv(name, "C:\\t.xml"), [
    "schtasks",
    "/Create",
    "/TN",
    name,
    "/XML",
    "C:\\t.xml",
    "/F",
  ]);
  assert.deepEqual(serviceRunArgv(name), ["schtasks", "/Run", "/TN", name]);
  assert.deepEqual(serviceEndArgv(name), ["schtasks", "/End", "/TN", name]);
  assert.deepEqual(serviceEnableArgv(name), [
    "schtasks",
    "/Change",
    "/TN",
    name,
    "/ENABLE",
  ]);
  assert.deepEqual(serviceDisableArgv(name), [
    "schtasks",
    "/Change",
    "/TN",
    name,
    "/DISABLE",
  ]);
});

test("a registered task is started by running it, and stopped by disabling it before ending it", () => {
  const name = "\\chuggy-windows\\pool";
  assert.deepEqual(serviceCommands(name), [`schtasks /Run /TN ${name}`]);
  assert.deepEqual(serviceStopCommands(name), [
    `schtasks /Change /TN ${name} /DISABLE`,
    `schtasks /End /TN ${name}`,
  ]);
});

test("a task's definition is read back by PowerShell's export, as base64 of its UTF-8, so no code page loses a character of a path", () => {
  const name = "\\chuggy-windows\\vteng.chuggy.shame";
  const argv = serviceQueryArgv(name);
  assert.deepEqual(argv.slice(0, 6), [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.match(
    argv[6],
    /Export-ScheduledTask -TaskPath '\\chuggy-windows\\' -TaskName 'vteng\.chuggy\.shame'/u,
  );
  const definition = serviceTask(
    {
      node: "C:\\Program Files\\nodejs\\node.exe",
      cli: "C:\\Users\\Jürgen Ölmann\\npm\\cli.mjs",
      poolFile:
        "C:\\Users\\Jürgen Ölmann\\AppData\\Roaming\\chuggy\\pools\\é中.json",
    },
    "S-1-5-21-1-2-3-1001",
  );
  const encoded = Buffer.from(definition, "utf8").toString("base64");
  assert.equal(taskQueried({ code: 0, stdout: `${encoded}\r\n` }), definition);
  assert.equal(taskQueried({ code: 1, stdout: "" }), undefined);
  assert.equal(taskQueried({ code: 0, stdout: "not base64!" }), undefined);
});

test("a name no task of this runner's could have is never put in PowerShell's script", () => {
  for (const name of [
    "\\chuggy-windows\\a'b",
    "\\chuggy-windows\\a b",
    "\\x';Remove-Item\\a",
  ])
    assert.throws(() => serviceQueryArgv(name), RangeError);
});

test("two paths are the same file where Windows would read them so, whatever their case, separators or dot segments", () => {
  for (const [first, second] of [
    ["C:\\Users\\op\\pool.json", "c:\\users\\OP\\POOL.JSON"],
    ["C:\\Users\\op\\pools/a.json", "C:\\Users\\op\\pools\\a.json"],
    ["C:\\Users\\op\\x\\..\\pool.json", "C:\\Users\\op\\pool.json"],
    ["C:\\Users\\op\\.\\pool.json", "C:\\Users\\op\\pool.json"],
  ])
    assert.equal(samePath(first, second), true, `${first} ${second}`);
  for (const [first, second] of [
    ["C:\\Users\\op\\pool.json", "D:\\Users\\op\\pool.json"],
    ["C:\\Users\\op\\pool.json", "C:\\Users\\op\\pool.json.old"],
    ["C:\\Users\\op\\pool.json", "C:\\Users\\other\\pool.json"],
  ])
    assert.equal(samePath(first, second), false, `${first} ${second}`);
});
