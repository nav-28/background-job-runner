import {
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

// The generic arguments pin the four-parameter overload (the one that takes cost
// options); promisify's inference would otherwise pick the three-parameter one.
const scrypt = promisify<string, Buffer, number, ScryptOptions, Buffer>(scryptCallback);

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** OWASP's scrypt baseline. Needs ~16 MiB per hash (128 * N * r). */
const COST = 16_384; // N
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p

/**
 * Upper bounds enforced when reading a stored hash. Values come from our own
 * database rather than a client, but a corrupted or tampered row must not be able
 * to turn one login into a multi-gigabyte allocation.
 */
const MAX_COST = 1 << 20;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELISM = 8;

const FIELD_COUNT = 6;

interface StoredHash {
  cost: number;
  blockSize: number;
  parallelism: number;
  salt: Buffer;
  key: Buffer;
}

/** scrypt's `maxmem` guard defaults to 32 MiB, which is below our own cost. */
function memoryLimit(cost: number, blockSize: number, parallelism: number): number {
  return 256 * cost * blockSize + 128 * blockSize * parallelism + 1024 * 1024;
}

async function derive(
  password: string,
  salt: Buffer,
  { cost, blockSize, parallelism }: { cost: number; blockSize: number; parallelism: number },
): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: memoryLimit(cost, blockSize, parallelism),
  });
}

/** Hashes a password with a fresh random salt. Two calls never return the same string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, {
    cost: COST,
    blockSize: BLOCK_SIZE,
    parallelism: PARALLELISM,
  });

  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

function parseInteger(value: string, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return null;
  }
  return parsed;
}

/** Returns null for anything that is not a well-formed hash we can verify against. */
function parseStoredHash(stored: string): StoredHash | null {
  const parts = stored.split('$');
  if (parts.length !== FIELD_COUNT || parts[0] !== ALGORITHM) {
    return null;
  }

  const [, rawCost, rawBlockSize, rawParallelism, rawSalt, rawKey] = parts;

  const cost = parseInteger(rawCost, MAX_COST);
  const blockSize = parseInteger(rawBlockSize, MAX_BLOCK_SIZE);
  const parallelism = parseInteger(rawParallelism, MAX_PARALLELISM);
  const salt = Buffer.from(rawSalt, 'base64');
  const key = Buffer.from(rawKey, 'base64');

  if (cost === null || blockSize === null || parallelism === null) {
    return null;
  }
  if (salt.length === 0 || key.length === 0) {
    return null;
  }

  return { cost, blockSize, parallelism, salt, key };
}

/**
 * Constant-time comparison of a candidate password against a stored hash.
 * A malformed, empty or null stored hash returns false — it never throws, so a
 * corrupt row can only fail a login, not 500 the endpoint.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) {
    return false;
  }

  const parsed = parseStoredHash(stored);
  if (!parsed) {
    return false;
  }

  const candidate = await derive(password, parsed.salt, parsed);
  // timingSafeEqual throws on a length mismatch, so check length first.
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}
