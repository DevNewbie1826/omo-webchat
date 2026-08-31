import { apiJson, apiVoid } from "../../lib/api";

export interface LayoutResponse {
  readonly layout: unknown;
}

export async function getLayout(): Promise<unknown> {
  const res = await apiJson<LayoutResponse>("/api/layout");
  return res.layout;
}

export async function putLayout(layout: unknown): Promise<void> {
  await apiVoid("/api/layout", { method: "PUT", body: layout });
}
