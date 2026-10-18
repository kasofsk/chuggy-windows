/**
 * Who may open a file on Windows, whose mode bits say nothing of it: the
 * file's owner and access rules, read by PowerShell and named by SID, so no
 * account's display name or the system's language enters the decision. A
 * file is this user's alone where it is owned by this user, SYSTEM or the
 * Administrators, who are on Windows what root is on Linux, and every rule
 * that allows anything allows only them: an owner may rewrite the rules
 * whatever they say. A rule that denies narrows access and is never a
 * refusal.
 */

import { execFile } from "node:child_process";

/**
 * @typedef {{sid: string, rights: number, allow: boolean}} AclRule
 * @typedef {{owner: string, rules: AclRule[]}} Acl
 *
 * @typedef {(path: string) => Promise<Acl>} AclRead reads a path's access rules, or throws why it could not
 */

/** The well-known SIDs a refusal names by name, since they are the ones most often granted. */
const wellKnownSids = new Map([
  ["S-1-1-0", "Everyone"],
  ["S-1-5-11", "Authenticated Users"],
  ["S-1-5-32-545", "Users"],
  ["S-1-5-32-546", "Guests"],
  ["S-1-5-7", "Anonymous Logon"],
]);

/**
 * CREATOR OWNER, which stands in a directory's rules for whoever makes a file
 * in it, who is this account for every file the runner makes, and allows
 * nothing on the directory itself.
 */
const creatorOwnerSid = "S-1-3-0";

/** The SIDs that may open anything on the machine, whatever a file says. */
const machineSids = new Map([
  ["S-1-5-18", "SYSTEM"],
  ["S-1-5-32-544", "Administrators"],
]);

/**
 * Asks PowerShell for the path's rules, the path handed through the
 * environment so it is never parsed as script.
 */
const aclScript = [
  "$ErrorActionPreference = 'Stop'",
  "$acl = Get-Acl -LiteralPath $env:CHUGGY_WINDOWS_ACL_PATH",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "$rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; allow = ($_.AccessControlType -eq 'Allow') } })",
  "ConvertTo-Json -Compress -Depth 3 -InputObject @{ owner = $acl.GetOwner($sid).Value; rules = $rules }",
].join("; ");

/** The cap on one read, which guards a hung PowerShell and not a slow one. */
const aclReadTimeoutMs = 60_000;

/**
 * Reads the path's access rules with Windows PowerShell, which every Windows
 * has.
 *
 * @type {AclRead}
 */
export function aclRead(path) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        aclScript,
      ],
      {
        env: { ...process.env, CHUGGY_WINDOWS_ACL_PATH: path },
        timeout: aclReadTimeoutMs,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const [said] = stderr.trim().split(/\r?\n/u);
          reject(
            new Error(
              `the access rules of ${path} could not be read: ${said || error.message}`,
            ),
          );
          return;
        }
        try {
          resolve(aclParsed(stdout));
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
}

/**
 * PowerShell's answer, checked to be the rules it was asked for.
 *
 * @param {string} text
 * @returns {Acl}
 */
export function aclParsed(text) {
  const document = JSON.parse(text);
  const rules = document?.rules;
  const owner = document?.owner;
  if (
    typeof owner !== "string" ||
    !Array.isArray(rules) ||
    !rules.every(
      (rule) =>
        typeof rule?.sid === "string" &&
        Number.isSafeInteger(rule?.rights) &&
        typeof rule?.allow === "boolean",
    )
  )
    throw new Error("PowerShell answered no owner and access rules");
  return { owner, rules };
}

/** @param {string} sid */
function sidNamed(sid) {
  return wellKnownSids.has(sid)
    ? `${String(wellKnownSids.get(sid))} (${sid})`
    : sid;
}

/**
 * Why someone besides `userSid`, SYSTEM and the Administrators owns or may
 * open a path, said after its name, or nothing where no one else does.
 *
 * @param {Acl} acl
 * @param {string} userSid this runner's account's SID
 * @returns {string | undefined}
 */
export function aclSharedRefusal(acl, userSid) {
  const only = `only you, ${[...machineSids.values()].join(" and ")} may, as a file under %APPDATA% or %LOCALAPPDATA% is by default`;
  if (acl.owner !== userSid && !machineSids.has(acl.owner))
    return `is owned by ${sidNamed(acl.owner)}, who may open it whatever its rules say; ${only}`;
  const others = [
    ...new Set(
      acl.rules
        .filter(
          (rule) =>
            rule.allow &&
            rule.rights !== 0 &&
            rule.sid !== userSid &&
            rule.sid !== creatorOwnerSid &&
            !machineSids.has(rule.sid),
        )
        .map((rule) => rule.sid),
    ),
  ];
  if (others.length === 0) return undefined;
  return `can be opened by ${others.map(sidNamed).join(", ")} besides you; ${only}`;
}

/**
 * The account this process runs as, by SID, from `whoami`, which prints it in
 * a form no language changes.
 *
 * @returns {Promise<string>}
 */
export function currentUserSid() {
  return new Promise((resolve, reject) => {
    execFile(
      "whoami",
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true, timeout: aclReadTimeoutMs },
      (error, stdout) => {
        const sid = /"(S-1-[0-9-]+)"\s*$/u.exec(stdout.trim())?.[1];
        if (error === null && sid !== undefined) resolve(sid);
        else
          reject(
            new Error(
              `this account's SID could not be read from whoami: ${error?.message ?? stdout.trim()}`,
            ),
          );
      },
    );
  });
}
