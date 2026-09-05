// Logging helpers with two jobs:
//  1. debugBlock(): the verbose "dump the whole prompt / payload" tracing that
//     used to run unconditionally as logBlock() in several files. It now only
//     prints when DEBUG=1, and always runs the data through redact() first.
//  2. redact(): strip the things that must never hit stdout — recorded input
//     values (which include passwords/tokens the recorder no longer masks),
//     email addresses, and long opaque tokens. Set DEBUG_UNSAFE_LOGS=1 to see
//     values verbatim while debugging locally.
//
// The short one-line progress logs ([generate] (id) ..., [heal] ...) are left
// alone — they carry no payloads.

const DEBUG = process.env.DEBUG === '1';
const UNSAFE = process.env.DEBUG_UNSAFE_LOGS === '1';

// An email, or a 20+ char run that mixes letters and digits (API keys, JWTs,
// session ids, base64 blobs). Deliberately conservative so it doesn't shred
// ordinary prose or generated code in the debug dumps.
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const TOKEN_RE = /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/g;

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, '***').replace(TOKEN_RE, '***');
}

export function redact<T>(data: T): T {
  if (UNSAFE) return data;
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v == null) return v;
    if (typeof v === 'string') return scrubString(v);
    if (typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // `value` = a recorded input/select value; `data` = base64 image payloads
      // in Anthropic message content. Neither belongs in a log.
      if ((k === 'value' || k === 'data') && typeof val === 'string') out[k] = '***';
      else out[k] = walk(val);
    }
    return out;
  };
  return walk(data) as T;
}

export function debugBlock(label: string, data: unknown): void {
  if (!DEBUG) return;
  const safe = redact(data);
  console.log(`----- ${label} -----`);
  console.log(typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2));
  console.log(`----- end ${label} -----`);
}

export const debugEnabled = DEBUG;
