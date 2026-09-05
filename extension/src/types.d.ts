interface LandmarkDescriptor {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
}

interface ContainerHint {
  tag: string;
  role?: string;
  text: string;
}

interface ElementDescriptor {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  text?: string;
  css: string;
  xpath: string;
  nearbyText?: string;
  testId?: string;
  landmark?: LandmarkDescriptor;
  // True if ANY of the signals below indicate a collision — used to decide
  // whether it's worth computing containerHint at all.
  ambiguous?: boolean;
  // Per-attribute collision flags. Real markup can duplicate "unique" hooks
  // independently of each other (e.g. two buttons sharing one data-testid but
  // having different visible text) — tracking them separately lets codegen
  // fall through to whichever attribute is actually unique for this element,
  // instead of assuming the highest-priority one (data-testid) is always safe.
  testIdAmbiguous?: boolean;
  roleTextAmbiguous?: boolean;
  containerHint?: ContainerHint;
  // Computed server-side (backend/src/services/locatorBuilder.ts), not by this recorder.
  suggestedLocator?: string;
}

interface RecordedAction {
  action: 'click' | 'input' | 'select' | 'navigate' | 'mark_step';
  timestamp: number;
  url: string;
  element?: ElementDescriptor;
  value?: string;
  masked?: boolean;
  label?: string;
}

type ExtensionMessage =
  | { type: 'RECORD_ACTION'; action: RecordedAction }
  | { type: 'START_RECORDING'; testName: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'MARK_STEP'; label?: string }
  | { type: 'GET_STATE' }
  | { type: 'CLEAR_RECORDING' };

interface RecorderState {
  isRecording: boolean;
  testName: string;
  actions: RecordedAction[];
}
