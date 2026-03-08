// src/utils/crypto.ts
// ─────────────────────────────────────────────────────────────
//  Cryptographic helpers
//    - bcrypt password hashing (rounds=12)
//    - SHA-256 token hashing for DB storage
//    - Secure random API key generation
//    - Constant-time string comparison
// ─────────────────────────────────────────────────────────────

import bcrypt from "bcryptjs";
import crypto from "crypto";

const BCRYPT_ROUNDS = 12;

// ── Password hashing ──────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ── Token / API key hashing ───────────────────────────────────
// Used to store refresh tokens and API keys in DB without exposing raw values.
// SHA-256 is fine here because tokens are already high-entropy random values.

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ── Secure random generation ──────────────────────────────────

/**
 * Generate a cryptographically secure random token.
 * Default 48 bytes = 64-char hex string. Good for refresh tokens.
 */
export function generateSecureToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Generate an API key in the format: rwa_<prefix>_<secret>
 * prefix = first 8 chars (shown in UI for identification)
 * secret = 40 random bytes = 80 hex chars
 */
export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const secret = crypto.randomBytes(40).toString("hex");
  const prefix = secret.slice(0, 8);
  const raw = `rwa_${prefix}_${secret.slice(8)}`;
  const hash = hashToken(raw);
  return { raw, prefix, hash };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
