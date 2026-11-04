// ===============================================================
// Private file storage on the server's disk.
//
// Files are saved under UPLOAD_DIR with a random name and are only ever
// served through authenticated API routes. Nothing here is public.
//
// To move to S3 later, keep these four functions and change their bodies.
// ===============================================================
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

const baseDir = path.resolve(env.uploadDir);

// Stops a stored key from ever pointing outside the storage folder.
const resolveKey = (key) => {
  const full = path.resolve(baseDir, key);
  if (!full.startsWith(baseDir + path.sep)) throw new Error("Invalid storage key");
  return full;
};

// Saves the buffer, returns { key, sha256, size }.
async function save(buffer, ext, folder = "agreements") {
  const now = new Date();
  const key = path.posix.join(
    folder,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${crypto.randomUUID()}.${ext}`,
  );
  const full = resolveKey(key);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, buffer, { flag: "wx", mode: 0o600 });
  return {
    key,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

const createReadStream = (key) => fs.createReadStream(resolveKey(key));

const remove = async (key) => {
  try {
    await fsp.unlink(resolveKey(key));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not delete file:", err.message);
  }
};

const exists = async (key) => {
  try {
    await fsp.access(resolveKey(key));
    return true;
  } catch {
    return false;
  }
};

module.exports = { save, createReadStream, remove, exists };
