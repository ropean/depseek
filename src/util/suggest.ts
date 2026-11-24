/** Levenshtein distance between two short strings. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Closest candidate to `word` (one edit for short words, two for longer ones), if any. */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  const max = word.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestD = max + 1;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}
