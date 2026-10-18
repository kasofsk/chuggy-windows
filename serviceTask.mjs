/**
 * The scheduled task a pool's service runs under, one per pool file in the
 * runner's own folder, so several pools serve from one machine. It starts at
 * logon, and again on a repetition that starts nothing while it runs, which
 * brings back a service that ended for any reason. What restarts the runner
 * after a failure is the service itself, `supervisor.mjs`, since Task
 * Scheduler restarts nothing a task's process ended with.
 *
 * The task runs as its user, only while they are logged on, as Docker Desktop
 * does, under `conhost --headless`, so no console window opens. Ending it ends
 * that console host and nothing beneath it, so the service watches for that
 * itself.
 */

import { Buffer } from "node:buffer";
import { win32 } from "node:path";

/** The exit status of a run the plane ended by denying the pool. */
export const deniedExitStatus = 3;

/** The folder in Task Scheduler's library that holds every pool's task. */
export const serviceTaskFolder = "\\chuggy-windows\\";

/** What a task's name may carry: no character Task Scheduler reserves. */
const serviceTaskNamePattern = /^[A-Za-z0-9._-]+$/u;

/** The longest name, less its folder, this runner gives a pool's task. */
export const serviceTaskBaseCharsMax = 200;

/** How often the task is started again, to bring back a service that ended. */
export const serviceTaskRepetition = "PT5M";

/**
 * The task serving a pool file, named for the file less `.json` and placed in
 * the runner's folder.
 *
 * @param {string} poolFile
 */
export function serviceTaskName(poolFile) {
  const base = win32.basename(poolFile, ".json");
  if (!serviceTaskNamePattern.test(base))
    throw new RangeError(
      `${poolFile} makes a task name with a character other than a letter, digit, ".", "_" or "-"; give the pool file such a name`,
    );
  if (base.length > serviceTaskBaseCharsMax)
    throw new RangeError(
      `${poolFile} makes a task name longer than this runner gives one; give the pool file a shorter name`,
    );
  return `${serviceTaskFolder}${base}`;
}

/**
 * One argument of the task's command line, quoted as Windows programs split
 * one. A path holds no `"`, and a file's path never ends in `\`, the two
 * things such quoting would have to escape. Task Scheduler expands a
 * `%NAME%` inside the line, quoted or not, so an argument with a `%` is
 * refused rather than changed when the task starts.
 *
 * @param {string} argument
 */
export function taskArgumentQuoted(argument) {
  if (
    argument.includes('"') ||
    argument.includes("%") ||
    argument.endsWith("\\")
  )
    throw new RangeError(
      `${argument} cannot be quoted in a task's command line`,
    );
  return /^[A-Za-z0-9_.:\\/-]+$/u.test(argument) ? argument : `"${argument}"`;
}

/** @param {string} text */
function xmlEscaped(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** @param {string} text */
function xmlUnescaped(text) {
  return text.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (_, name) =>
      /** @type {Record<string, string>} */ ({
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      })[name],
  );
}

/** What runs the service without a console window. */
const consoleHost = "conhost.exe";

/**
 * The command line the task runs.
 *
 * @param {{node: string, cli: string, poolFile: string}} service absolute paths
 */
function serviceArguments(service) {
  return [
    "--headless",
    service.node,
    service.cli,
    "service",
    "--pool",
    service.poolFile,
  ]
    .map(taskArgumentQuoted)
    .join(" ");
}

/**
 * The task's definition, as Task Scheduler reads it.
 *
 * @param {{node: string, cli: string, poolFile: string}} service absolute paths
 * @param {string} userSid the account it runs as, which is the one it starts for at logon
 */
