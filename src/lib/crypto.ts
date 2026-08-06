import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for sensitive health data (DPDP §9, tech spec §9.2).
 * The key is a 32-byte value provided as a 64-char hex string in
 * HEALTH_ENCRYPTION_KEY. A fresh random IV is generated per record.
 */

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const hex = process.env.HEALTH_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(
      "HEALTH_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32",
    );
  }
  if (/^0+$/.test(hex)) {
    // The .env.example placeholder used to be 64 hex zeros, which passed the
    // length check — refuse it so health data is never encrypted under a null key.
    throw new Error(
      "HEALTH_ENCRYPTION_KEY is all zeros — refusing to encrypt health data with a null key. Generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function encryptJson(data: unknown): EncryptedBlob {
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

export function decryptJson<T = unknown>(blob: EncryptedBlob): T {
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), blob.iv);
  decipher.setAuthTag(blob.authTag);
  const plaintext = Buffer.concat([
    decipher.update(blob.ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
