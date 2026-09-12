import type { ModelOption } from "./ModelPicker";

/** Score for one query token against one (lower-cased) haystack. Lower ranks
 *  earlier; `null` means the token does not match. A contiguous substring
 *  scores 0 wherever it sits, so equally good matches keep their input order;
 *  a scattered subsequence scores 1 plus the number of skipped characters, so
 *  tighter spans rank ahead of wider ones. */
export function fuzzyScore(haystack: string, token: string): number | null {
  if (token.length === 0 || haystack.includes(token)) return 0;
  let first = -1;
  let cursor = 0;
  for (const char of token) {
    const at = haystack.indexOf(char, cursor);
    if (at < 0) return null;
    if (first < 0) first = at;
    cursor = at + 1;
  }
  return 1 + (cursor - first - token.length);
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
