import { apiJson, apiRaw, apiVoid, qs } from "../../lib/api";
import type { ChatProvider, Terminal } from "../workspace/workspace";

export async function createTerminal(
  wsId: string,
  name: string,
  provider: ChatProvider,
): Promise<Terminal> {
  return apiJson<Terminal>(`/api/workspaces/${encodeURIComponent(wsId)}/chats`, {
    method: "POST",
    body: { name, provider },
  });
}

export async function deleteTerminal(wsId: string, tmId: string): Promise<void> {
  await apiVoid(
    `/api/workspaces/${encodeURIComponent(wsId)}/chats/${encodeURIComponent(tmId)}`,
    { method: "DELETE" },
  );
}

export async function renameTerminal(wsId: string, tmId: string, name: string): Promise<Terminal> {
  return apiJson<Terminal>(
    `/api/workspaces/${encodeURIComponent(wsId)}/chats/${encodeURIComponent(tmId)}`,
    { method: "PATCH", body: { name } },
  );
}




export async function uploadFiles(wsId: string, tmId: string, files: readonly File[]): Promise<void> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  await apiRaw(
    `/api/workspaces/${encodeURIComponent(wsId)}/chats/${encodeURIComponent(tmId)}/upload`,
    { method: "POST", body: form },
  );
}

export interface FsEntry {
  readonly name: string;
  readonly isDir: boolean;
  readonly size: number;
  readonly modTime: string;
}

export interface FsList {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FsEntry[];
}

export async function fsList(path: string): Promise<FsList> {
  return apiJson<FsList>(`/api/fs/list${qs({ path })}`);
}

export interface FsBrowse {
  readonly path: string;
  readonly parent: string | null;
  readonly dirs: readonly string[];
}

export async function fsBrowse(path: string): Promise<FsBrowse> {
  return apiJson<FsBrowse>(`/api/fs/browse${qs({ path })}`);
}

export interface FsCreatedFolder {
  readonly path: string;
}

export async function fsCreateFolder(parent: string, name: string): Promise<FsCreatedFolder> {
  return apiJson<FsCreatedFolder>("/api/fs/mkdir", {
    method: "POST",
    body: { path: parent, name },
  });
}

export function downloadUrl(path: string): string {
  return `/api/fs/download${qs({ path })}`;
}

export interface FsFile {
  readonly content: string;
  readonly size: number;
}

export async function fsRead(path: string): Promise<FsFile> {
  return apiJson<FsFile>(`/api/fs/read${qs({ path })}`);
}

export async function fsWrite(path: string, content: string): Promise<void> {
  await apiVoid(`/api/fs/write${qs({ path })}`, {
    method: "POST",
    body: { content },
  });
}
