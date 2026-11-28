const ADMIN_HTML = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>manageable-mcp 管理面板</title>
<script>
(function () {
  try {
    var saved = localStorage.getItem('mmcp.admin.theme');
    var theme = saved === 'light' || saved === 'dark'
      ? saved
      : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (error) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
</script>
<style>
:root {
  color-scheme: dark;
  --bg: #080b10;
  --bg-soft: #0d121a;
  --panel: rgba(17, 24, 35, 0.86);
  --panel-solid: #111823;
  --panel-raised: #151e2b;
  --border: rgba(148, 163, 184, 0.15);
  --border-strong: rgba(148, 163, 184, 0.3);
  --text: #e8eef8;
  --muted: #93a2b8;
  --faint: #64748b;
  --accent: #5eead4;
  --accent-soft: rgba(94, 234, 212, 0.12);
  --accent-strong: #2dd4bf;
  --blue: #38bdf8;
  --ok: #34d399;
  --ok-soft: rgba(52, 211, 153, 0.12);
  --warn: #fbbf24;
  --warn-soft: rgba(251, 191, 36, 0.12);
  --danger: #fb7185;
  --danger-soft: rgba(251, 113, 133, 0.12);
  --shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
  --glow-a: rgba(56, 189, 248, 0.16);
  --glow-b: rgba(94, 234, 212, 0.1);
  --radius: 18px;
}

[data-theme="light"] {
  color-scheme: light;
  --bg: #f3f6fb;
  --bg-soft: #e9eef7;
  --panel: rgba(255, 255, 255, 0.88);
  --panel-solid: #ffffff;
  --panel-raised: #ffffff;
  --border: rgba(15, 23, 42, 0.1);
  --border-strong: rgba(15, 23, 42, 0.2);
  --text: #0f172a;
  --muted: #52637a;
  --faint: #718096;
  --accent: #0f766e;
  --accent-soft: rgba(13, 148, 136, 0.1);
  --accent-strong: #0d9488;
  --blue: #0284c7;
  --ok: #059669;
  --ok-soft: rgba(5, 150, 105, 0.1);
  --warn: #b45309;
  --warn-soft: rgba(180, 83, 9, 0.1);
  --danger: #be123c;
  --danger-soft: rgba(190, 18, 60, 0.08);
  --shadow: 0 24px 70px rgba(15, 23, 42, 0.12);
  --glow-a: rgba(14, 165, 233, 0.1);
  --glow-b: rgba(13, 148, 136, 0.08);
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-height: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(1100px 560px at 5% -10%, var(--glow-a), transparent 62%),
    radial-gradient(900px 520px at 100% 0%, var(--glow-b), transparent 58%),
    var(--bg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

button, input, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: wait; opacity: 0.7; }
code, .editor, .mono {
  font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
code {
  color: var(--text);
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 1px 6px;
  font-size: 0.86em;
  overflow-wrap: anywhere;
}
h1, h2, h3, p { margin-top: 0; }
h1, h2, h3 { letter-spacing: -0.02em; line-height: 1.15; }
h1 { margin-bottom: 14px; font-size: clamp(2rem, 4vw, 3.5rem); font-weight: 720; }
h2 { margin-bottom: 4px; font-size: 1.2rem; }
h3 { margin: 0; font-size: 1.02rem; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px clamp(18px, 4vw, 46px);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter: blur(18px);
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 13px;
  color: #041b1a;
  background: linear-gradient(135deg, var(--accent), var(--blue));
  box-shadow: 0 8px 26px rgba(45, 212, 191, 0.28);
  font-weight: 900;
  font-size: 1.1rem;
}
.brand-copy { display: grid; gap: 1px; }
.brand-copy strong { font-size: 1rem; letter-spacing: -0.01em; }
.top-actions { display: flex; align-items: center; gap: 8px; }
.eyebrow {
  margin: 0;
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

main {
  width: min(1180px, calc(100% - 36px));
  margin: 0 auto;
  padding: clamp(28px, 5vw, 62px) 0 90px;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.75fr);
  gap: clamp(24px, 4vw, 54px);
  align-items: end;
  margin-bottom: clamp(26px, 4vw, 46px);
}
.hero-copy .lede {
  max-width: 680px;
  margin: 0;
  color: var(--muted);
  font-size: 1.02rem;
}
.path-card {
  display: grid;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow);
}
.path-row { display: grid; gap: 4px; }
.path-row > span {
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.path-row code { display: block; padding: 7px 9px; }
.path-note {
  padding-top: 4px;
  color: var(--faint);
  font-size: 0.78rem;
  border-top: 1px solid var(--border);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}
.stats { display: flex; flex-wrap: wrap; gap: 8px; }
.stat {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
}
.stat-value { font-weight: 800; font-variant-numeric: tabular-nums; }
.stat-label { color: var(--muted); font-size: 0.78rem; }
.stat.ok .stat-value { color: var(--ok); }
.stat.bad .stat-value { color: var(--danger); }
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
}
.segmented button {
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--muted);
  background: transparent;
  font-size: 0.78rem;
  font-weight: 650;
}
.segmented button:hover:not(:disabled) { color: var(--text); }
.segmented button.is-active {
  color: var(--text);
  background: var(--panel-raised);
  border-color: var(--border-strong);
}
.toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.search input, .text-input {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 11px;
  outline: none;
}
.search input { min-width: 190px; }
.search input:focus, .text-input:focus, .editor:focus {
  border-color: var(--accent-strong);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.button, .icon-button {
  border: 1px solid var(--border);
  color: var(--text);
  background: var(--panel);
  transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 40px;
  padding: 8px 14px;
  border-radius: 11px;
  font-weight: 650;
  font-size: 0.88rem;
  white-space: nowrap;
}
.button:hover:not(:disabled), .icon-button:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--panel-raised);
  transform: translateY(-1px);
}
.button.primary {
  color: #042f2e;
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  border-color: transparent;
  box-shadow: 0 8px 24px rgba(45, 212, 191, 0.18);
}
[data-theme="light"] .button.primary { color: #ffffff; }
.button.ghost { background: transparent; }
.button.danger { color: var(--danger); }
.button.danger:hover:not(:disabled) { background: var(--danger-soft); border-color: var(--danger); }
.button.small { min-height: 32px; padding: 5px 10px; font-size: 0.78rem; }
.button.has-token { color: var(--accent); border-color: var(--accent-strong); }
.icon-button {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  font-size: 1rem;
}
.button:focus-visible, .icon-button:focus-visible, .switch input:focus-visible + .switch-track {
  outline: 2px solid var(--accent-strong);
  outline-offset: 2px;
}

.notice {
  margin-bottom: 20px;
  padding: 12px 14px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid color-mix(in srgb, var(--danger) 38%, transparent);
  border-radius: 12px;
  font-size: 0.9rem;
}
.groups-panel {
  margin-bottom: 26px;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.client-panel { margin-bottom: 26px; padding: 18px 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.client-panel summary { cursor: pointer; font-size: 1.2rem; font-weight: 700; }
.client-panel p { margin: 8px 0 14px; color: var(--muted); font-size: 0.85rem; }
.client-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 0; border-top: 1px solid var(--border); }
.client-info { display: grid; gap: 2px; }
.client-info span { color: var(--muted); font-size: 0.82rem; }
.client-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.section-heading h2 { margin: 0; }
.section-heading p { margin: 0; color: var(--muted); font-size: 0.82rem; }
.group-list { display: flex; flex-wrap: wrap; gap: 8px; }
.group-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-raised);
  font-size: 0.8rem;
}
.group-chip strong { font-weight: 700; }
.group-count { color: var(--muted); }

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
.server-card {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset;
  transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
}
.server-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}
.server-card.disabled { opacity: 0.72; }
.server-card[data-status="error"] { border-color: color-mix(in srgb, var(--danger) 34%, var(--border)); }
.server-card[data-status="auth"] { border-color: color-mix(in srgb, var(--warn) 34%, var(--border)); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.card-title { display: flex; align-items: center; gap: 9px; min-width: 0; }
.card-title h3 { overflow-wrap: anywhere; }
.health-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--faint);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--faint) 12%, transparent);
}
.health-dot.ok { background: var(--ok); box-shadow: 0 0 0 4px var(--ok-soft); }
.health-dot.bad { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-soft); }
.health-dot.muted { background: var(--faint); box-shadow: none; }
.card-controls { display: flex; align-items: center; gap: 8px; }
.badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 10%, transparent);
  font-size: 0.66rem;
  font-weight: 750;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.badge.transport { color: var(--blue); background: color-mix(in srgb, var(--blue) 11%, transparent); }
