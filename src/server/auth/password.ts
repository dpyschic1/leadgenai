import "server-only";
import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults to argon2id (m=19456 KiB, t=2, p=1), the OWASP-recommended baseline.

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash: treat as a mismatch rather than a server error.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Used when the account doesn't exist,
 * so response timing doesn't reveal which emails are registered.
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hash("dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}