export function serviceTask(service, userSid) {
  const user = xmlEscaped(userSid);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>chuggy-windows: a chuggy worker pool's jobs in containers</Description></RegistrationInfo>",
    "  <Triggers>",
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>`,
    `    <TimeTrigger><Enabled>true</Enabled><StartBoundary>2000-01-01T00:00:00</StartBoundary><Repetition><Interval>${serviceTaskRepetition}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>`,
    "  </Triggers>",
    `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <Priority>5</Priority>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    `    <Exec><Command>${consoleHost}</Command><Arguments>${xmlEscaped(serviceArguments(service))}</Arguments></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/**
 * The definition as the file `schtasks /Create /XML` reads, which must be
 * UTF-16 with its byte order mark.
 *
 * @param {string} definition
 */
export function serviceTaskFileBytes(definition) {
  return Buffer.from(`\ufeff${definition}`, "utf16le");
}

/**
 * A command line split as `taskArgumentQuoted` joins one.
 *
 * @param {string} line
 */
function taskArgumentsSplit(line) {
  return [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map(
    ([, quoted, bare]) => quoted ?? bare,
  );
}

/**
 * What a task runs, read back from a definition exactly as `serviceTask`
 * writes one, or nothing for any other.
 *
 * @param {string} definition the task's XML, as `schtasks /Query /XML` prints it
 * @returns {{node: string, cli: string, poolFile: string} | undefined}
 */
export function taskService(definition) {
  const command = /<Command>([^<]*)<\/Command>/u.exec(definition)?.[1];
  const line = /<Arguments>([^<]*)<\/Arguments>/u.exec(definition)?.[1];
  if (command === undefined || line === undefined) return undefined;
  if (xmlUnescaped(command).toLowerCase() !== consoleHost) return undefined;
  const argv = taskArgumentsSplit(xmlUnescaped(line));
  if (
    argv.length !== 6 ||
    argv[0] !== "--headless" ||
    argv[3] !== "service" ||
    argv[4] !== "--pool"
  )
    return undefined;
  const [, node, cli, , , poolFile] = argv;
  return { node, cli, poolFile };
}

/**
 * Whether two absolute paths name one file as Windows reads them, which is
 * without regard to case.
 *
 * @param {string} first
 * @param {string} second
 */
export function samePath(first, second) {
  return (
    win32.resolve(first).toLowerCase() === win32.resolve(second).toLowerCase()
  );
}

/**
 * The pool file a task this runner wrote serves, or nothing for a task it did
 * not write.
 *
 * @param {string} definition
 */
export function taskPoolFile(definition) {
  return taskService(definition)?.poolFile;
}

/**
 * One argument of a command the operator is told to run, quoted for
 * PowerShell unless it holds only characters PowerShell reads as themselves.
 *
 * @param {string} argument
 */
export function powershellQuoted(argument) {
  return /^[A-Za-z0-9_.:\\/=-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "''")}'`;
}

/**
 * A command as the operator types it, each argument `powershellQuoted`.
 *
 * @param {readonly string[]} argv
 */
export function commandLine(argv) {
  return argv.map(powershellQuoted).join(" ");
}

/**
 * What registers a task from its definition's file, replacing one of the
 * name.
 *
 * @param {string} name
 * @param {string} file
 */
export function serviceCreateArgv(name, file) {
  return ["schtasks", "/Create", "/TN", name, "/XML", file, "/F"];
}

/**
 * What reads a task's definition back. `schtasks /Query /XML` prints it in the
 * console's code page, which loses any character of a path that page lacks,
 * so PowerShell exports it instead, as base64 of its UTF-8, which no code page
 * changes. A name `serviceTaskName` gives holds no quote to escape.
 *
 * @param {string} name
 */
export function serviceQueryArgv(name) {
  const split = name.lastIndexOf("\\") + 1;
  const [folder, task] = [name.slice(0, split), name.slice(split)];
  if (
    !serviceTaskNamePattern.test(task) ||
    !/^[\\A-Za-z0-9._-]+$/u.test(folder)
  )
    throw new RangeError(`${name} is no task name this runner gives`);
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$ErrorActionPreference = 'Stop'; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Export-ScheduledTask -TaskPath '${folder}' -TaskName '${task}')))`,
  ];
}

/**
 * The definition `serviceQueryArgv` read, or nothing where there is no such
 * task or it could not be read.
 *
 * @param {{code: number, stdout: string}} answer
 * @returns {string | undefined}
 */
export function taskQueried(answer) {
  if (answer.code !== 0) return undefined;
  const encoded = answer.stdout.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined;
  return Buffer.from(encoded, "base64").toString("utf8");
}

/** @param {string} name */
export function serviceDeleteArgv(name) {
  return ["schtasks", "/Delete", "/TN", name, "/F"];
}

/** @param {string} name */
export function serviceRunArgv(name) {
  return ["schtasks", "/Run", "/TN", name];
}

/** @param {string} name */
export function serviceEndArgv(name) {
  return ["schtasks", "/End", "/TN", name];
}

/** @param {string} name */
export function serviceEnableArgv(name) {
  return ["schtasks", "/Change", "/TN", name, "/ENABLE"];
}

/** @param {string} name */
export function serviceDisableArgv(name) {
  return ["schtasks", "/Change", "/TN", name, "/DISABLE"];
}

/**
 * What the operator runs once a task is registered: started now, as it would
 * be at their next logon.
 *
 * @param {string} name
 */
export function serviceCommands(name) {
  return [serviceRunArgv(name)].map(commandLine);
}

/**
 * What stops a pool's service until it is started again: the task disabled,
 * so its repetition does not bring it back, then ended.
 *
 * @param {string} name
 */
export function serviceStopCommands(name) {
  return [serviceDisableArgv(name), serviceEndArgv(name)].map(commandLine);
}
