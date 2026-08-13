import type { ExpectedIndexState, RawComparisonSnapshot } from './types';

export function renderTextRatio(rawTextLength: number, renderedTextLength: number): number | null {
  if (renderedTextLength <= 0) return null;
  return rawTextLength / renderedTextLength;
}

export function isMainContentRenderDependent(
  comparison: RawComparisonSnapshot,
  expectedIndexState: ExpectedIndexState,
): boolean {
  const ratio = renderTextRatio(comparison.rawTextLength, comparison.renderedTextLength);
  return Boolean(
    comparison.available &&
    expectedIndexState !== 'noindex' &&
    comparison.renderedTextLength >= 300 &&
    ratio !== null &&
    ratio < 0.2
  );
}
