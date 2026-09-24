// Append-only log of heal outcomes: what failed (a FailureSignature), what the
// world looked like, what changed in the spec, and whether it worked. One JSON
// object per line so writes never rewrite history and a corrupt line costs one
// record, not the file. Lives under backend/data/ (gitignored) alongside the
// other V1 file storage; swap for SQLite once similarity queries need indexes.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FailureSignature } from './failureClassifier.js';

const DATA_DIR = path.resolve('data');
const RECOVERIES_FILE = path.join(DATA_DIR, 'recoveries.jsonl');

export interface RecoveryRecord {
  id: string;
  createdAt: string;
  testId?: string;
  testTitle: string;
  // Signature of the FIRST failure this heal session saw.
  signature: FailureSignature;
  outcome: 'passed' | 'failed' | 'real-bug';
  // Playwright runs the session executed in total, including the first one.
  attempts: number;
  // Spec lines removed / added between the failing code and the final code —
  // the raw material a later phase will mine strategies from. Empty when the
  // heal made no change.
  removedLines: string[];
  addedLines: string[];
  // Filled in by later phases; null until a strategy catalog exists.
  strategy: string | null;
  // Whether a live-browser replay informed this heal.
  usedLiveBrowser: boolean;
}

export function appendRecovery(record: RecoveryRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(RECOVERIES_FILE, JSON.stringify(record) + '\n');
}

export function loadRecoveries(): RecoveryRecord[] {
  if (!existsSync(RECOVERIES_FILE)) return [];
  const out: RecoveryRecord[] = [];
  for (const line of readFileSync(RECOVERIES_FILE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RecoveryRecord);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}

// The read side of the store — the "Escalate" step's historical lookup: past
// heals that actually passed, ranked by how closely their starting failure
// matches this one. `kind` must match (a locator fix is no help for a
// navigation failure); locatorKind / urlPattern agreement just breaks ties.
// Simple field-overlap scoring, no embeddings — the store is small and this
// only needs to surface "roughly the same situation", not a precise match.
export function findSimilarRecoveries(signature: FailureSignature, limit = 3): RecoveryRecord[] {
  const scored = loadRecoveries()
    .filter((r) => r.outcome === 'passed' && r.addedLines.length > 0 && r.signature.kind === signature.kind)
    .map((r) => {
      let score = 1; // base score for the required kind match
      if (signature.locatorKind && r.signature.locatorKind === signature.locatorKind) score += 1;
      if (signature.urlPattern && r.signature.urlPattern === signature.urlPattern) score += 1;
      return { record: r, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.record);
}

// Multiset line diff — order-insensitive, which is enough to see which locator
// / assertion lines a heal swapped without pulling in a diff dependency.
export function diffLines(before: string, after: string): { removedLines: string[]; addedLines: string[] } {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const l of s.split('\n').map((x) => x.trim()).filter(Boolean)) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) ?? 0); i++) removedLines.push(l);
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) ?? 0); i++) addedLines.push(l);
  return { removedLines, addedLines };
}
