"use strict";

const { spawn } = require("node:child_process");
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } = require("node:crypto");
const { win32 } = require("node:path");

const SERVICE = "bone.token.statistics.balance-configs.v1";
const OUTPUT_LIMIT = 192 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const KEY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function storageError(code = "STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("Could not access encrypted balance configurations"), { code });
}

function runCommand(command, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    const chunks = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        failed = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stdin.on("error", () => { failed = true; });
    child.once("error", () => {
      clearTimeout(timer);
      reject(storageError());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code === null) reject(storageError());
      else resolve({ code, stdout: Buffer.concat(chunks).toString("utf8").trim() });
    });
    child.stdin.end(input);
  });
}

function decode(value, size) {
  if (typeof value !== "string" || value.length === 0 || value.length > OUTPUT_LIMIT) throw storageError("STORAGE_DAMAGED");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value || (size !== undefined && data.length !== size)) throw storageError("STORAGE_DAMAGED");
  return data;
}

function accountFor(directory, id) {
  return createHash("sha256").update(directory).update("\0").update(id).digest("hex");
}

function systemKeyring(platform, run, env) {
  if (platform === "darwin") {
    return {
      read: (account) => run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], "", env),
      // Only generated hex values reach the command interpreter, through stdin.
      write: (account, key) => run("/usr/bin/security", ["-q", "-i"],
        `add-generic-password -a ${account} -s ${SERVICE} -w ${key}\n`, env),
    };
  }
  if (platform === "linux") {
    const bus = env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
    const processEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: bus };
    return {
      read: (account) => run("/usr/bin/secret-tool", ["lookup", "service", SERVICE, "account", account], "", processEnv),
      write: (account, key) => run("/usr/bin/secret-tool", ["store", "--label=Token Statistics", "service", SERVICE, "account", account], key, processEnv),
    };
  }
  throw storageError();
}

async function readKey(keyring, account) {
  const result = await keyring.read(account);
  if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(result.stdout)) throw storageError();
  return Buffer.from(result.stdout, "hex");
}

async function createKey(keyring, account) {
  const key = randomBytes(32);
  try {
    const result = await keyring.write(account, key.toString("hex"));
    if (result.code !== 0) throw storageError();
    const verified = await readKey(keyring, account);
    const matches = key.equals(verified);
    verified.fill(0);
    if (!matches) throw storageError();
    return key;
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

function dpapiCommand(directory, open) {
  const purpose = createHash("sha256").update(SERVICE).update("\0").update(directory).digest("base64");
  const verb = open ? "Unprotect" : "Protect";
  const script = `$ErrorActionPreference = 'Stop'\n` +
    `Add-Type -AssemblyName System.Security\n` +
    `$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())\n` +
    `$entropy = [Convert]::FromBase64String('${purpose}')\n` +
    `$result = [Security.Cryptography.ProtectedData]::${verb}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)\n` +
    `[Console]::Write([Convert]::ToBase64String($result))`;
  return Buffer.from(script, "utf16le").toString("base64");
}

function createCredentialProtector({ platform = process.platform, run = runCommand, env = process.env } = {}) {
  async function dpapi(directory, bytes, open) {
    if (typeof env.SystemRoot !== "string" || !win32.isAbsolute(env.SystemRoot)) throw storageError();
    const executable = win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", dpapiCommand(directory, open)];
    const result = await run(executable, args, bytes.toString("base64"), env);
    if (result.code !== 0) throw storageError();
    return decode(result.stdout);
  }

  return {
    async seal(directory, bytes, previous) {
      if (platform === "win32") {
        return { method: "dpapi", data: (await dpapi(directory, bytes, false)).toString("base64") };
      }
      const id = previous?.keyId ?? randomUUID();
      if (!KEY_ID.test(id)) throw storageError("STORAGE_DAMAGED");
      const keyring = systemKeyring(platform, run, env);
      const account = accountFor(directory, id);
      const key = previous ? await readKey(keyring, account) : await createKey(keyring, account);
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(`${SERVICE}:${account}`));
        const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return { method: "aes-256-gcm", keyId: id, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
      } finally {
        key.fill(0);
      }
    },
    async open(directory, protectedData) {
      if (protectedData?.method === "dpapi" && platform === "win32") {
        return dpapi(directory, decode(protectedData.data), true);
      }
      if (protectedData?.method !== "aes-256-gcm" || !KEY_ID.test(protectedData.keyId)) throw storageError("STORAGE_DAMAGED");
      const keyring = systemKeyring(platform, run, env);
      const account = accountFor(directory, protectedData.keyId);
      const key = await readKey(keyring, account);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, decode(protectedData.iv, 12));
        decipher.setAAD(Buffer.from(`${SERVICE}:${account}`));
        decipher.setAuthTag(decode(protectedData.tag, 16));
        return Buffer.concat([decipher.update(decode(protectedData.data)), decipher.final()]);
      } catch {
        throw storageError("STORAGE_DAMAGED");
      } finally {
        key.fill(0);
      }
    },
  };
}

module.exports = { createCredentialProtector, storageError };
