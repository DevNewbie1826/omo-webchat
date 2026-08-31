import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/terminal-header.css";
import "./styles/app-empty.css";
import "./styles/file-browser.css";
import "./styles/file-editor.css";
import "./styles/split-view.css";
import "./styles/system-stats.css";
import "./styles/sidebar.css";
import "./styles/settings-menu.css";
import "./styles/sidebar-footer.css";
import "./styles/icon-button.css";
import "./styles/workspace-add-button.css";
import "./styles/sidebar-toggle.css";
import "./styles/session-tree.css";
import "./styles/mobile-drawer.css";
import "./styles/modal-dialog.css";
import "./styles/wizard.css";
import "./styles/form-controls.css";
import "./styles/workspace-wizard-steps.css";
import "./styles/login.css";
import "./styles/confirm-dialog.css";
import "./styles/new-chat-dialog.css";
import "./styles/chat-pane.css";
import "./styles/chat-transcript.css";
import "./styles/chat-composer.css";
import "./styles/tool-card.css";
import "./styles/approval-modal.css";
import "./styles/activity-shelf.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
