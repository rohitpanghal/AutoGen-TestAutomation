// Human-in-the-loop review cases — but ONLY for a RECURRING likelyRealBug
// verdict, never a single one. A first occurrence is just a hypothesis (could
// be a flaky page, bad timing, a transient state) and is left alone; a
// "case" groups every occurrence of what's recognizably the same real-world
// failure (same broken locator / same failure kind+page), so a 2nd, 3rd, 4th
// recurrence updates one case instead of spawning duplicates. Mutable —
// unlike recoveryStore.ts's append-only log, a case's status changes over
// time as a human reviews it — so this is a JSON array rewritten whole, not
// a jsonl append.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { FailureSignature } from './failureClassifier.js';

const DATA_DIR = path.resolve('data');
const REVIEW_FILE = path.join(DATA_DIR, 'review-cases.json');

export type ReviewStatus = 'pending' | 'confirmed-bug' | 'dismissed' | 'reheal-requested' | 'reheal-passed' | 'reheal-failed';

export interface ReviewCase {
  id: string;
  // Internal grouping key — never exposed in routes. Prefers the exact
  // broken locator (the tightest possible "this is the same thing again"
  // signal); falls back to kind+page when no locator was involved.
  caseKey: string;
  status: ReviewStatus;
  occurrences: number;
  firstRecoveryId: string;
  latestRecoveryId: string;
  testId?: string;
  testTitle: string;
  diagnosis: string;
  screenshotPath?: string;
  signature: FailureSignature;
  firstSeenAt: string;
  lastSeenAt: string;
  hint?: string;
  decidedAt?: string;
}

export function caseKeyFor(signature: FailureSignature): string {
  return signature.locatorExpr ? `loc:${signature.locatorExpr}` : `${signature.kind}:${signature.urlPattern ?? ''}`;
}

export function loadCases(): ReviewCase[] {
  if (!existsSync(REVIEW_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REVIEW_FILE, 'utf-8')) as ReviewCase[];
  } catch {
    return [];
  }
}

function saveCases(cases: ReviewCase[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REVIEW_FILE, JSON.stringify(cases, null, 2));
}

export function findCaseByKey(caseKey: string): ReviewCase | undefined {
  return loadCases().find((c) => c.caseKey === caseKey);
}

export function findCaseById(id: string): ReviewCase | undefined {
  return loadCases().find((c) => c.id === id);
}

export function upsertCase(next: ReviewCase): void {
  const cases = loadCases();
  const idx = cases.findIndex((c) => c.id === next.id);
  if (idx === -1) cases.push(next);
  else cases[idx] = next;
  saveCases(cases);
}

// Records one more occurrence of `signature` (a real-bug verdict) against the
// matching case, creating it on first sight. Returns the updated case plus
// whether this occurrence should actually surface for human review —
// `occurrences >= 2` and the case isn't already a human-decided terminal
// state (a confirmed or dismissed case doesn't need re-pinging; a case still
// pending, or whose guided re-heal failed, does).
export function recordOccurrence(input: {
  signature: FailureSignature;
  recoveryId: string;
  testId?: string;
  testTitle: string;
  diagnosis: string;
  screenshotPath?: string;
}): { reviewCase: ReviewCase; shouldNotify: boolean } {
  const caseKey = caseKeyFor(input.signature);
  const prior = findCaseByKey(caseKey);
  const now = new Date().toISOString();
  const reviewCase: ReviewCase = {
    id: prior?.id ?? nanoid(10),
    caseKey,
    status: prior?.status ?? 'pending',
    occurrences: (prior?.occurrences ?? 0) + 1,
    firstRecoveryId: prior?.firstRecoveryId ?? input.recoveryId,
    latestRecoveryId: input.recoveryId,
    testId: input.testId ?? prior?.testId,
    testTitle: input.testTitle,
    diagnosis: input.diagnosis,
    screenshotPath: input.screenshotPath ?? prior?.screenshotPath,
    signature: input.signature,
    firstSeenAt: prior?.firstSeenAt ?? now,
    lastSeenAt: now,
    hint: prior?.hint,
    decidedAt: prior?.decidedAt,
  };
  upsertCase(reviewCase);
  const terminal = reviewCase.status === 'confirmed-bug' || reviewCase.status === 'dismissed';
  return { reviewCase, shouldNotify: reviewCase.occurrences >= 2 && !terminal };
}
