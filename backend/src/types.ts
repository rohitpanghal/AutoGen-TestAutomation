export interface LandmarkDescriptor {
  tag: string;
  role?: string;
  testId?: string;
  id?: string;
  ariaLabel?: string;
}

export interface ContainerHint {
  tag: string;
  role?: string;
  text: string;
}

export interface ElementDescriptor {
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
  ambiguous?: boolean;
  testIdAmbiguous?: boolean;
  roleTextAmbiguous?: boolean;
  containerHint?: ContainerHint;
  suggestedLocator?: string;
}

export interface RecordedAction {
  action: 'click' | 'input' | 'select' | 'navigate' | 'mark_step';
  timestamp: number;
  url: string;
  element?: ElementDescriptor;
  value?: string;
  masked?: boolean;
  label?: string;
}

export interface TestStep {
  description: string;
  expectedResult?: string;
}

export interface GeneratedTestCase {
  title: string;
  preconditions: string[];
  steps: TestStep[];
  expectedResults: string[];
}

export interface GenerateResult {
  id: string;
  testCase: GeneratedTestCase;
  playwrightCode: string;
}
