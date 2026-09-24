// Maps a classified failure to one of the named repair strategies the fix
// session's system prompt branches on — the "Healing Strategy" step between
// diagnosis and retry. Pure, no I/O; mirrors failureClassifier.ts's style.
import type { FailureSignature } from './failureClassifier.js';

export type RepairStrategy = 'selector-repair' | 'wait-retry-repair' | 'navigation-repair' | 'general-repair';

export function selectStrategy(signature: FailureSignature): RepairStrategy {
  switch (signature.kind) {
    case 'locator-zero-match':
    case 'locator-ambiguous':
    case 'locator-invalid':
      return 'selector-repair';
    case 'action-failed':
    case 'timeout':
      return 'wait-retry-repair';
    case 'navigation':
      return 'navigation-repair';
    // assertion-mismatch and unknown: no structural repair type fits — most
    // often the app's actual behavior differs from what was recorded, not a
    // selector/timing/navigation problem. Keep the broad guidance for these.
    case 'assertion-mismatch':
    case 'unknown':
    default:
      return 'general-repair';
  }
}
