import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en.json";
import ko from "../../i18n/locales/ko.json";

function table(locale: typeof en): Record<string, string> {
  return locale as Record<string, string>;
}

describe("failed-send recovery translations", () => {
  it.each([en, ko])("defines accessible recovery labels and an image fallback", (locale) => {
    const messages = table(locale);
    expect(messages["chat.failedSends"]?.trim()).toBeTruthy();
    expect(messages["common.retry"]?.trim()).toBeTruthy();
    expect(messages["chat.image"]?.trim()).toBeTruthy();
  });
});
