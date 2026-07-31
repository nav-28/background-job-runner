import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type GuardVerdict = { ok: true; url: URL } | { ok: false; reason: string; retryable: boolean };

type AddressKind =
  | 'public'
  | 'loopback'
  | 'private'
  | 'unique-local'
  | 'link-local'
  | 'unspecified';

const RELAXABLE: ReadonlySet<AddressKind> = new Set<AddressKind>([
  'loopback',
  'private',
  'unique-local',
]);

const PRIVATE_NAME_SUFFIXES = ['.localhost', '.internal'];

export async function guardUrl(raw: string): Promise<GuardVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return blocked(`"${raw}" is not a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return blocked(`Scheme "${url.protocol}" is not fetchable; only http and https are allowed`);
  }

  // URL keeps IPv6 literals bracketed; every check below wants the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === '') {
    return blocked(`"${raw}" has no host`);
  }

  // Names are rejected before resolution so that a hosts-file or resolver entry pointing
  // `localhost` at a public address cannot be used to smuggle the name past the address checks.
  if (isPrivateName(hostname)) {
    return blocked(`Host "${hostname}" is a private name and cannot be fetched`);
  }

  if (isIP(hostname) > 0) {
    return verdictFor(url, [hostname]);
  }

  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true });
    addresses = records.map((record) => record.address);
  } catch {
    return { ok: false, reason: `DNS lookup for "${hostname}" failed`, retryable: true };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `DNS returned no addresses for "${hostname}"`, retryable: true };
  }

  return verdictFor(url, addresses);
}

function blocked(reason: string): GuardVerdict {
  return { ok: false, reason, retryable: false };
}

function isPrivateName(hostname: string): boolean {
  return (
    hostname === 'localhost' || PRIVATE_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

/** A host is only reachable if *every* address it resolves to is. One private answer rejects. */
function verdictFor(url: URL, addresses: string[]): GuardVerdict {
  for (const address of addresses) {
    const kind = classify(address);
    if (kind === 'public' || RELAXABLE.has(kind)) {
      continue;
    }
    return blocked(`Host "${url.hostname}" resolves to the ${kind} address ${address}`);
  }
  return { ok: true, url };
}

/** Anything unparseable classifies as loopback, so an address we cannot read is never fetched. */
function classify(address: string): AddressKind {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return bytes ? classifyIpv4(bytes) : 'loopback';
  }
  const bytes = family === 6 ? ipv6Bytes(address) : null;
  return bytes ? classifyIpv6(bytes) : 'loopback';
}

function classifyIpv4(bytes: Uint8Array): AddressKind {
  const [a, b] = [bytes[0], bytes[1]];
  if (a === 0) {
    return 'unspecified';
  }
  if (a === 127) {
    return 'loopback';
  }
  if (a === 169 && b === 254) {
    return 'link-local';
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'private';
  }
  return 'public';
}

function classifyIpv6(bytes: Uint8Array): AddressKind {
  if (isZeroPrefix(bytes, 15)) {
    return bytes[15] === 1 ? 'loopback' : 'unspecified';
  }
  // `::ffff:127.0.0.1` and the deprecated `::127.0.0.1` both wrap an IPv4 address that must be
  // judged as IPv4 — otherwise every v4 private range is reachable through a v6 spelling.
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes[10] === 0 && bytes[11] === 0;
  if (isZeroPrefix(bytes, 10) && (mapped || compatible)) {
    return classifyIpv4(bytes.subarray(12));
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    return 'unique-local';
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return 'link-local';
  }
  return 'public';
}

function isZeroPrefix(bytes: Uint8Array, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return true;
}

function ipv4Bytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const value = Number(parts[i]);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    bytes[i] = value;
  }
  return bytes;
}

function ipv6Bytes(address: string): Uint8Array | null {
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = hexGroups(halves[0]);
  const tail = halves.length === 2 ? hexGroups(halves[1]) : [];
  if (!head || !tail) {
    return null;
  }
  const gap = 8 - head.length - tail.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) {
    return null;
  }
  const groups = [...head, ...Array.from<number>({ length: Math.max(gap, 0) }).fill(0), ...tail];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** The trailing group may be dotted-quad (`::ffff:127.0.0.1`), which expands to two groups. */
function hexGroups(part: string | undefined): number[] | null {
  if (!part) {
    return [];
  }
  const chunks = part.split(':');
  const groups: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.includes('.')) {
      const quad = index === chunks.length - 1 ? ipv4Bytes(chunk) : null;
      if (!quad) {
        return null;
      }
      groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(chunk)) {
      return null;
    }
    groups.push(Number.parseInt(chunk, 16));
  }
  return groups;
}
