import { translate } from "../../i18n";
import type { I18nValue } from "../../i18n";
import type { FsList } from "./terminal";

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
  let resolveRef = (_value: T): void => {
    throw new Error("deferred resolve used before executor");
  };
  const promise = new Promise<T>((resolve) => {
    resolveRef = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolveRef(value);
    },
  };
}

export function selectFiles(input: HTMLInputElement, files: readonly File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  Object.defineProperty(input, "value", {
    configurable: true,
    writable: true,
    value: `C:\\fakepath\\${files[0]?.name ?? ""}`,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function dropFiles(target: HTMLElement, files: readonly File[]): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  target.dispatchEvent(event);
}

export const i18n: I18nValue = {
  lang: "en",
  setLang: () => undefined,
  font: "system",
  setFont: () => undefined,
  fontSize: 13,
  setFontSize: () => undefined,
  t: (key, vars) => translate("en", key, vars),
};

export const listing: FsList = { path: "/work", parent: null, entries: [] };
