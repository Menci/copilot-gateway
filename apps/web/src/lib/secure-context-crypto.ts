// `Crypto.randomUUID` and `Crypto.subtle` carry WebIDL's `[SecureContext]`
// extended attribute, so a browser exposes neither over plain HTTP unless the
// host is a loopback literal. The dashboard is reached that way in the
// deployment we document — the Node server publishes it on 18088 behind
// whatever LAN address the operator's host has — and the two are what mints the PKCE
// challenge for an OAuth upstream and the ids of playground messages.
// https://w3c.github.io/webcrypto/#crypto-interface
// https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts
//
// Neither needs anything a secure context supplies: a version 4 UUID is
// formatting over `Crypto.getRandomValues`, which is exposed everywhere, and a
// digest is pure computation. So we supply both at boot and let every call site
// read the platform's names, rather than route each one around an API that is
// missing only by origin.
import type { CHash } from '@noble/hashes/utils.js';

// https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-4
const UUID_VERSION_BYTE = 6;
const UUID_VARIANT_BYTE = 8;

export const portableRandomUUID = (): ReturnType<Crypto['randomUUID']> => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[UUID_VERSION_BYTE] = (bytes[UUID_VERSION_BYTE]! & 0x0f) | 0x40;
  bytes[UUID_VARIANT_BYTE] = (bytes[UUID_VARIANT_BYTE]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// The four digests Web Crypto defines, loaded on the call so that a dashboard
// that never opens an OAuth flow does not carry them.
// https://w3c.github.io/webcrypto/#algorithm-overview
const HASHES: Record<string, () => Promise<CHash>> = {
  'SHA-1': async () => (await import('@noble/hashes/legacy.js')).sha1,
  'SHA-256': async () => (await import('@noble/hashes/sha2.js')).sha256,
  'SHA-384': async () => (await import('@noble/hashes/sha2.js')).sha384,
  'SHA-512': async () => (await import('@noble/hashes/sha2.js')).sha512,
};

// Algorithm names are matched ASCII case-insensitively, and an unrecognized one
// is a `NotSupportedError` — both are what `digest` inherits from normalizing
// its algorithm argument.
// https://w3c.github.io/webcrypto/#dfn-normalize-an-algorithm
const digest = async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
  const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase();
  const load = HASHES[name];
  if (!load) throw new DOMException(`Unrecognized digest algorithm ${name}`, 'NotSupportedError');
  const hash = await load();
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const output = hash(bytes);
  const result = new ArrayBuffer(output.length);
  new Uint8Array(result).set(output);
  return result;
};

// Keys are the rest of `SubtleCrypto`, and a key needs an origin's key store,
// an algorithm registry, and a structured-clone-safe `CryptoKey` — a body of
// work no call site here asks for. Naming each one keeps the shape of the
// interface honest and makes an unimplemented operation say so.
const unsupported = (operation: string) => async (): Promise<never> => {
  throw new DOMException(
    `crypto.subtle.${operation} is not supplied by the dashboard, which implements digests only`,
    'NotSupportedError',
  );
};

export const portableSubtle: SubtleCrypto = {
  digest,
  decrypt: unsupported('decrypt'),
  deriveBits: unsupported('deriveBits'),
  deriveKey: unsupported('deriveKey'),
  encrypt: unsupported('encrypt'),
  exportKey: unsupported('exportKey'),
  generateKey: unsupported('generateKey'),
  importKey: unsupported('importKey'),
  sign: unsupported('sign'),
  unwrapKey: unsupported('unwrapKey'),
  verify: unsupported('verify'),
  wrapKey: unsupported('wrapKey'),
};

// Both are installed unconditionally, deliberately: never behind a capability
// check. One implementation on every origin is what makes the dashboard behave
// the same way wherever it is served, so what an operator reports from
// http://<lan-address> is what a developer reproduces on https, down to the
// error a call site raises. A check would leave two implementations in the
// field and exercise the fallback only where nobody is looking.
//
// Do not turn this back into `if (!crypto.subtle)`. The members are absent by
// origin, not by engine, so the presence of a native one says nothing about the
// origin the next reader is debugging.
export const installSecureContextCrypto = (): void => {
  Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: portableRandomUUID,
  });
  Object.defineProperty(crypto, 'subtle', {
    configurable: true,
    writable: true,
    value: portableSubtle,
  });
};
