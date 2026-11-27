"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { createCredentialProtector, storageError } = require("./credential-protection");

const VAULT_FILE = "balance-configs.v1.json";
const SIZE_LIMIT = 160 * 1024;

async function readFile(path) {
  try {
    const info = await fs.lstat(path);
    if (!info.isFile() || info.size > SIZE_LIMIT) throw storageError("STORAGE_DAMAGED");
    const bytes = await fs.readFile(path, "utf8");
    if (Buffer.byteLength(bytes) > SIZE_LIMIT) throw storageError("STORAGE_DAMAGED");
    return bytes;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function createBalanceVault({ getDataPath, protector = createCredentialProtector() }) {
  return {
    async read() {
      const directory = await fs.realpath(await getDataPath());
      const path = join(directory, VAULT_FILE);
      const raw = await readFile(path);
      if (raw === null) return { directory, raw, configs: null };
      let envelope;
      try {
        envelope = JSON.parse(raw);
        if (envelope?.version !== 1 || !envelope.encrypted) throw storageError("STORAGE_DAMAGED");
      } catch {
        throw storageError("STORAGE_DAMAGED");
      }
      const bytes = await protector.open(directory, envelope.encrypted);
      try {
        return { directory, raw, protectedData: envelope.encrypted, configs: JSON.parse(bytes.toString("utf8")) };
      } catch {
        throw storageError("STORAGE_DAMAGED");
      } finally {
        bytes.fill(0);
      }
    },
    async write(previous, configs) {
      const path = join(previous.directory, VAULT_FILE);
      const temporary = join(previous.directory, `${VAULT_FILE}.${randomUUID()}.tmp`);
      const plain = Buffer.from(JSON.stringify(configs));
      let madeFile = false;
      try {
        if (await readFile(path) !== previous.raw) throw storageError("BUSY");
        const encrypted = await protector.seal(previous.directory, plain, previous.protectedData);
        const output = JSON.stringify({ version: 1, encrypted });
        if (Buffer.byteLength(output) > SIZE_LIMIT) throw storageError();
        const file = await fs.open(temporary, "wx", 0o600);
        madeFile = true;
        try {
          await file.writeFile(output, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        if (await readFile(path) !== previous.raw) throw storageError("BUSY");
        await fs.rename(temporary, path);
      } finally {
        plain.fill(0);
        if (madeFile) await fs.rm(temporary, { force: true });
      }
    },
  };
}

module.exports = { createBalanceVault, VAULT_FILE };
