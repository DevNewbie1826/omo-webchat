import type { ModelOption } from "./ModelPicker";

/** Score for one query token against one (lower-cased) haystack. Lower ranks
 *  earlier; `null` means the token does not match. Characters are whole Unicode
 *  code points: the token is spread into code points and each one is matched
 *  atomically against a single haystack code point, so a supplementary
 *  character can never be split into lone surrogates or stitched together from
 *  the halves of two different characters. A contiguous substring scores 0
 *  wherever it sits, so equally good matches keep their input order; a
 *  scattered subsequence scores 1 plus the number of characters skipped inside
 *  the smallest window that contains the token in order, so tighter spans rank
 *  ahead of wider ones. */
export function fuzzyScore(haystack: string, token: string): number | null {
  const hay = [...haystack];
  const need = [...token];
  if (need.length === 0) return 0;
  let best = -1;
  for (let start = 0; start < hay.length; start++) {
    if (hay[start] !== need[0]) continue;
    // Greedily taking each next token character as early as possible yields
    // the smallest window with this start, so trying every start and keeping
    // the shortest completion finds the tightest window overall.
    let cursor = start + 1;
    let matched = 1;
    while (matched < need.length) {
      const at = hay.indexOf(need[matched]!, cursor);
      if (at < 0) break;
      cursor = at + 1;
      matched++;
    }
    if (matched === need.length) {
      const length = cursor - start;
      if (best < 0 || length < best) best = length;
    }
  }
  if (best < 0) return null;
  const skipped = best - need.length;
  return skipped === 0 ? 0 : 1 + skipped;
}

const haystackOf = (model: ModelOption): string => {
  const label = (model.name || model.modelId).toLowerCase();
  const id = model.modelId.toLowerCase();
  const parts = label === id ? [label, model.provider] : [label, id, model.provider];
  return parts.join(" ").toLowerCase();
};

/** Filters and ranks `models` for `query`. Every whitespace-separated token
 *  must fuzzy-match (characters in order, not necessarily adjacent) against the
 *  model's label, id or provider. An empty query keeps the input order. */
export function matchModels(models: readonly ModelOption[], query: string): ModelOption[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return [...models];
  const ranked: { model: ModelOption; score: number; index: number }[] = [];
  models.forEach((model, index) => {
    const haystack = haystackOf(model);
    let score = 0;
    for (const token of tokens) {
      const part = fuzzyScore(haystack, token);
      if (part === null) return;
      score += part;
    }
    ranked.push({ model, score, index });
  });
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  return ranked.map((entry) => entry.model);
}
