import { ApiError, apiJson } from "../../lib/api";

export interface FileMatch {
  readonly path: string;
  readonly name: string;
  readonly isDir?: boolean;
  readonly isParent?: boolean;
}

export interface FileTrigger {
  readonly start: number;
  readonly query: string;
}

export type MentionListError = { readonly kind: "outsideRoot" | "notFound" };

export interface MentionDirResult {
  readonly entries: readonly FileMatch[];
  readonly capped: boolean;
}

/** A query is treated as directory-browse (not fuzzy search) when it reads like
 *  a path: `.`, `..`, a trailing slash, or a `./` / `../` / `/` prefix. Anything
 *  else is a plain name filter and uses the recursive fuzzy search. A leading
 *  `/` is workspace-root-relative (resolved by the backend), not FS-absolute. */
export function isPathBrowseQuery(q: string): boolean {
  return (
    q === "." ||
    q === ".." ||
    q.endsWith("/") ||
    q.startsWith("./") ||
    q.startsWith("../") ||
    q.startsWith("/")
  );
}

export async function searchFiles(cwd: string, query: string, signal?: AbortSignal): Promise<readonly FileMatch[]> {
  const q = query.trim();
  const url = `/api/fs/search?path=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`;
  try {
    const data = await apiJson<{ readonly results?: readonly FileMatch[] }>(url, signal ? { signal } : {});
    return Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return [];
    throw error;
  }
}

/** Lists a directory (resolved relative to cwd) for @-mention browsing. Throws
 *  a {kind} error on 400 (outside workspace root) / 404 (not found) so the hook
 *  can surface a distinct status. */
export async function listDir(cwd: string, query: string, signal?: AbortSignal): Promise<MentionDirResult> {
  const url = `/api/fs/list?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(query)}`;
  let data: { readonly entries?: readonly FileMatch[]; readonly capped?: boolean };
  try {
    data = await apiJson(url, signal ? { signal } : {});
  } catch (error) {
    if (error instanceof ApiError && (error.status === 400 || error.status === 404)) {
      throw { kind: error.status === 400 ? "outsideRoot" : "notFound" } as MentionListError;
    }
    throw error;
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const mapped = entries.map((e): FileMatch => {
    const base: FileMatch = { path: e.path, name: e.name };
    if (e.isParent) return { ...base, isDir: true, isParent: true };
    if (e.isDir) return { ...base, isDir: true };
    return base;
  });
  return { entries: mapped, capped: !!data.capped };
}

export function detectFileTrigger(input: string, caret: number): FileTrigger | null {
  if (caret <= 0) return null;
  const prev = input[caret - 1];
  if (prev === " " || prev === "\n" || prev === "\t") return null;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = input[i];
    if (ch === "@") {
      const before = i === 0 ? " " : input[i - 1];
      if (before === " " || before === "\n" || before === "\t") {
        return { start: i, query: input.slice(i + 1, caret) };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
  }
  return null;
}
