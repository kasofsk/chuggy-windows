/**
 * The access-rule decision, on rules as PowerShell answers them. Reading a
 * file's rules runs PowerShell and reading this account's SID runs `whoami`,
 * neither of which a suite runs, so those two are left to the machine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { aclParsed, aclSharedRefusal } from "./windowsAcl.mjs";

const user = "S-1-5-21-1004336348-1177238915-682003330-1001";
const fullControl = 2032127;
const readAndExecute = 1179817;

/** What every refusal says after who else may open the file. */
const besides =
  "besides you; only you, SYSTEM and Administrators may, as a file under %APPDATA% or %LOCALAPPDATA% is by default";

/**
 * @param {Array<[string, number, boolean]>} rules each SID, rights and whether it allows
 */
function acl(rules, owner = user) {
  return {
    owner,
    rules: rules.map(([sid, rights, allow]) => ({ sid, rights, allow })),
  };
}

test("PowerShell's answer is read as the rules it lists, one rule or none", () => {
  assert.deepEqual(
    aclParsed(
      `{"owner":"${user}","rules":[{"sid":"${user}","rights":${String(fullControl)},"allow":true},{"sid":"S-1-1-0","rights":1,"allow":false}]}\r\n`,
    ),
    acl([
      [user, fullControl, true],
      ["S-1-1-0", 1, false],
    ]),
  );
  assert.deepEqual(aclParsed(`{"owner":"${user}","rules":[]}`), {
    owner: user,
    rules: [],
  });
});

test("an answer that is not the rules asked for is refused, and one that is not JSON is too", () => {
  for (const text of [
    "{}",
    '{"rules":[]}',
    '{"owner":1,"rules":[]}',
    '{"owner":"S-1-5-18","rules":{"sid":"S-1-1-0","rights":1,"allow":true}}',
    '{"owner":"S-1-5-18","rules":[{"sid":"S-1-1-0","rights":"1","allow":true}]}',
    '{"owner":"S-1-5-18","rules":[{"sid":"S-1-1-0","rights":1.5,"allow":true}]}',
    '{"owner":"S-1-5-18","rules":[{"sid":1,"rights":1,"allow":true}]}',
    '{"owner":"S-1-5-18","rules":[{"sid":"S-1-1-0","rights":1,"allow":"Allow"}]}',
    '{"owner":"S-1-5-18","rules":[null]}',
    "null",
  ])
    assert.throws(
      () => aclParsed(text),
      { message: "PowerShell answered no owner and access rules" },
      text,
    );
  assert.throws(() => aclParsed("Get-Acl : Cannot find path"), SyntaxError);
});

test("a file only this account, SYSTEM and the Administrators may open is no one else's", () => {
  assert.equal(
    aclSharedRefusal(
      acl([
        [user, fullControl, true],
        ["S-1-5-18", fullControl, true],
        ["S-1-5-32-544", fullControl, true],
      ]),
      user,
    ),
    undefined,
  );
  assert.equal(aclSharedRefusal({ owner: user, rules: [] }, user), undefined);
  for (const owner of ["S-1-5-18", "S-1-5-32-544"])
    assert.equal(aclSharedRefusal(acl([], owner), user), undefined, owner);
});

test("a rule that denies, or allows nothing, is never a refusal", () => {
  assert.equal(
    aclSharedRefusal(
      acl([
        [user, fullControl, true],
        ["S-1-1-0", fullControl, false],
        ["S-1-5-32-545", 0, true],
      ]),
      user,
    ),
    undefined,
  );
});

test("anyone else a rule allows is named, a well-known group by its name and SID and any other by SID, each once", () => {
  const other = "S-1-5-21-1004336348-1177238915-682003330-1002";
  assert.equal(
    aclSharedRefusal(
      acl([
        [user, fullControl, true],
        ["S-1-5-32-545", readAndExecute, true],
        ["S-1-5-32-545", fullControl, true],
        [other, 1, true],
        ["S-1-1-0", readAndExecute, true],
        ["S-1-5-11", readAndExecute, true],
        ["S-1-5-32-546", 1, true],
        ["S-1-5-7", 1, true],
      ]),
      user,
    ),
    `can be opened by Users (S-1-5-32-545), ${other}, Everyone (S-1-1-0), Authenticated Users (S-1-5-11), Guests (S-1-5-32-546), Anonymous Logon (S-1-5-7) ${besides}`,
  );
});

test("whose file it is decides: this account's own rule names another account where it runs as another", () => {
  const rules = acl(
    [
      [user, fullControl, true],
      ["S-1-5-18", fullControl, true],
    ],
    "S-1-5-18",
  );
  const another = "S-1-5-21-1004336348-1177238915-682003330-1003";
  assert.equal(
    aclSharedRefusal(rules, another),
    `can be opened by ${user} ${besides}`,
  );
});

test("a file another account owns is refused whatever its rules say, since its owner may rewrite them", () => {
  const other = "S-1-5-21-1-2-3-1002";
  assert.equal(
    aclSharedRefusal(acl([[user, fullControl, true]], other), user),
    `is owned by ${other}, who may open it whatever its rules say; only you, SYSTEM and Administrators may, as a file under %APPDATA% or %LOCALAPPDATA% is by default`,
  );
  assert.match(
    aclSharedRefusal(acl([], "S-1-1-0"), user) ?? "",
    /^is owned by Everyone \(S-1-1-0\),/u,
  );
});

test("a rule for CREATOR OWNER, which stands for whoever makes a file in a directory, is never a refusal", () => {
  assert.equal(
    aclSharedRefusal(
      acl([
        [user, fullControl, true],
        ["S-1-3-0", 268435456, true],
        ["S-1-5-18", fullControl, true],
      ]),
      user,
    ),
    undefined,
  );
  assert.equal(
    aclSharedRefusal(
      acl([
        ["S-1-3-0", 268435456, true],
        ["S-1-5-32-545", readAndExecute, true],
      ]),
      user,
    ),
    `can be opened by Users (S-1-5-32-545) ${besides}`,
  );
});