.badge.disabled { color: var(--faint); }
.badge.type-local { color: var(--muted); }
.badge.type-remote { color: var(--blue); background: color-mix(in srgb, var(--blue) 11%, transparent); }
.badge.auth-oauth { color: var(--ok); background: var(--ok-soft); }
.badge.auth-api-key { color: var(--warn); background: var(--warn-soft); }
.badge.auth-local { color: var(--muted); }
.badge.auth-unknown { color: var(--faint); }
.status-ready { color: var(--ok); background: var(--ok-soft); }
.status-connecting { color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, transparent); }
.status-auth { color: var(--warn); background: var(--warn-soft); }
.status-error { color: var(--danger); background: var(--danger-soft); }
.status-idle { color: var(--muted); }
.card-description {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
.card-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--faint); font-size: 0.75rem; }
.meta-item { display: inline-flex; align-items: center; gap: 4px; }
.meta-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  color: var(--accent);
  background: transparent;
  font-size: 0.75rem;
  font-weight: 650;
}
.meta-action:hover:not(:disabled) { text-decoration: underline; }
.meta-action:disabled { color: var(--faint); cursor: wait; }
.card-target {
  overflow: hidden;
  color: var(--faint);
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-target code { background: transparent; border: 0; padding: 0; }
.card-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tag {
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-size: 0.68rem;
}
.card-error {
  margin: 0;
  padding: 9px 10px;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 10px;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}
.card-error-collapsible {
  padding: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
}
.card-error-collapsible summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 9px 10px;
  cursor: pointer;
  list-style: none;
}
.card-error-collapsible summary::-webkit-details-marker { display: none; }
.card-error-collapsible summary:focus-visible {
  outline: 2px solid var(--danger);
  outline-offset: -2px;
}
.error-summary-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.error-summary-action { font-size: 0.72rem; font-weight: 700; white-space: nowrap; }
.error-summary-close { display: none; }
.card-error-collapsible[open] .error-summary-open { display: none; }
.card-error-collapsible[open] .error-summary-close { display: inline; }
.error-detail {
  max-height: min(42vh, 420px);
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border-top: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
  color: var(--danger);
  font-size: 0.74rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.card-actions { display: flex; gap: 7px; margin-top: auto; padding-top: 2px; }
.tool-list { display: grid; gap: 10px; max-height: 52vh; overflow: auto; padding-right: 4px; }
.tool-row {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-soft);
}
.tool-row code { display: inline-block; margin-bottom: 4px; }
.tool-row p { margin: 0; color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.tool-empty { padding: 22px; color: var(--muted); text-align: center; }

.switch { position: relative; display: inline-flex; flex: 0 0 auto; }
.switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.switch-track {
  position: relative;
  display: block;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 26%, transparent);
  border: 1px solid var(--border);
  transition: background 140ms ease, border-color 140ms ease;
}
.switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text);
  transition: transform 140ms ease, background 140ms ease;
}
.switch input:checked + .switch-track { background: var(--accent-strong); border-color: transparent; }
.switch input:checked + .switch-track .switch-thumb { transform: translateX(16px); background: #ffffff; }

.empty-state {
  grid-column: 1 / -1;
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 56px 22px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--panel) 55%, transparent);
}
.empty-state p { max-width: 460px; margin: 0; color: var(--muted); }
.empty-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  color: var(--accent);
  background: var(--accent-soft);
  font-family: ui-monospace, monospace;
  font-size: 1.15rem;
  font-weight: 800;
}

.skeleton { pointer-events: none; }
.skeleton-line {
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--panel-raised), var(--border), var(--panel-raised));
  background-size: 220% 100%;
  animation: shimmer 1.25s linear infinite;
}
.skeleton-line.wide { width: 62%; height: 16px; }
.skeleton-line.short { width: 38%; }
@keyframes shimmer { to { background-position: -220% 0; } }

.modal {
  width: min(760px, calc(100% - 28px));
  max-height: calc(100vh - 40px);
  padding: 0;
  color: var(--text);
  background: var(--panel-solid);
  border: 1px solid var(--border-strong);
  border-radius: 22px;
  box-shadow: var(--shadow);
}
.modal.compact { width: min(500px, calc(100% - 28px)); }
.modal::backdrop {
  background: rgba(2, 6, 12, 0.68);
  backdrop-filter: blur(6px);
}
.modal > * { margin-left: 22px; margin-right: 22px; }
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-top: 20px;
  margin-bottom: 8px;
}
.modal-head h2 { margin: 0; font-size: 1.35rem; }
.modal-hint { margin-top: 8px; margin-bottom: 14px; color: var(--muted); font-size: 0.86rem; }
.editor {
  display: block;
  width: calc(100% - 44px);
  min-height: 340px;
  max-height: 52vh;
  padding: 14px;
  color: var(--text);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 13px;
  outline: none;
  resize: vertical;
  font-size: 0.8rem;
  line-height: 1.55;
  tab-size: 2;
}
.form-error {
  margin-top: 10px;
  margin-bottom: 0;
  color: var(--danger);
  font-size: 0.82rem;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 18px 0 20px;
}
.text-input { margin-top: 2px; }

.toasts {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 60;
  display: grid;
  gap: 8px;
  width: min(360px, calc(100% - 36px));
}
.toast {
  padding: 11px 13px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: 12px;
  color: var(--text);
  background: var(--panel-solid);
  box-shadow: var(--shadow);
  font-size: 0.84rem;
  animation: toast-in 160ms ease-out;
}
.toast.ok { border-left-color: var(--ok); }
.toast.bad { border-left-color: var(--danger); }
.toast.leaving { animation: toast-out 200ms ease-in forwards; }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes toast-out { to { opacity: 0; transform: translateY(6px); } }

