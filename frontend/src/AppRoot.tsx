import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { detectLang, translate } from "./i18n";

/** Last-resort fallback outside the i18n provider: never an empty page. */
function AppFallback({ error }: { readonly error: Error }) {
  const lang = detectLang();
  return (
    <div className="th-app-error" role="alert">
      <p className="th-app-error-title">{translate(lang, "app.crashed")}</p>
      <p className="th-app-error-detail">{error.message}</p>
      <button type="button" className="th-btn th-btn--ghost th-app-error-reload" onClick={() => window.location.reload()}>
        {translate(lang, "app.reload")}
      </button>
    </div>
  );
}

export function AppRoot() {
  return (
    <ErrorBoundary fallback={(error) => <AppFallback error={error} />}>
      <App />
    </ErrorBoundary>
  );
}
