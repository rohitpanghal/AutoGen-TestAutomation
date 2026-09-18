// V1 storage: plain JSON files on disk. Swap for Postgres once recordings/tests
// need querying, sharing across users, or concurrent writers.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { RecordedAction, GeneratedTestCase } from '../types.js';

const DATA_DIR = path.resolve('data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
const TESTS_DIR = path.resolve('generated-tests');

for (const dir of [RECORDINGS_DIR, TESTS_DIR]) {
  mkdirSync(dir, { recursive: true });
}

export function saveRecording(id: string, testName: string, actions: RecordedAction[], parentId?: string) {
  const file = path.join(RECORDINGS_DIR, `${id}.json`);
  writeFileSync(
    file,
    JSON.stringify({ id, testName, actions, parentId, createdAt: new Date().toISOString() }, null, 2)
  );
}

export interface GeneratedTestRecord {
  id: string;
  testCase: GeneratedTestCase;
  playwrightCode: string;
  specFile: string;
}

export function saveGeneratedTest(id: string, testCase: GeneratedTestCase, playwrightCode: string): string {
  const slug =
    testCase.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'test';
  // Suffix with the record id: two tests with the same title would otherwise
  // silently overwrite each other's spec file (and each other's heal edits).
  const specFile = path.join(TESTS_DIR, `${slug}--${id}.spec.ts`);
  writeFileSync(specFile, playwrightCode);

  const jsonFile = path.join(RECORDINGS_DIR, `${id}.result.json`);
  writeFileSync(jsonFile, JSON.stringify({ id, testCase, playwrightCode, specFile }, null, 2));
  return specFile;
}

export function loadGeneratedTest(id: string): GeneratedTestRecord | null {
  const file = path.join(RECORDINGS_DIR, `${id}.result.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}

// Overwrites the stored record (and, when the code changed, the on-disk spec
// file) with QA/self-heal edits. The spec file is the same file the user
// already has open/committed — edits land in place rather than a shadow copy,
// so `git diff` shows exactly what changed. `testCase` alone (e.g. QA tweaking
// a step's description) doesn't touch the spec file at all.
export function updateGeneratedTest(id: string, updates: { playwrightCode?: string; testCase?: GeneratedTestCase }) {
  const record = loadGeneratedTest(id);
  if (!record) throw new Error(`No generated test found for id ${id}`);
  const merged: GeneratedTestRecord = {
    ...record,
    testCase: updates.testCase ?? record.testCase,
    playwrightCode: updates.playwrightCode ?? record.playwrightCode,
  };
  if (updates.playwrightCode !== undefined) writeFileSync(record.specFile, updates.playwrightCode);
  const jsonFile = path.join(RECORDINGS_DIR, `${id}.result.json`);
  writeFileSync(jsonFile, JSON.stringify(merged, null, 2));
  return merged;
}

export function loadRecording(id: string) {
  const file = path.join(RECORDINGS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8'));
}