@media (max-width: 860px) {
  .hero { grid-template-columns: 1fr; align-items: start; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .toolbar-actions { justify-content: flex-start; }
}
@media (max-width: 560px) {
  main { width: min(100% - 24px, 1180px); }
  .topbar { padding: 11px 14px; }
  .brand-copy .eyebrow { display: none; }
  .hero h1 { font-size: 2rem; }
  .server-grid { grid-template-columns: 1fr; }
  .toolbar-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .toolbar-actions .search { grid-column: 1 / -1; }
  .toolbar-actions .button { width: 100%; }
  .path-card { padding: 16px; }
  .section-heading { align-items: flex-start; flex-direction: column; gap: 4px; }
  .modal > * { margin-left: 16px; margin-right: 16px; }
  .editor { width: calc(100% - 32px); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">M</div>
    <div class="brand-copy">
      <span class="eyebrow">本地控制台</span>
      <strong>manageable-mcp</strong>
    </div>
  </div>
  <div class="top-actions">
    <button id="authBtn" class="button ghost small" type="button" title="设置 API 令牌">API 令牌</button>
    <button id="themeToggle" class="icon-button" type="button" aria-label="切换主题" title="切换主题">&#9680;</button>
  </div>
</header>

<main>
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">管理控制台</p>
      <h1>集中管理这个代理暴露的所有能力。</h1>
      <p class="lede">添加、编辑、启用或移除 MCP 服务器。每次修改都会先校验，再原子写入代理读取的同一份配置。</p>
    </div>
    <aside class="path-card" aria-label="运行信息">
      <div class="path-row"><span>配置文件</span><code id="configPath">加载中...</code></div>
      <div class="path-row">
        <span>MCP 端点</span>
        <div style="display:flex;gap:6px;align-items:center">
          <code id="mcpPath" style="flex:1">加载中...</code>
          <button id="copyEndpointBtn" class="icon-button" type="button" title="复制 MCP 端点" aria-label="复制 MCP 端点" style="width:34px;height:34px;flex:0 0 auto">&#10697;</button>
        </div>
      </div>
      <div class="path-note">管理面板优先在本机使用。密钥值在原始配置中仍保留为环境变量或文件占位符。</div>
    </aside>
  </section>

  <section class="toolbar">
    <div id="stats" class="stats" aria-label="服务器概览"></div>
    <div class="toolbar-actions">
      <label class="search">
        <span class="sr-only">筛选服务器</span>
        <input id="search" type="search" placeholder="筛选服务器" autocomplete="off">
      </label>
      <div id="statusFilter" class="segmented" role="group" aria-label="按状态筛选">
        <button type="button" data-filter="all" class="is-active" aria-pressed="true">全部</button>
        <button type="button" data-filter="enabled" aria-pressed="false">已启用</button>
        <button type="button" data-filter="disabled" aria-pressed="false">已停用</button>
        <button type="button" data-filter="error" aria-pressed="false">异常</button>
      </div>
      <button id="reloadBtn" class="button" type="button">重新加载配置</button>
      <button id="probeBtn" class="button" type="button" title="连接所有已启用服务器并刷新工具数量">检测工具</button>
      <button id="addBtn" class="button primary" type="button">添加服务器</button>
    </div>
  </section>

  <div id="notice" class="notice" role="alert" hidden></div>

  <details id="clientPanel" class="client-panel">
    <summary>客户端一键接入</summary>
    <p>为本机客户端配置当前代理。接入前会检查启动，修改前会备份原文件；修改后请重启对应客户端。</p>
    <div id="clientList" aria-live="polite">展开后加载客户端状态。</div>
  </details>

  <section id="groupsPanel" class="groups-panel" hidden>
    <div class="section-heading">
      <h2>服务器组</h2>
      <p>组路由使用原始配置中保存的成员关系。</p>
    </div>
    <div id="groupList" class="group-list"></div>
  </section>

  <section class="server-section">
    <div class="section-heading">
      <h2>服务器</h2>
      <p id="serverCount">加载中...</p>
    </div>
    <div id="serverList" class="server-grid" aria-live="polite"></div>
  </section>
</main>

<div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>

<dialog id="editorDialog" class="modal" aria-labelledby="editorTitle">
  <div class="modal-head">
    <div>
      <p class="eyebrow">原始 JSON</p>
      <h2 id="editorTitle">添加服务器</h2>
    </div>
    <button id="editorClose" class="icon-button" type="button" aria-label="关闭">&times;</button>
  </div>
  <p id="editorHint" class="modal-hint"></p>
  <textarea id="editorText" class="editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="服务器配置 JSON"></textarea>
  <div id="editorError" class="form-error" role="alert" hidden></div>
  <div class="modal-actions">
    <button id="editorCancel" class="button" type="button">取消</button>
    <button id="editorSave" class="button primary" type="button">保存</button>
  </div>
</dialog>

<dialog id="authDialog" class="modal compact" aria-labelledby="authTitle">
  <div class="modal-head">
    <div>
      <p class="eyebrow">身份验证</p>
      <h2 id="authTitle">API 令牌</h2>
    </div>
    <button id="authClose" class="icon-button" type="button" aria-label="关闭">&times;</button>
  </div>
  <p class="modal-hint">粘贴 HTTP 传输层配置的 Bearer 令牌。它只保存在当前浏览器标签页的 sessionStorage 中，并作为 Authorization 请求头发送。</p>
  <input id="authInput" class="text-input" type="password" autocomplete="off" placeholder="Bearer 令牌">
  <p id="authError" class="form-error" role="alert" hidden></p>
  <div class="modal-actions">
    <button id="authClear" class="button ghost" type="button">清除令牌</button>
    <button id="authSave" class="button primary" type="button">使用令牌</button>
  </div>
</dialog>

<dialog id="oauthDialog" class="modal compact" aria-labelledby="oauthTitle">
  <div class="modal-head">
    <div>
      <p class="eyebrow">OAuth 授权</p>
      <h2 id="oauthTitle">授权服务器</h2>
    </div>
    <button id="oauthClose" class="icon-button" type="button" aria-label="关闭">&times;</button>
  </div>
  <p id="oauthHint" class="modal-hint"></p>
  <div id="oauthOpenField" class="modal-footer-row" hidden>
    <a id="oauthOpen" class="button primary" href="#" target="_blank" rel="noopener noreferrer">打开授权页面</a>
  </div>
  <div id="oauthUrlField" hidden>
    <span class="eyebrow">授权链接</span>
    <input id="oauthUrl" class="text-input" type="text" readonly spellcheck="false">
  </div>
  <div id="oauthDiagnostic" class="modal-hint" hidden></div>
  <div class="modal-actions">
    <button id="oauthCopy" class="button" type="button">复制链接</button>
    <button id="oauthClose2" class="button" type="button">关闭</button>
    <button id="oauthRefresh" class="button primary" type="button">我已授权，刷新</button>
  </div>
</dialog>

<dialog id="toolsDialog" class="modal" aria-labelledby="toolsTitle">
  <div class="modal-head">
    <div>
      <p class="eyebrow">工具列表</p>
      <h2 id="toolsTitle">工具列表</h2>
    </div>
    <button id="toolsClose" class="icon-button" type="button" aria-label="关闭">&times;</button>
  </div>
  <p id="toolsSub" class="modal-hint"></p>
  <div id="toolsBody" class="tool-list"></div>
  <div class="modal-actions">
    <button id="toolsClose2" class="button" type="button">关闭</button>
  </div>
</dialog>

<script>
(function () {
  'use strict';

  var TOKEN_KEY = 'mmcp.admin.token';
  var THEME_KEY = 'mmcp.admin.theme';
  var LONG_ERROR_CHAR_LIMIT = 160;
  var LONG_ERROR_LINE_LIMIT = 4;
  var LONG_ERROR_PREVIEW_LENGTH = 140;
  var NEW_SERVER_TEMPLATE = '{\n' +
    '  "name": "my-server",\n' +
    '  "description": "这个服务器提供什么能力",\n' +
    '  "command": "npx",\n' +
    '  "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/path/to/folder"],\n' +
    '  "enabled": true\n' +
    '}';

  var state = {
    data: null,
    token: '',
    filter: 'all',
    query: '',
    editing: null,
    loading: false,
    loadPromise: null,
    loadRefreshPending: false,
    loadRefreshQuiet: true,
    toolsCache: {},
    toolsRequestSeq: 0,
    toolsServer: null,
    probing: {},
    probingAll: false,
    autoProbeStarted: false,
    oauthServer: null,
    expandedErrors: {},
  };
  var els = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (error) {}
    updateThemeButton();
  }

  function updateThemeButton() {
    var dark = document.documentElement.dataset.theme === 'dark';
    els.themeToggle.textContent = dark ? '☀' : '☾';
    els.themeToggle.title = dark ? '切换到浅色主题' : '切换到深色主题';
    els.themeToggle.setAttribute('aria-label', els.themeToggle.title);
  }

  function bootToken() {
    var params = null;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (error) {}
    var bootstrap = params ? params.get('token') : null;
    if (bootstrap) {
      state.token = bootstrap;
      try {
        sessionStorage.setItem(TOKEN_KEY, bootstrap);
      } catch (error) {}
      try {
        params.delete('token');
        var query = params.toString();
        window.history.replaceState(
          null,
          '',
          window.location.pathname + (query ? '?' + query : '') + window.location.hash,
        );
      } catch (error) {}
      return;
    }
    try {
      state.token = sessionStorage.getItem(TOKEN_KEY) || '';
    } catch (error) {
      state.token = '';
    }
  }

  function api(path, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (options.headers) {
      Object.keys(options.headers).forEach(function (key) {
        headers[key] = options.headers[key];
      });
    }
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json';
    }
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
      cache: 'no-store',
    }).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (error) {
            body = { error: { message: text } };
          }
        }
        if (!response.ok) {
          var message = body && body.error && body.error.message
            ? body.error.message
            : '请求失败（状态码 ' + response.status + '）';
          var failure = new Error(message);
          failure.status = response.status;
          throw failure;
        }
        return body;
      });
    });
  }

  function loadClients() {
    els.clientList.textContent = '正在检查客户端...';
    return api('/api/admin/clients').then(function (body) {
      if (!body || !Array.isArray(body.data)) throw new Error('客户端状态格式错误');
      els.clientList.textContent = '';
      body.data.forEach(function (client) {
        var row = el('div', 'client-row');
        var info = el('div', 'client-info');
        var names = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode 2.x', cursor: 'Cursor' };
        info.appendChild(el('strong', null, names[client.client] || client.client));
        var status = el('span', null, client.state + ' · ' + (client.executableFound ? '已找到程序' : '未在 PATH 找到程序'));
        status.title = client.configPath;
        info.appendChild(status);
        row.appendChild(info);
        var actions = el('div', 'client-actions');
        [
          [client.state === '名称冲突' ? 'replace' : 'install', client.state === '名称冲突' ? '替换同名项' : (client.state === '已接入' ? '更新' : '接入'), client.state === '配置无效'],
          ['verify', '验证', client.state !== '已接入'],
          ['uninstall', '移除', client.state !== '已接入'],
          ['rollback', '回滚', false],
        ].forEach(function (item) {
          var button = el('button', 'button small', item[1]);
          button.type = 'button';
          button.disabled = item[2];
          button.addEventListener('click', function () { clientAction(client.client, item[0], button); });
          actions.appendChild(button);
        });
        row.appendChild(actions);
        els.clientList.appendChild(row);
      });
    }).catch(function (error) {
      els.clientList.textContent = error.message || '无法读取客户端状态。';
    });
  }

  function clientAction(client, action, button) {
    if (button.dataset.busy === '1') return;
    setBusy(button, true);
    api('/api/admin/clients/' + encodeURIComponent(client) + '/' + (action === 'replace' ? 'install' : action), {
      method: 'POST', body: action === 'replace' ? '{"replace":true}' : '{}',
    })
      .then(function () {
        var messages = { install: '配置已写入，代理启动检查通过', replace: '同名配置已替换，原文件已备份', verify: '代理启动检查通过', uninstall: '已移除接入', rollback: '已回滚配置' };
        toast(messages[action], 'ok');
        return loadClients();
      })
      .catch(function (error) { toast(error.message || '客户端操作失败', 'bad'); })
      .finally(function () { setBusy(button, false); });
  }

  function renderLongText(container, message, key, className) {
    container.textContent = '';
    if (message === undefined || message === null || message === '') return;
    if (isLongError(message)) {
      container.appendChild(buildErrorNotice(message, key, className));
    } else {
      container.textContent = String(message);
    }
  }

  function showNotice(message) {
    renderLongText(els.notice, message, 'notice', 'notice-collapsible');
    els.notice.hidden = false;
  }

  function clearNotice() {
    els.notice.textContent = '';
    els.notice.hidden = true;
  }

  function toast(message, kind) {
    var text = String(message);
    var long = isLongError(text);
    if (long && kind === 'bad') {
      showNotice(text);
      text = compactErrorText(text);
    }
    var node = el('div', 'toast ' + (kind || ''), text);
    if (long) node.title = String(message);
    els.toasts.appendChild(node);
    window.setTimeout(function () {
      node.classList.add('leaving');
      window.setTimeout(function () {
        node.remove();
      }, 220);
    }, 3400);
  }

  function setBusy(button, busy) {
    if (!button) return;
    if (busy) {
      if (button.dataset.busy === '1') return;
      button.dataset.busy = '1';
      button.dataset.label = button.textContent;
      button.textContent = '处理中...';
      button.disabled = true;
    } else {
      if (button.dataset.busy !== '1') return;
      delete button.dataset.busy;
      if (button.dataset.label !== undefined) {
        button.textContent = button.dataset.label;
        delete button.dataset.label;
      }
      button.disabled = false;
    }
  }

  function formatTime(value) {
    if (!value) return '从未';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '未知';
    return date.toLocaleString('zh-CN');
  }

  function statusLabel(status) {
    var labels = {
      idle: '空闲',
      connecting: '连接中',
      ready: '就绪',
      auth: '需要授权',
      error: '错误',
    };
    return labels[status] || String(status || '未知');
  }

  function authLabel(type) {
    if (type === 'oauth') return 'OAuth';
    if (type === 'api-key') return 'API 密钥';
    if (type === 'local') return '本地';
    return '自动检测';
  }

  function isLongError(text) {
    var value = String(text);
    return value.length > LONG_ERROR_CHAR_LIMIT ||
      value.split(/\r?\n/).length > LONG_ERROR_LINE_LIMIT;
  }

  function compactErrorText(text) {
    var value = String(text).replace(/\s+/g, ' ').trim();
    return value.length > LONG_ERROR_PREVIEW_LENGTH
      ? value.slice(0, LONG_ERROR_PREVIEW_LENGTH) + '…'
      : value;
  }

  function buildErrorNotice(text, key, className) {
    var message = String(text);
    if (!isLongError(message)) return el('p', className || 'card-error', message);

    var details = el(
      'details',
      'card-error card-error-collapsible' + (className ? ' ' + className : ''),
    );
    details.open = state.expandedErrors[key] === true;
    var summary = el('summary');
    summary.title = '展开或收起完整错误信息';
    summary.appendChild(el('span', 'error-summary-text', compactErrorText(message)));

    var action = el('span', 'error-summary-action');
    action.appendChild(el('span', 'error-summary-open', '展开详情'));
    action.appendChild(el('span', 'error-summary-close', '收起'));
    summary.appendChild(action);

    details.appendChild(summary);
    details.appendChild(el('pre', 'error-detail', message));
    details.addEventListener('toggle', function () {
      if (details.open) state.expandedErrors[key] = true;
      else delete state.expandedErrors[key];
    });
    return details;
  }

  function healthClass(server) {
    if (server.enabled === false) return 'muted';
    if (server.health && server.health.healthy === true) return 'ok';
    if (server.health && server.health.healthy === false) return 'bad';
    if (server.status === 'error' || server.status === 'auth') return 'bad';
    return 'unknown';
  }

  function healthTitle(server) {
    if (server.enabled === false) return '服务器已停用';
    if (!server.health) return '尚未进行健康探测';
    if (server.health.healthy) {
      return '健康' + (server.health.latencyMs !== undefined ? ' · ' + server.health.latencyMs + ' 毫秒' : '');
    }
    return '异常' + (server.health.error ? '：' + server.health.error : '');
  }

  function renderStats(servers) {
    els.stats.textContent = '';
    var enabled = servers.filter(function (server) { return server.enabled !== false; }).length;
    var disabled = servers.length - enabled;
    var issues = servers.filter(function (server) {
      return server.enabled !== false && server.status === 'error';
    }).length;
    var items = [
      { label: '服务器总数', value: servers.length, tone: '' },
      { label: '已启用', value: enabled, tone: 'ok' },
      { label: '已停用', value: disabled, tone: '' },
      { label: '异常', value: issues, tone: issues > 0 ? 'bad' : '' },
    ];
    items.forEach(function (item) {
      var stat = el('div', 'stat ' + item.tone);
      stat.appendChild(el('span', 'stat-value', item.value));
      stat.appendChild(el('span', 'stat-label', item.label));
      els.stats.appendChild(stat);
    });
  }

  function renderGroups(groups) {
    var names = groups && typeof groups === 'object' ? Object.keys(groups) : [];
    if (names.length === 0) {
      els.groupsPanel.hidden = true;
      els.groupList.textContent = '';
      return;
    }
    els.groupsPanel.hidden = false;
    els.groupList.textContent = '';
    names.forEach(function (name) {
      var group = groups[name] || {};
      var members = Array.isArray(group.servers) ? group.servers : [];
      var chip = el('span', 'group-chip');
      chip.appendChild(el('strong', null, name));
      chip.appendChild(el('span', 'group-count', members.length + ' 个服务器'));
      chip.title = group.description
        ? group.description + ' - ' + members.join('、')
        : members.join('、');
      els.groupList.appendChild(chip);
    });
  }

  function matchesFilter(server) {
    if (state.filter === 'enabled' && server.enabled === false) return false;
    if (state.filter === 'disabled' && server.enabled !== false) return false;
    if (state.filter === 'error' && !(server.enabled !== false && server.status === 'error')) {
      return false;
    }
    var needle = state.query.trim().toLowerCase();
    if (!needle) return true;
    var haystack = [
      server.name,
      server.description,
      Array.isArray(server.tags) ? server.tags.join(' ') : '',
    ].join(' ').toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  function buildToggle(server) {
    var label = el('label', 'switch');
    label.title = '启用或停用此服务器';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = server.enabled !== false;
    input.setAttribute('aria-label', '切换 ' + (server.name || '未命名服务器') + ' 的启用状态');
    input.addEventListener('change', function () {
      toggleServer(server, input);
    });
    var track = el('span', 'switch-track');
    track.appendChild(el('span', 'switch-thumb'));
    label.appendChild(input);
    label.appendChild(track);
    return label;
  }

  function renderServer(server) {
    var card = el('article', 'server-card');
    card.dataset.status = server.status || 'idle';
    if (server.enabled === false) card.classList.add('disabled');

    var head = el('div', 'card-head');
    var title = el('div', 'card-title');
    var dot = el('span', 'health-dot ' + healthClass(server));
    var healthLabel = healthTitle(server);
    dot.title = healthLabel;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', healthLabel);
    title.appendChild(dot);
    title.appendChild(el('h3', null, server.name || '(未命名)'));
    head.appendChild(title);

    var controls = el('div', 'card-controls');
    var badges = el('div', 'badges');
    badges.appendChild(el(
      'span',
      'badge type-' + String(server.type || 'local'),
      server.type === 'remote' ? '远程' : '本地',
    ));
    if (server.type === 'remote') {
      var authBadge = el(
        'span',
        'badge auth-' + String(server.authType || 'unknown'),
        authLabel(server.authType),
      );
      authBadge.title = String(server.authDetail || '');
      badges.appendChild(authBadge);
    }
    badges.appendChild(el('span', 'badge status-' + String(server.status || 'idle'), statusLabel(server.status)));
    if (server.enabled === false) badges.appendChild(el('span', 'badge disabled', '已停用'));
    controls.appendChild(badges);
    controls.appendChild(buildToggle(server));
    head.appendChild(controls);
    card.appendChild(head);

    card.appendChild(el('p', 'card-description', server.description || '暂无描述。'));

    if (server.target) {
      var target = el('div', 'card-target');
      target.title = String(server.target);
      target.appendChild(el('code', null, server.target));
      card.appendChild(target);
    }

    if (Array.isArray(server.tags) && server.tags.length > 0) {
      var tagRow = el('div', 'card-tags');
      server.tags.forEach(function (tag) {
        tagRow.appendChild(el('span', 'tag', tag));
      });
      card.appendChild(tagRow);
    }

    var problem = server.error || server.configError || (server.health && server.health.error);
    if (problem) card.appendChild(buildErrorNotice(problem, server.name));

    var meta = el('div', 'card-meta');
    var probing = state.probing[server.name] === true;
    var toolsCount = typeof server.toolsCount === 'number'
      ? server.toolsCount
      : (typeof server.toolCount === 'number' ? server.toolCount : null);
    var toolsAction = el('button', 'meta-action', probing
      ? '工具检测中...'
      : (toolsCount === null ? '工具数未知 · 点击检测' : '工具 ' + toolsCount + ' 个 · 查看'));
    toolsAction.type = 'button';
    toolsAction.disabled = probing || server.enabled === false;
    toolsAction.title = toolsCount === null
      ? '连接该服务器并检测工具数量'
      : '查看已检测到的工具列表';
    toolsAction.addEventListener('click', function () {
      if (toolsCount === null) probeOne(server);
      else openTools(server);
    });
    meta.appendChild(toolsAction);
    meta.appendChild(el('span', 'meta-item', '最近检查：' + formatTime(server.health && server.health.lastChecked)));
    if (server.health && server.health.latencyMs !== undefined) {
      meta.appendChild(el('span', 'meta-item', server.health.latencyMs + ' 毫秒'));
    }
    if (server.type === 'remote' && server.authDetail) {
      var authMeta = el('span', 'meta-item', server.authDetail);
      authMeta.title = String(server.authDetail);
      meta.appendChild(authMeta);
    }
    card.appendChild(meta);

    var actions = el('div', 'card-actions');
    var probe = el('button', 'button ghost small', '检测');
    probe.type = 'button';
    probe.disabled = probing || server.enabled === false;
    probe.title = '检测 ' + String(server.name || '') + ' 的工具';
    probe.addEventListener('click', function () {
      probeOne(server);
    });
    actions.appendChild(probe);

    if (
      server.type === 'remote' &&
      server.enabled !== false
    ) {
      var authNeeded = server.status === 'auth' || server.authRequired === true;
      var authSupported = authNeeded ||
        server.authType === 'oauth' ||
        server.authType === 'unknown';
      var authText = authNeeded
        ? (server.authRequired === true ? '重新授权' : '授权')
        : ((server.authType === 'unknown' || server.authType === 'api-key') ? '检测授权' : '授权');
      if (authSupported) {
        var authButton = el('button', 'button ghost small', authText);
        authButton.type = 'button';
        authButton.title = authNeeded
          ? '重新检查登录状态并获取 OAuth 授权链接'
          : '检测该服务器是否需要 OAuth，并在需要时获取授权链接';
        authButton.addEventListener('click', function () {
          onAuthorize(server, authButton);
        });
        actions.appendChild(authButton);
      }
    }

    var edit = el('button', 'button ghost small', '编辑 JSON');
    edit.type = 'button';
    edit.addEventListener('click', function () {
      openEditor(server);
    });
    var remove = el('button', 'button danger ghost small', '删除');
    remove.type = 'button';
    remove.addEventListener('click', function () {
      deleteServer(server, remove);
    });
    actions.appendChild(edit);
    actions.appendChild(remove);
    card.appendChild(actions);
    return card;
  }

  function renderEmpty(title, detail, withAddButton) {
    els.serverList.textContent = '';
    var wrap = el('div', 'empty-state');
    wrap.appendChild(el('div', 'empty-icon', '{}'));
    wrap.appendChild(el('h3', null, title));
    wrap.appendChild(el('p', null, detail));
    if (withAddButton) {
      var button = el('button', 'button primary', '添加服务器');
      button.type = 'button';
      button.addEventListener('click', function () {
        openEditor(null);
      });
      wrap.appendChild(button);
    }
    els.serverList.appendChild(wrap);
  }

  function render() {
    if (!state.data) return;
    els.configPath.textContent = state.data.configFile || '未知';
    els.mcpPath.textContent = state.data.mcpPath
      ? window.location.origin + state.data.mcpPath
      : '未知';
    var servers = Array.isArray(state.data.servers) ? state.data.servers : [];
    var filtered = servers.filter(matchesFilter);
    els.serverCount.textContent = (state.query || state.filter !== 'all')
      ? '显示 ' + filtered.length + ' / ' + servers.length
      : '共 ' + servers.length + ' 个服务器';
    renderStats(servers);
    renderGroups(state.data.groups || {});

    if (servers.length === 0) {
      renderEmpty('尚未配置服务器', '添加本地命令或远程 URL 即可开始。', true);
      return;
    }
    if (filtered.length === 0) {
      renderEmpty('没有匹配的服务器', '试试其他名称、描述或状态。', false);
      return;
    }

    els.serverList.textContent = '';
    filtered.forEach(function (server) {
      els.serverList.appendChild(renderServer(server));
    });
  }

  function renderLoading() {
    els.serverCount.textContent = '加载中...';
    els.serverList.textContent = '';
    for (var index = 0; index < 3; index += 1) {
      var card = el('div', 'server-card skeleton');
      card.appendChild(el('div', 'skeleton-line wide'));
      card.appendChild(el('div', 'skeleton-line'));
      card.appendChild(el('div', 'skeleton-line short'));
      els.serverList.appendChild(card);
    }
  }

  function renderFailure(error) {
    var message = error && error.message
      ? error.message
      : '请确认 HTTP 传输层正在运行。';
    els.serverList.textContent = '';
    var wrap = el('div', 'empty-state');
    wrap.appendChild(el('div', 'empty-icon', '!'));
    wrap.appendChild(el('h3', null, '无法连接管理 API'));
    wrap.appendChild(buildErrorNotice(message, 'load-failure', 'empty-error'));
    els.serverList.appendChild(wrap);
  }

  function updateAuthButton() {
    els.authBtn.classList.toggle('has-token', Boolean(state.token));
    els.authBtn.title = state.token ? '当前标签页已设置 API 令牌' : '设置 API 令牌';
  }

  function clearToolCaches() {
    state.toolsCache = {};
    state.toolsRequestSeq += 1;
    state.toolsServer = null;
  }

  function load(quiet) {
    if (state.loadPromise) {
      state.loadRefreshPending = true;
      if (!quiet) state.loadRefreshQuiet = false;
      return state.loadPromise;
    }

    var resolveLoad;
    var rejectLoad;
    var completion = new Promise(function (resolve, reject) {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    state.loadPromise = completion;
    state.loading = true;
    state.loadRefreshPending = false;
    state.loadRefreshQuiet = true;

    function runLoad(runQuiet) {
      if (!runQuiet) {
        clearNotice();
        renderLoading();
      }
      return api('/api/admin').then(function (body) {
        if (!body || !body.data) throw new Error('管理 API 返回了意外响应');
        state.data = body.data;
        clearNotice();
        render();
        updateAuthButton();
        autoProbeUnknown();
      }).catch(function (error) {
        if (error.status === 401) {
          openAuth();
          return;
        }
        showNotice(error.message || '无法加载管理面板。');
        if (!state.data) renderFailure(error);
      });
    }

    function finish() {
      if (state.loadRefreshPending) {
        var nextQuiet = state.loadRefreshQuiet;
        state.loadRefreshPending = false;
        state.loadRefreshQuiet = true;
        runLoad(nextQuiet).then(finish, fail);
        return;
      }
      state.loading = false;
      state.loadPromise = null;
      state.loadRefreshPending = false;
      state.loadRefreshQuiet = true;
      resolveLoad();
    }

    function fail(error) {
      state.loading = false;
      state.loadPromise = null;
      state.loadRefreshPending = false;
      state.loadRefreshQuiet = true;
      rejectLoad(error);
    }

    runLoad(quiet === true).then(finish, fail);
    return completion;
  }

  function toggleServer(server, input) {
    var desired = input.checked;
    input.disabled = true;
    api('/api/admin/servers/' + encodeURIComponent(server.name) + '/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: desired }),
    }).then(function () {
      toast(server.name + (desired ? ' 已启用' : ' 已停用'), 'ok');
      clearToolCaches();
      return load(true);
    }).catch(function (error) {
      toast(error.message || '切换失败', 'bad');
      load(true);
    }).finally(function () {
      input.disabled = false;
    });
  }

  function deleteServer(server, button) {
    if (button && button.dataset.busy === '1') return;
    if (!window.confirm('确定删除服务器 “' + server.name + '”？它也会从所有服务器组中移除。')) {
      return;
    }
    if (button) setBusy(button, true);
    api('/api/admin/servers/' + encodeURIComponent(server.name), { method: 'DELETE' })
      .then(function () {
        toast('已删除 ' + server.name, 'ok');
        clearToolCaches();
        return load(true);
      })
      .catch(function (error) {
        toast(error.message || '删除失败', 'bad');
        load(true);
      })
      .finally(function () {
        if (button) setBusy(button, false);
      });
  }

  function rawForServer(server) {
    if (server && isRecord(server.raw)) return server.raw;
    var copy = {};
    Object.keys(server || {}).forEach(function (key) {
      if (['status', 'transport', 'toolCount', 'health', 'error', 'raw'].indexOf(key) === -1) {
        copy[key] = server[key];
      }
    });
    return copy;
  }

  function showEditorError(message) {
    renderLongText(els.editorError, message, 'editor-error', 'form-error-collapsible');
    els.editorError.hidden = false;
  }

  function openEditor(server) {
    state.editing = server ? server.name : null;
    els.editorTitle.textContent = server ? '编辑 ' + server.name : '添加服务器';
    els.editorHint.textContent = server
      ? 'PUT 会替换这一条原始配置，请保持服务器名称不变。'
      : '粘贴原始服务器对象。需要 name、description，以及 command 或 url 二选一。';
    els.editorText.value = server
      ? JSON.stringify(rawForServer(server), null, 2)
      : NEW_SERVER_TEMPLATE;
    els.editorError.hidden = true;
    els.editorError.textContent = '';
    delete state.expandedErrors['editor-error'];
    if (!els.editorDialog.open) els.editorDialog.showModal();
    window.setTimeout(function () {
      els.editorText.focus();
      els.editorText.setSelectionRange(0, 0);
    }, 20);
  }

  function saveEditor() {
    if (els.editorSave.dataset.busy === '1') return;
    var parsed;
    try {
      parsed = JSON.parse(els.editorText.value);
    } catch (error) {
      showEditorError('JSON 格式有误，请检查语法后重试。');
      return;
    }
    if (!isRecord(parsed)) {
      showEditorError('服务器配置必须是一个 JSON 对象。');
      return;
    }

    var editing = state.editing;
    var path = editing
      ? '/api/admin/servers/' + encodeURIComponent(editing)
      : '/api/admin/servers';
    var method = editing ? 'PUT' : 'POST';

    setBusy(els.editorSave, true);
    api(path, { method: method, body: JSON.stringify(parsed) })
      .then(function () {
        els.editorDialog.close();
        toast(editing ? '已更新 ' + editing : '服务器已添加', 'ok');
        clearToolCaches();
        return load(true);
      })
      .catch(function (error) {
        showEditorError(error.message || '保存失败');
      })
      .finally(function () {
        setBusy(els.editorSave, false);
      });
  }

  function reloadConfig(button) {
    setBusy(button, true);
    api('/api/admin/reload', { method: 'POST' })
      .then(function (body) {
        var count = body && body.data && body.data.serverCount !== undefined
          ? '（' + body.data.serverCount + ' 个服务器）'
          : '';
        toast('配置已重新加载' + count, 'ok');
        clearToolCaches();
        return load(true);
      })
      .catch(function (error) {
        toast(error.message || '重新加载失败', 'bad');
      })
      .finally(function () {
        setBusy(button, false);
      });
  }

  function hasActiveProbes() {
    if (state.probingAll) return true;
    var names = Object.keys(state.probing);
    for (var index = 0; index < names.length; index += 1) {
      if (state.probing[names[index]] === true) return true;
    }
    return false;
  }

  function probeServers(button) {
    if (hasActiveProbes()) return;
    state.probingAll = true;
    setBusy(button, true);
    var servers = state.data && Array.isArray(state.data.servers) ? state.data.servers : [];
    servers.forEach(function (server) {
      if (server.enabled !== false) state.probing[server.name] = true;
    });
    render();
    api('/api/admin/probe', { method: 'POST', body: JSON.stringify({ concurrency: 3 }) })
      .then(function (body) {
        var results = body && body.data && Array.isArray(body.data.results)
          ? body.data.results
          : [];
        results.forEach(applyProbeResult);
        var summary = (body && body.data && body.data.summary) || {};
        var kind = (summary.failed || 0) > 0
          ? 'bad'
          : ((summary.authRequired || 0) > 0 ? 'ok' : 'ok');
        toast(
          '检测完成：成功 ' + (summary.ok || 0) +
            '，待授权 ' + (summary.authRequired || 0) +
            '，失败 ' + (summary.failed || 0),
          kind,
        );
        return load(true);
      })
      .catch(function (error) {
        toast(error.message || '探测失败', 'bad');
      })
      .finally(function () {
        state.probing = {};
        state.probingAll = false;
        setBusy(button, false);
        render();
      });
  }

  function findServer(name) {
    var servers = state.data && Array.isArray(state.data.servers) ? state.data.servers : [];
    for (var index = 0; index < servers.length; index += 1) {
      if (servers[index].name === name) return servers[index];
    }
    return null;
  }

  function applyProbeResult(result) {
    var server = findServer(result.name);
    if (!server) return;
    if (Array.isArray(result.tools)) state.toolsCache[result.name] = result.tools;
    server.toolsCount = typeof result.toolsCount === 'number' ? result.toolsCount : null;
    server.toolCount = server.toolsCount === null ? undefined : server.toolsCount;
    server.loaded = result.ok === true;
    var checkedAt = typeof result.checkedAt === 'number' ? result.checkedAt : Date.now();
    var health = {
      healthy: result.ok === true,
      lastChecked: checkedAt,
    };
    if (typeof result.latencyMs === 'number') health.latencyMs = result.latencyMs;
    if (result.ok === true) {
      server.health = health;
      server.healthy = true;
      delete server.error;
      delete server.authRequired;
      delete server.authUrl;
      server.status = server.enabled === false ? 'idle' : 'ready';
    } else if (result.authRequired) {
      health.error = result.error || '需要授权';
      health.authRequired = true;
      if (result.authUrl) health.authUrl = result.authUrl;
      server.health = health;
      server.healthy = false;
      server.authType = 'oauth';
      server.authDetail = '服务器要求 OAuth 授权';
      delete server.error;
      server.authRequired = true;
      if (result.authUrl) server.authUrl = result.authUrl;
      else delete server.authUrl;
      server.status = 'auth';
    } else {
      health.error = result.error || '工具检测失败';
      server.health = health;
      server.healthy = false;
      delete server.authRequired;
      delete server.authUrl;
      server.error = health.error;
      server.status = 'error';
    }
  }

  function probeOne(server) {
    if (!server || state.probingAll || state.probing[server.name]) return;
    state.probing[server.name] = true;
    render();
    api('/api/admin/servers/' + encodeURIComponent(server.name) + '/probe', { method: 'POST' })
      .then(function (body) {
        var data = body && body.data ? body.data : {};
        applyProbeResult(data);
        if (data.ok) {
          toast(server.name + '：检测到 ' + data.toolsCount + ' 个工具', 'ok');
        } else if (data.authRequired) {
          toast(server.name + ' 需要 OAuth 授权，请点击卡片上的「授权」', 'ok');
        } else {
          toast(server.name + '：' + (data.error || '检测失败'), 'bad');
        }
      })
      .catch(function (error) {
        toast(error.message || '检测失败', 'bad');
      })
      .finally(function () {
        delete state.probing[server.name];
        render();
      });
  }

  function autoProbeUnknown() {
    if (state.autoProbeStarted || hasActiveProbes()) return;
    var servers = state.data && Array.isArray(state.data.servers) ? state.data.servers : [];
    var names = servers
      .filter(function (server) {
        return server.enabled !== false &&
          server.toolsCount === null &&
          !state.probing[server.name];
      })
      .map(function (server) { return server.name; });
    if (names.length === 0) return;
    state.autoProbeStarted = true;
    state.probingAll = true;
    setBusy(els.probeBtn, true);
    names.forEach(function (name) { state.probing[name] = true; });
    render();
    api('/api/admin/probe', {
      method: 'POST',
      body: JSON.stringify({ onlyUnknown: true, concurrency: 2 }),
    })
      .then(function (body) {
        var results = body && body.data && Array.isArray(body.data.results)
          ? body.data.results
          : [];
        results.forEach(applyProbeResult);
      })
      .catch(function () {})
      .finally(function () {
        names.forEach(function (name) { delete state.probing[name]; });
        state.probingAll = false;
        setBusy(els.probeBtn, false);
        render();
      });
  }

  function renderTools(server, tools) {
    els.toolsTitle.textContent = server.name + ' 的工具';
    els.toolsSub.textContent = tools.length + ' 个工具 · 来自该服务器的 tools/list';
    els.toolsBody.textContent = '';
    if (tools.length === 0) {
      els.toolsBody.appendChild(el('div', 'tool-empty', '该服务器没有返回任何工具'));
      return;
    }
    tools.forEach(function (tool) {
      var row = el('div', 'tool-row');
      row.appendChild(el('code', null, tool.name));
      row.appendChild(el('p', null, tool.description || '（无描述）'));
      els.toolsBody.appendChild(row);
    });
  }

  function invalidateToolsRequest() {
    state.toolsRequestSeq += 1;
    state.toolsServer = null;
  }

  function closeTools() {
    invalidateToolsRequest();
    els.toolsDialog.close();
  }

  function openTools(server) {
    var requestSeq = state.toolsRequestSeq + 1;
    state.toolsRequestSeq = requestSeq;
    state.toolsServer = server.name;
    var cached = state.toolsCache[server.name];
    if (Array.isArray(cached)) {
      renderTools(server, cached);
      if (!els.toolsDialog.open) els.toolsDialog.showModal();
      return;
    }
    els.toolsTitle.textContent = server.name + ' 的工具';
    els.toolsSub.textContent = '正在读取工具列表...';
    els.toolsBody.textContent = '';
    els.toolsBody.appendChild(el('div', 'tool-empty', '正在读取工具列表...'));
    if (!els.toolsDialog.open) els.toolsDialog.showModal();
    api('/api/admin/servers/' + encodeURIComponent(server.name) + '/tools')
      .then(function (body) {
        if (requestSeq !== state.toolsRequestSeq || state.toolsServer !== server.name) {
          return;
        }
        var data = body && body.data ? body.data : {};
        if (data.authRequired) {
          els.toolsSub.textContent = '需要授权';
          els.toolsBody.textContent = '';
          els.toolsBody.appendChild(
            el('div', 'tool-empty', '该服务器需要先完成 OAuth 授权，请关闭此窗口并在卡片上点击「授权」。'),
          );
          return;
        }
        var tools = Array.isArray(data.tools) ? data.tools : [];
        state.toolsCache[server.name] = tools;
        if (typeof data.toolsCount === 'number') {
          server.toolsCount = data.toolsCount;
          server.toolCount = data.toolsCount;
        }
        renderTools(server, tools);
        render();
      })
      .catch(function (error) {
        if (requestSeq !== state.toolsRequestSeq || state.toolsServer !== server.name) {
          return;
        }
        els.toolsDialog.close();
        toast(error.message || '读取工具列表失败', 'bad');
      });
  }

  function openOauthDialog(name, authUrl, diagnostic) {
    var hasUrl = typeof authUrl === 'string' && /^https?:\/\//i.test(authUrl);
    state.oauthServer = name;
    els.oauthTitle.textContent = '授权 ' + name;
    els.oauthHint.textContent = hasUrl
      ? '在浏览器中打开下面的链接完成登录。授权完成后回到此面板，点击“我已授权，刷新”。'
      : '服务器要求授权，但没有返回可用的链接。请查看下方诊断信息。';
    els.oauthOpenField.hidden = !hasUrl;
    els.oauthUrlField.hidden = !hasUrl;
    els.oauthOpen.href = hasUrl ? authUrl : '#';
    els.oauthUrl.value = hasUrl ? authUrl : '';
    if (diagnostic) {
      renderLongText(
        els.oauthDiagnostic,
        diagnostic,
        'oauth-diagnostic',
        'oauth-diagnostic-collapsible',
      );
      els.oauthDiagnostic.hidden = false;
    } else {
      els.oauthDiagnostic.textContent = '';
      els.oauthDiagnostic.hidden = true;
    }
    if (!els.oauthDialog.open) els.oauthDialog.showModal();
  }

  function checkServerAuth(server, button, onRequired) {
    if (button && button.disabled) return;
    if (button) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = '检查中...';
    }
    api('/api/admin/servers/' + encodeURIComponent(server.name) + '/auth', { method: 'POST' })
      .then(function (body) {
        var data = body && body.data ? body.data : {};
        if (data.authRequired) {
          onRequired(data.authUrl, data.diagnostic);
        } else {
          toast('该服务器无需授权，已可正常使用', 'ok');
          clearToolCaches();
          load(true);
        }
      })
      .catch(function (error) {
        toast(error.message || '授权检查失败', 'bad');
      })
      .finally(function () {
        if (button) {
          button.disabled = false;
          if (button.dataset.label !== undefined) {
            button.textContent = button.dataset.label;
            delete button.dataset.label;
          }
        }
      });
  }

  function onAuthorize(server, button) {
    checkServerAuth(server, button, function (authUrl, diagnostic) {
      openOauthDialog(server.name, authUrl, diagnostic);
    });
  }

  function onAuthRefresh(button) {
    var name = state.oauthServer;
    els.oauthDialog.close();
    if (!name) {
      load(true);
      return;
    }
    var server = findServer(name) || { name: name };
    checkServerAuth(server, button, function (authUrl, diagnostic) {
      openOauthDialog(name, authUrl, diagnostic);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve();
        else reject(new Error('copy failed'));
      } catch (error) {
        reject(error);
      }
    });
  }

  function copyEndpoint() {
    var value = state.data && state.data.mcpPath
      ? window.location.origin + state.data.mcpPath
      : '';
    if (!value) {
      toast('暂无可复制的端点', 'ok');
      return;
    }
    copyText(value).then(function () {
      toast('已复制 MCP 端点', 'ok');
    }).catch(function () {
      toast('复制失败，请手动选择复制', 'bad');
    });
  }

  function openAuth() {
    els.authError.hidden = true;
    els.authError.textContent = '';
    els.authInput.value = state.token || '';
    if (!els.authDialog.open) els.authDialog.showModal();
    window.setTimeout(function () {
      els.authInput.focus();
      els.authInput.select();
    }, 20);
  }

  function saveAuth() {
    var value = els.authInput.value.trim();
    if (!value) {
      els.authError.textContent = '请输入 Bearer 令牌，或清除已保存的令牌。';
      els.authError.hidden = false;
      return;
    }
    state.token = value;
    try {
      sessionStorage.setItem(TOKEN_KEY, value);
    } catch (error) {}
    els.authDialog.close();
    updateAuthButton();
    load(true);
  }

  function clearAuth() {
    state.token = '';
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (error) {}
    els.authDialog.close();
    updateAuthButton();
    toast('API 令牌已清除', 'ok');
    load(true);
  }

  function bindEvents() {
    els.clientPanel.addEventListener('toggle', function () {
      if (els.clientPanel.open) loadClients();
    });
    els.themeToggle.addEventListener('click', function () {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    els.authBtn.addEventListener('click', openAuth);
    els.authSave.addEventListener('click', saveAuth);
    els.authClear.addEventListener('click', clearAuth);
    els.authClose.addEventListener('click', function () { els.authDialog.close(); });
    els.authInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveAuth();
      }
    });

    els.addBtn.addEventListener('click', function () { openEditor(null); });
    els.reloadBtn.addEventListener('click', function () { reloadConfig(els.reloadBtn); });
    els.probeBtn.addEventListener('click', function () { probeServers(els.probeBtn); });
    els.search.addEventListener('input', function () {
      state.query = els.search.value;
      if (state.data) render();
    });
    els.copyEndpointBtn.addEventListener('click', copyEndpoint);
    els.oauthClose.addEventListener('click', function () { els.oauthDialog.close(); });
    els.oauthClose2.addEventListener('click', function () { els.oauthDialog.close(); });
    els.oauthRefresh.addEventListener('click', function () { onAuthRefresh(els.oauthRefresh); });
    els.oauthCopy.addEventListener('click', function () {
      var value = els.oauthUrl.value;
      if (!value) {
        toast('没有可复制的授权链接', 'ok');
        return;
      }
      copyText(value).then(function () {
        toast('已复制授权链接', 'ok');
      }).catch(function () {
        toast('复制失败，请手动选择复制', 'bad');
      });
    });
    els.toolsClose.addEventListener('click', closeTools);
    els.toolsClose2.addEventListener('click', closeTools);
    els.toolsDialog.addEventListener('close', invalidateToolsRequest);
    var filterButtons = els.statusFilter.querySelectorAll('button');
    function syncFilterButtons() {
      for (var index = 0; index < filterButtons.length; index += 1) {
        var active = filterButtons[index].getAttribute('data-filter') === state.filter;
        filterButtons[index].classList.toggle('is-active', active);
        filterButtons[index].setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    for (var index = 0; index < filterButtons.length; index += 1) {
      filterButtons[index].addEventListener('click', function () {
        state.filter = this.getAttribute('data-filter') || 'all';
        syncFilterButtons();
        if (state.data) render();
      });
    }
    syncFilterButtons();

    els.editorClose.addEventListener('click', function () { els.editorDialog.close(); });
    els.editorCancel.addEventListener('click', function () { els.editorDialog.close(); });
    els.editorSave.addEventListener('click', saveEditor);
    els.editorText.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveEditor();
      }
    });

    [els.editorDialog, els.authDialog, els.oauthDialog, els.toolsDialog].forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog) return;
        if (dialog === els.toolsDialog) closeTools();
        else dialog.close();
      });
    });
  }

  function boot() {
    els = {
      themeToggle: byId('themeToggle'),
      authBtn: byId('authBtn'),
      configPath: byId('configPath'),
      mcpPath: byId('mcpPath'),
      stats: byId('stats'),
      search: byId('search'),
      reloadBtn: byId('reloadBtn'),
      probeBtn: byId('probeBtn'),
      addBtn: byId('addBtn'),
      notice: byId('notice'),
      clientPanel: byId('clientPanel'),
      clientList: byId('clientList'),
      groupsPanel: byId('groupsPanel'),
      groupList: byId('groupList'),
      serverCount: byId('serverCount'),
      serverList: byId('serverList'),
      toasts: byId('toasts'),
      editorDialog: byId('editorDialog'),
      editorTitle: byId('editorTitle'),
      editorHint: byId('editorHint'),
      editorText: byId('editorText'),
      editorError: byId('editorError'),
      editorClose: byId('editorClose'),
      editorCancel: byId('editorCancel'),
      editorSave: byId('editorSave'),
      authDialog: byId('authDialog'),
      authInput: byId('authInput'),
      authError: byId('authError'),
      authClose: byId('authClose'),
      authSave: byId('authSave'),
      authClear: byId('authClear'),
      copyEndpointBtn: byId('copyEndpointBtn'),
      statusFilter: byId('statusFilter'),
      oauthDialog: byId('oauthDialog'),
      oauthTitle: byId('oauthTitle'),
      oauthHint: byId('oauthHint'),
      oauthOpenField: byId('oauthOpenField'),
      oauthOpen: byId('oauthOpen'),
      oauthUrlField: byId('oauthUrlField'),
      oauthUrl: byId('oauthUrl'),
      oauthDiagnostic: byId('oauthDiagnostic'),
      oauthClose: byId('oauthClose'),
      oauthClose2: byId('oauthClose2'),
      oauthCopy: byId('oauthCopy'),
      oauthRefresh: byId('oauthRefresh'),
      toolsDialog: byId('toolsDialog'),
      toolsTitle: byId('toolsTitle'),
      toolsSub: byId('toolsSub'),
      toolsBody: byId('toolsBody'),
      toolsClose: byId('toolsClose'),
      toolsClose2: byId('toolsClose2'),
    };

    bootToken();
    bindEvents();
    updateThemeButton();
    updateAuthButton();
    load(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
</script>
</body>
</html>`;

export function renderAdminHtml(): string {
  return ADMIN_HTML;
}
