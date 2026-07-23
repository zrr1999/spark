export interface SourceMirrorAssertion {
  file: string;
  line: number;
  sourceVariable: string;
  assertion: string;
}

export function findSourceMirrorAssertions(
  sourceText: string,
  fileName?: string,
): SourceMirrorAssertion[];
