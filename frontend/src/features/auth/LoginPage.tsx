import { useState } from "react";
import type { FormEvent } from "react";
import { useT } from "../../i18n";
import { login } from "./auth";
import { IconAlert, IconGlobe } from "../../components/icons";

export interface LoginPageProps {
  readonly onLogin: () => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const { t, lang, setLang } = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (ev: FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault();
    if (busy || password.length === 0) return;
    setBusy(true);
    setFailed(false);
    try {
      await login(password);
      onLogin();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="th-login">
      <div className="th-login-card">
        <div className="th-login-brand">
          <span className="th-login-brand-dot" />
          {t("sidebar.nav.brand")}
        </div>
        <h1 className="th-login-title">{t("login.title")}</h1>
        <p className="th-login-sub">{t("login.subtitle")}</p>

        {failed && (
          <div className="th-alert th-alert--error" role="alert">
            <IconAlert size={15} />
            <span>{t("login.error")}</span>
          </div>
        )}

        <form className="th-field" onSubmit={submit}>
          <label className="th-field-label" htmlFor="th-password">
            {t("login.password")}
          </label>
          <input
            id="th-password"
            className="th-input"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder={t("login.passwordPlaceholder")}
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
          />
          <button className="th-btn th-btn--primary" type="submit" disabled={busy || password.length === 0}>
            {busy ? t("login.submitting") : t("login.submit")}
          </button>
        </form>

        <div className="th-login-foot">
          <span>{t("login.footnote")}</span>
          <button
            type="button"
            className="th-login-lang"
            onClick={() => setLang(lang === "ko" ? "en" : "ko")}
          >
            <IconGlobe size={12} />
            {lang === "ko" ? "한국어" : "English"}
          </button>
        </div>
      </div>
    </div>
  );
}
