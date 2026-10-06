const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localDateString = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const today = () => localDateString(new Date());
const state = { view: "home", data: null, reportPeriod: "month", reportDate: today(), importDraft: null };
let installPrompt = null;
const labels = { home: "Home", goals: "Goals", reports: "Reports", history: "History", settings: "Settings" };
const icons = { bank: "landmark", cash: "wallet", waiting: "arrow-left-right", savings: "piggy-bank", INCOME: "arrow-down-left", EXPENSE: "arrow-up-right", WITHDRAWAL: "arrow-left-right", BANK_CASH: "arrow-left-right", SAVE: "piggy-bank", GOAL: "target", OWED: "receipt-text", OWED_CLEAR: "check" };
const iconMarkup = (name, extra = "") => `<span class="icon-svg ${extra}" style="--icon:url('/static/icons/${name}.svg')" aria-hidden="true"></span>`;
const money = cents => `R ${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, " ")}`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
async function api(path, options = {}) {
  if (window.moneyStore) return window.moneyStore.api(path, options);
  const response = await fetch(path, { ...options, headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options.headers } });
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : response;
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
function toast(text) { const node = $("#toast"); node.textContent = text; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2800); }
function applyTheme(mode, palette = "forest") {
  const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.palette = ["forest", "ocean", "berry", "sunset"].includes(palette) ? palette : "forest";
}
function modal(title, copy, content, onReady) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><button class="modal-x" data-close-modal aria-label="Close">×</button><h2>${escapeHtml(title)}</h2>${copy ? `<p class="modal-copy">${escapeHtml(copy)}</p>` : ""}${content}</section></div>`;
  root.onclick = event => { if (event.target.hasAttribute("data-close-modal")) closeModal(); };
  onReady?.();
}
function closeModal() { $("#modal-root").innerHTML = ""; }
function field(label, name, type = "text", value = "", attrs = "") { return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${attrs}></div>`; }
function selectField(label, name, values, chosen = "") { return `<div class="field"><label for="${name}">${label}</label><select id="${name}" name="${name}">${values.map(([value, text]) => `<option value="${escapeHtml(value)}" ${value === chosen ? "selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></div>`; }
function refresh() { return api("/api/initialize").then(data => { state.data = data; applyTheme(data.dark_mode, data.color_palette); if (data.setup_done) render(); else renderSetup(); }); }
function navigate(view) {
  state.view = view;
  $$("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $("#page-title").textContent = labels[view] || view;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function render() {
  if (!state.data) return;
  $("#today-label").textContent = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  $("#page-title").textContent = labels[state.view];
  const screen = ({ home: renderHome, goals: renderGoals, reports: renderReports, history: renderHistory, settings: renderSettings })[state.view] || renderHome;
  screen();
}
async function renderHome() {
  try {
    const data = await api("/api/home-summary");
    const b = data.balances;
    $("#view").innerHTML = `
      <div class="hero-balance"><div><div class="hero-label">Money across your pockets</div><div class="hero-amount">${money(b.bank + b.cash + b.waiting + b.savings)}</div><div class="hero-sub">Your full balance, including Savings</div></div><div class="hero-glyph">R</div></div>
      <div class="section-heading"><h2>Your pockets</h2></div>
      <div class="pocket-grid">${[["bank", "Bank"], ["cash", "Cash in hand"], ["waiting", "Cash sends waiting"], ["savings", "Savings"]].map(([key, title]) => `<article class="card pocket"><div class="pocket-top"><span>${title}</span><span class="pocket-icon">${iconMarkup(icons[key])}</span></div><div class="pocket-amount">${money(b[key])}</div></article>`).join("")}</div>
      <article class="card safe-card"><div class="safe-head"><div><div class="safe-title">Safe to spend</div><div class="safe-caption">Based on money in Bank and Cash in hand</div></div><span class="pocket-icon">${iconMarkup("wallet")}</span></div><div class="safe-grid"><div class="safe-cell"><div class="safe-k">Today</div><div class="safe-v">${money(data.today)}</div></div><div class="safe-cell"><div class="safe-k">This week</div><div class="safe-v">${money(data.week)}</div></div><div class="safe-cell"><div class="safe-k">Rest of month</div><div class="safe-v">${money(data.month)}</div></div></div>${b.owed > 0 ? `<div class="warning">You still need to put aside ${money(b.owed)} for savings. <button class="text-link" data-action="clear-owed">Move it to Savings</button></div>` : b.bank + b.cash <= 0 ? `<div class="warning">There is no money available to spend right now.</div>` : ""}</article>
      <div class="summary-grid"><article class="card summary-card"><h3>This week</h3><div class="summary-items"><div><div class="summary-label">Money in</div><div class="summary-value green">${money(data.week_in)}</div></div><div><div class="summary-label">Money out</div><div class="summary-value red">${money(data.week_out)}</div></div><div><div class="summary-label">Saved</div><div class="summary-value blue">${money(data.week_saved)}</div></div></div></article><article class="card summary-card"><h3>This month</h3><div class="summary-items"><div><div class="summary-label">Money in</div><div class="summary-value green">${money(data.month_in)}</div></div><div><div class="summary-label">Money out</div><div class="summary-value red">${money(data.month_out)}</div></div><div><div class="summary-label">Saved</div><div class="summary-value blue">${money(data.month_saved)}</div></div></div></article></div><div class="row-meta" style="margin:10px 2px">3 full-month average · In ${money(data.avg_in)} · Out ${money(data.avg_out)}</div>
      <div class="section-heading"><h2>Cash sends waiting</h2><span class="row-meta">${state.data.waiting.length} to withdraw</span></div><article class="card">${waitingHtml(state.data.waiting)}</article>
      <div class="actions"><button class="button" data-action="income">+ Money in</button><button class="button secondary" data-action="expense">− Money out</button><button class="button ghost" data-action="import">⇧ Import bank statement</button></div>
      <div class="section-heading"><h2>Recent activity</h2><button class="text-link" data-view="history">See history</button></div><article class="card">${activityHtml(state.data.entries)}</article>`;
  } catch (error) { showError(error); }
}
function waitingHtml(rows) {
  if (!rows.length) return `<div class="empty"><strong>Nothing waiting to withdraw</strong>New cash sends will show up here.</div>`;
  return `<div class="list">${rows.map(row => `<div class="cash-row"><span class="row-icon">${iconMarkup("arrow-left-right")}</span><div class="row-main"><div class="row-title">${escapeHtml(row.person)}</div><div class="row-meta">${new Date(`${row.entry_date}T12:00:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}</div></div><strong class="row-amount">${money(row.remaining)}</strong><button class="button small secondary" data-withdraw="${row.id}">Withdraw</button></div>`).join("")}</div>`;
}
function activityHtml(rows) {
  if (!rows?.length) return `<div class="empty"><strong>Your activity will appear here</strong>Add money in or out to get started.</div>`;
  return `<div class="list">${rows.map(row => {
    const title = row.entry_type === "INCOME" ? row.person : row.entry_type === "EXPENSE" ? row.category : row.entry_type === "SAVE" ? "Moved to Savings" : row.entry_type === "WITHDRAWAL" ? "Cash send withdrawn" : row.note || "Money moved";
    const positive = ["INCOME", "SAVE"].includes(row.entry_type);
    return `<div class="list-row"><span class="row-icon">${iconMarkup(icons[row.entry_type] || "receipt-text")}</span><div class="row-main"><div class="row-title">${escapeHtml(title)}</div><div class="row-meta">${new Date(`${row.entry_date}T12:00:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })} · ${escapeHtml(row.entry_type.toLowerCase().replace("_", " "))}</div></div><div class="row-amount ${positive ? "green" : row.entry_type === "EXPENSE" ? "red" : ""}">${positive ? "+" : row.entry_type === "EXPENSE" ? "−" : ""}${money(row.amount)}</div></div>`;
  }).join("")}</div>`;
}
function showError(error) { toast(error.message || "Something went wrong."); }
function formButtons(cancelText = "Cancel", saveText = "Save") { return `<div class="modal-actions"><button type="button" class="button ghost" data-close-modal>${cancelText}</button><button class="button" type="submit">${saveText}</button></div>`; }
function openIncome() {
  const people = state.data.people;
  const personOptions = people.map(name => `<option value="${escapeHtml(name)}"></option>`).join("");
  modal("Money in", "Add money you have received.", `<form id="income-form"><div class="form-grid">${field("Amount", "amount", "number", "", 'min="0.01" step="0.01" inputmode="decimal" required autofocus')}${field("Date", "date", "date", today(), "required")}<div class="field full"><label for="person">From whom</label><input id="person" name="person" list="saved-people" autocomplete="off" required><datalist id="saved-people">${personOptions}</datalist></div>${selectField("How it arrived", "arrival", [["bank", "Bank deposit"], ["cashsend", "Cash send (must withdraw)"], ["cash", "Cash in hand"]], "bank")}<div class="field"><label for="note">Note (optional)</label><input id="note" name="note" autocomplete="off"></div></div>${formButtons()}</form>`, () => { $("#income-form").onsubmit = submitIncome; $("#amount").focus(); });
}
async function submitIncome(event) {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  try { const result = await post("/api/income", data); closeModal(); toast(`Saved: ${money(result.amount)} from ${data.person}`); await refresh(); if (result.suggested > 0) openReminder(result); }
  catch (error) { toast(error.message); }
}
function openReminder(income) {
  const pct = state.data.savings_pct;
  modal("A little for Savings", "Every bit set aside now gives you more breathing room later.", `<div class="reminder-callout">Put aside <strong>${money(income.suggested)}</strong> (${pct}% of ${money(income.amount)}).<br><label for="save-amount">Change amount if needed</label><br><input id="save-amount" type="number" min="0" step="0.01" value="${(income.suggested / 100).toFixed(2)}" inputmode="decimal"></div><div class="actions"><button class="button" data-reminder="done">Done, I moved it</button><button class="button secondary" data-reminder="later">Later</button><button class="button ghost" data-reminder="skip">Skip this one</button></div>`, () => {
    $$('[data-reminder]').forEach(button => button.onclick = async () => {
      try { await post(income.import_id ? "/api/import/reminder" : "/api/reminder", { income_id: income.id, import_id: income.import_id, action: button.dataset.reminder, amount: $("#save-amount").value }); closeModal(); toast(button.dataset.reminder === "done" ? "Moved to Savings." : button.dataset.reminder === "later" ? "Savings reminder added." : "Skipped this time."); await refresh(); }
      catch (error) { toast(error.message); }
    });
  });
}
function openClearOwed() {
  const owed = state.data.balances.owed;
  modal("Put aside savings", `You still need to put aside ${money(owed)}.`, `<form id="clear-owed-form"><div class="form-grid">${field("Amount", "amount", "number", (owed / 100).toFixed(2), 'min="0.01" step="0.01" inputmode="decimal" required')}${selectField("Move from", "pocket", [["bank", "Bank"], ["cash", "Cash in hand"]], "bank")}</div>${formButtons("Cancel", "Move to Savings")}</form>`, () => { $("#clear-owed-form").onsubmit = async event => { event.preventDefault(); try { await post("/api/owed/clear", Object.fromEntries(new FormData(event.currentTarget))); closeModal(); toast("Savings moved and reminder cleared."); await refresh(); } catch (error) { toast(error.message); } }; });
}
function openExpense() {
  const categories = state.data.categories.map(item => [item, item]);
  modal("Money out", "Keep track of something you spent.", `<form id="expense-form"><div class="form-grid">${field("Amount", "amount", "number", "", 'min="0.01" step="0.01" inputmode="decimal" required autofocus')}${field("Date", "date", "date", today(), "required")}${selectField("Category", "category", categories.map((item, i) => i ? item : item), "Food")}${selectField("Paid from", "pocket", [["bank", "Bank"], ["cash", "Cash in hand"]], "bank")}<div class="field full"><label for="note">Note (optional)</label><input id="note" name="note"></div></div>${formButtons()}</form>`, () => { $("#expense-form").onsubmit = async event => { event.preventDefault(); try { await post("/api/expense", Object.fromEntries(new FormData(event.currentTarget))); closeModal(); toast("Money out saved."); await refresh(); } catch (error) { toast(error.message); } }; $("#amount").focus(); });
}
function openWithdraw(id) {
  modal("Withdraw cash send", "Enter the date and any ATM fee.", `<form id="withdraw-form"><div class="form-grid">${field("Date withdrawn", "date", "date", today(), "required")}${field("ATM fee", "fee", "number", "0", 'min="0" step="0.01" inputmode="decimal"')}</div>${formButtons("Cancel", "Withdrawn")}</form>`, () => { $("#withdraw-form").onsubmit = async event => { event.preventDefault(); try { await post("/api/withdraw", { ...Object.fromEntries(new FormData(event.currentTarget)), income_id: id }); closeModal(); toast("Cash send withdrawn."); await refresh(); } catch (error) { toast(error.message); } }; });
}
async function renderGoals() {
  try {
    const { goals } = await api("/api/goals");
    $("#view").innerHTML = `<div class="report-top"><div><div class="eyebrow">Plan for what matters</div><div class="hero-sub">Savings available: <strong>${money(state.data.balances.savings)}</strong></div></div><button class="button" data-action="new-goal">+ New goal</button></div><div class="section-heading"><h2>Your goals</h2><span class="row-meta">${goals.length} total</span></div>${goals.length ? goals.map(goal => { const ratio = Math.min(100, goal.target ? goal.saved * 100 / goal.target : 0); const remaining = Math.max(0, goal.target - goal.saved); let weekly = ""; if (goal.target_date && remaining) { const days = Math.max(1, (new Date(`${goal.target_date}T12:00:00`) - new Date()) / 86400000); weekly = `<span>About ${money(Math.ceil(remaining * 7 / days))} / week</span>`; } return `<article class="card goal-card"><div class="goal-head"><div><div class="goal-title">${escapeHtml(goal.name)} ${goal.finished ? "✓" : ""}</div><div class="goal-sub">${goal.target_date ? `Target ${new Date(`${goal.target_date}T12:00:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}` : "No target date"}</div></div>${!goal.finished ? `<button class="button small secondary" data-goal-add="${goal.id}">Add money</button>` : ""}</div><div class="progress"><span style="width:${ratio}%"></span></div><div class="goal-footer"><span>${money(goal.saved)} saved · ${money(remaining)} left</span>${weekly}</div></article>`; }).join("") : `<article class="card empty"><strong>Give your savings a direction</strong>Create a goal for something you are working toward.</article>`}`;
  } catch (error) { showError(error); }
}
function openGoal() {
  modal("New goal", "Choose a name and target amount.", `<form id="goal-form"><div class="form-grid">${field("Goal name", "name", "text", "", "required")}${field("Target amount", "target", "number", "", 'min="0.01" step="0.01" inputmode="decimal" required')}${field("Target date (optional)", "target_date", "date", "", "")}</div>${formButtons()}</form>`, () => { $("#goal-form").onsubmit = async event => { event.preventDefault(); try { await post("/api/goals", Object.fromEntries(new FormData(event.currentTarget))); closeModal(); toast("Goal added."); await renderGoals(); } catch (error) { toast(error.message); } }; });
}
function openGoalAdd(id) {
  modal("Add to goal", "This amount will come from Savings.", `<form id="goal-add-form">${field("Amount", "amount", "number", "", 'min="0.01" step="0.01" inputmode="decimal" required')}${formButtons("Cancel", "Add money")}</form>`, () => { $("#goal-add-form").onsubmit = async event => { event.preventDefault(); try { await post(`/api/goals/${id}/add`, Object.fromEntries(new FormData(event.currentTarget))); closeModal(); toast("Added to your goal."); await refresh(); await renderGoals(); } catch (error) { toast(error.message); } }; });
}
async function renderReports() {
  try {
    const report = await api(`/api/reports?period=${state.reportPeriod}&date=${state.reportDate}`);
    const periodTitle = state.reportPeriod === "week" ? `${new Date(`${report.start}T12:00:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })} – ${new Date(`${report.end}T12:00:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}` : state.reportPeriod === "year" ? state.reportDate.slice(0, 4) : new Date(`${state.reportDate.slice(0, 7)}-15T12:00:00`).toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
    const back = offsetDate(-1, state.reportPeriod), forward = offsetDate(1, state.reportPeriod);
    $("#view").innerHTML = `<div class="report-top"><div class="period-switch">${["week", "month", "year"].map(p => `<button data-period="${p}" class="${state.reportPeriod === p ? "active" : ""}">${p[0].toUpperCase()}${p.slice(1)}</button>`).join("")}</div><div class="page-actions"><button class="button small ghost" data-date="${back}">‹</button><strong>${periodTitle}</strong><button class="button small ghost" data-date="${forward}" ${state.reportDate >= today() ? "disabled" : ""}>›</button><a class="button small secondary" href="/api/export.csv?period=${state.reportPeriod}&date=${state.reportDate}">Export CSV</a></div></div><div class="report-total-grid">${[["Total in", report.in, "green"], ["Total out", report.out, "red"], ["Saved", report.saved, "blue"], ["Left over", report.left, ""]].map(([label, value, color]) => `<article class="card metric"><div class="metric-label">${label}</div><div class="metric-value ${color}">${money(value)}</div></article>`).join("")}</div>${state.reportPeriod === "year" ? `<article class="card" style="margin-top:16px"><div class="card-title">Month by month · saved ${report.save_rate}% of income</div>${bars(report.months)}<div class="table-wrap"><table class="data-table"><thead><tr><th>Month</th><th class="numeric">In</th><th class="numeric">Out</th><th class="numeric">Saved</th></tr></thead><tbody>${report.months.map(m => `<tr><td>${m.month}</td><td class="numeric green">${money(m.in)}</td><td class="numeric red">${money(m.out)}</td><td class="numeric blue">${money(m.saved)}</td></tr>`).join("")}</tbody></table></div></article>` : ""}<div class="breakdown-grid"><article class="card"><div class="card-title">Money in by person</div>${breakdown(report.people)}</article><article class="card"><div class="card-title">Money in by arrival</div>${breakdown(report.arrivals, { bank: "Bank deposit", cash: "Cash in hand", cashsend: "Cash send" })}</article><article class="card"><div class="card-title">Money out by category</div>${breakdown(report.categories)}</article></div>`;
  } catch (error) { showError(error); }
}
function offsetDate(offset, period) { const d = new Date(`${state.reportDate}T12:00:00`); if (period === "week") d.setDate(d.getDate() + offset * 7); else if (period === "year") d.setFullYear(d.getFullYear() + offset); else d.setMonth(d.getMonth() + offset); return localDateString(d); }
function breakdown(obj = {}, names = {}) { const rows = Object.entries(obj); return rows.length ? rows.sort((a, b) => b[1] - a[1]).map(([name, cents]) => `<div class="breakdown-line"><span>${escapeHtml(names[name] || name)}</span><strong>${money(cents)}</strong></div>`).join("") : `<div class="empty">Nothing recorded for this period.</div>`; }
function bars(months) {
  setTimeout(() => {
    const canvas = $("#year-chart");
    if (!canvas || typeof Chart === "undefined") return;
    const styles = getComputedStyle(document.documentElement);
    new Chart(canvas, {
      type: "bar",
      data: { labels: months.map(month => month.month), datasets: [
        { label: "In", data: months.map(month => month.in / 100), backgroundColor: styles.getPropertyValue("--green").trim(), borderRadius: 5 },
        { label: "Out", data: months.map(month => month.out / 100), backgroundColor: "#d9786e", borderRadius: 5 },
        { label: "Saved", data: months.map(month => month.saved / 100), backgroundColor: styles.getPropertyValue("--blue").trim(), borderRadius: 5 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "rectRounded", boxWidth: 8, color: styles.getPropertyValue("--muted").trim() } }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${money(context.parsed.y * 100)}` } } }, scales: { x: { grid: { display: false }, ticks: { color: styles.getPropertyValue("--muted").trim() } }, y: { beginAtZero: true, grid: { color: styles.getPropertyValue("--line").trim() }, ticks: { color: styles.getPropertyValue("--muted").trim(), callback: value => money(value * 100) } } } }
    });
  }, 0);
  return `<div class="chart-holder"><canvas id="year-chart" role="img" aria-label="Money in, money out, and savings by month"></canvas></div>`;
}
async function renderHistory() {
  try {
    const params = new URLSearchParams();
    $$("[data-filter]").forEach(input => { if (input.value) params.set(input.dataset.filter, input.value); });
    const data = await api(`/api/history?${params}`);
    const type = $("#view [name='history-type']")?.value || "";
    $("#view").innerHTML = `<div class="report-top"><div><div class="eyebrow">Every entry in one place</div><div class="hero-sub">${data.entries.length} entries shown</div></div><button class="button secondary" data-action="import">⇧ Import bank statement</button></div><div class="filter-row" style="margin-top:17px"><select name="history-type" data-filter="type"><option value="">All types</option>${[["INCOME", "Money in"], ["EXPENSE", "Money out"], ["SAVE", "Savings"], ["WITHDRAWAL", "Withdrawals"], ["BANK_CASH", "Cash withdrawals"]].map(([v, t]) => `<option value="${v}" ${type === v ? "selected" : ""}>${t}</option>`).join("")}</select><input data-filter="person" placeholder="Person" value="${escapeHtml(params.get("person") || "")}"><input data-filter="category" placeholder="Category" value="${escapeHtml(params.get("category") || "")}"><input data-filter="from" type="date" aria-label="From date" value="${escapeHtml(params.get("from") || "")}"><input data-filter="to" type="date" aria-label="To date" value="${escapeHtml(params.get("to") || "")}"></div><article class="card">${data.entries.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Type</th><th>Person / category</th><th>Note</th><th class="numeric">Amount</th><th></th></tr></thead><tbody>${data.entries.map(row => `<tr><td>${row.entry_date}</td><td>${row.entry_type.toLowerCase().replace("_", " ")}</td><td>${escapeHtml(row.person || row.category || row.note)}</td><td>${escapeHtml(row.note)}</td><td class="numeric">${money(row.amount)}</td><td><button class="text-link" data-edit-entry="${row.id}">Edit</button> <button class="text-link" data-delete-entry="${row.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty"><strong>No matching entries</strong>Try changing the filters or add your first entry.</div>`}</article>${data.imports.length ? `<div class="section-heading"><h2>Bank imports</h2></div><article class="card">${data.imports.map(id => `<div class="list-row"><span class="row-main">Import ${id}</span><button class="button small danger" data-undo-import="${id}">Undo this import</button></div>`).join("")}</article>` : ""}`;
  } catch (error) { showError(error); }
}
function openEditEntry(id) {
  const row = state.data.entries.find(item => item.id === id);
  api("/api/history").then(data => {
    const entry = data.entries.find(item => item.id === id);
    if (!entry) return toast("Entry not found.");
    modal("Edit entry", "Changes update your pocket balances automatically.", `<form id="edit-entry-form">${field("Amount", "amount", "number", (entry.amount / 100).toFixed(2), 'min="0" step="0.01" required')}${field("Date", "date", "date", entry.entry_date, "required")}${field("Person", "person", "text", entry.person)}${field("Category", "category", "text", entry.category)}<div class="field"><label for="pocket">Paid from</label><select id="pocket" name="pocket"><option value="bank" ${entry.pocket === "bank" ? "selected" : ""}>Bank</option><option value="cash" ${entry.pocket === "cash" ? "selected" : ""}>Cash in hand</option></select></div>${field("Note", "note", "text", entry.note)}${formButtons()}</form>`, () => { $("#edit-entry-form").onsubmit = async event => { event.preventDefault(); try { await api(`/api/entries/${id}`, { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast("Entry updated."); await refresh(); await renderHistory(); } catch (error) { toast(error.message); } }; });
  });
}
function addSettingsEditors(settings) {
  const section = $$("#view .setting-section")[2];
  if (section) {
    const start = settings.opening;
    section.innerHTML = `<h3>Starting balances</h3><form id="opening-form" class="form-grid">${[["bank", "Bank"], ["cash", "Cash in hand"], ["waiting", "Cash sends waiting"], ["savings", "Savings"]].map(([key, label]) => `<div class="field"><label for="opening-${key}">${label}</label><input id="opening-${key}" name="${key}" type="number" min="0" step="0.01" value="${(Number(start[key]) / 100).toFixed(2)}" required></div>`).join("")}<div class="field full"><button type="button" class="button secondary" data-action="save-openings">Save starting balances</button></div></form><p class="row-meta">Changes adjust the pocket balance.</p>`;
  }
  $$("#view [data-remove-list]").forEach(remove => {
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "✎";
    rename.title = "Rename";
    rename.dataset.renameList = remove.dataset.removeList;
    rename.dataset.name = remove.dataset.name;
    remove.before(rename);
  });
  const dataSection = $$("#view .setting-section").find(item => item.textContent.includes("Your data"));
  if (dataSection && !$("#device-backup-file")) {
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "button ghost";
    restoreButton.dataset.action = "restore-backup";
    restoreButton.textContent = "↑ Restore a device backup";
    dataSection.querySelector(".actions")?.append(restoreButton);
    const input = document.createElement("input");
    input.id = "device-backup-file";
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    dataSection.append(input);
  }
}
function addPaletteEditor(settings) {
  const appearance = $$("#view .setting-section").find(item => item.querySelector(".segmented"));
  if (!appearance) return;
  const options = [["forest", "Forest", "#145b4b"], ["ocean", "Ocean", "#176b87"], ["berry", "Berry", "#7950a1"], ["sunset", "Sunset", "#b55336"]];
  appearance.insertAdjacentHTML("beforeend", `<h3 class="palette-heading">Color palette</h3><div class="palette-options" role="group" aria-label="Color palette">${options.map(([id, label, color]) => `<button type="button" class="palette-option ${settings.color_palette === id ? "active" : ""}" data-palette="${id}" aria-pressed="${settings.color_palette === id}" aria-label="${label} palette"><span class="palette-swatch" style="--swatch:${color}"></span><span>${label}</span></button>`).join("")}</div>`);
}
async function renderSettings() {
  try {
    const settings = await api("/api/settings");
    $("#view").innerHTML = `<div class="panel-grid"><article class="card"><div class="card-title">Preferences</div><div class="setting-section"><h3>Savings reminder</h3><div class="inline-form"><label for="savings-pct">Set aside</label><input id="savings-pct" type="number" min="0" max="100" step="1" value="${settings.savings_pct}" style="width:90px"><span>% of money in</span><button class="button small" data-action="save-settings">Save</button></div></div><div class="setting-section"><h3>Appearance</h3><div class="segmented">${[["system", "Device"], ["light", "Light"], ["dark", "Dark"]].map(([v, t]) => `<button data-theme="${v}" class="${settings.dark_mode === v ? "active" : ""}">${t}</button>`).join("")}</div></div><div class="setting-section"><h3>Starting balances</h3><p class="row-meta">${Object.keys(settings.opening).map(key => `${key}: ${money(settings.opening[key])}`).join(" · ")}</p><p class="row-meta">Starting balances are locked once you add entries.</p></div><div class="setting-section"><h3>Your data</h3><div class="actions"><a class="button secondary" href="/api/backup">↓ Back up my data</a><button class="button ghost" data-action="import">⇧ Import bank statement</button></div><p class="row-meta">Your data stays in this folder on this device.</p></div></article><article class="card"><div class="card-title">People</div><div class="setting-section"><div class="inline-form"><input id="new-person" placeholder="Add a person"><button class="button small" data-add-list="people">Add</button></div><div class="tag-list">${state.data.people.map(name => `<span class="tag">${escapeHtml(name)}<button data-remove-list="people" data-name="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button></span>`).join("")}</div></div><div class="setting-section"><h3>Categories</h3><div class="inline-form"><input id="new-category" placeholder="Add a category"><button class="button small" data-add-list="categories">Add</button></div><div class="tag-list">${state.data.categories.map(name => `<span class="tag">${escapeHtml(name)}<button data-remove-list="categories" data-name="${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">×</button></span>`).join("")}</div></div></article></div>`;
    addSettingsEditors(settings);
    addPaletteEditor(settings);
    if (installPrompt) {
      const installButton = document.createElement("button");
      installButton.className = "button secondary pwa-install";
      installButton.dataset.action = "install-pwa";
      installButton.innerHTML = `${iconMarkup("upload")} Install Money Tracker`;
      $("#view .card").prepend(installButton);
    }
  } catch (error) { showError(error); }
}
async function saveSettings() {
  try { await post("/api/settings", { savings_pct: $("#savings-pct").value, dark_mode: state.data.dark_mode }); toast("Settings saved."); await refresh(); }
  catch (error) { toast(error.message); }
}
function renderSetup() {
  $("#page-title").textContent = "Welcome";
  $("#view").innerHTML = `<div class="panel-grid"><div class="hero-balance"><div><div class="hero-label">A clearer view of your money</div><div class="hero-amount">Start with today.</div><div class="hero-sub">Your records stay on this device.</div></div><div class="hero-glyph">R</div></div><article class="card"><h2 class="card-title">Starting balances</h2><p class="row-meta">Enter what's already in each pocket. Zero is fine.</p><form id="setup-form" class="form-grid" style="margin-top:18px">${field("Bank", "bank", "number", "0", 'min="0" step="0.01" inputmode="decimal" required')}${field("Cash in hand", "cash", "number", "0", 'min="0" step="0.01" inputmode="decimal" required')}${field("Cash sends waiting", "waiting", "number", "0", 'min="0" step="0.01" inputmode="decimal" required')}${field("Savings", "savings", "number", "0", 'min="0" step="0.01" inputmode="decimal" required')}<div class="field full"><button class="button block">Get started</button></div></form></article></div>`;
  $("#setup-form").onsubmit = async event => { event.preventDefault(); try { await post("/api/setup", Object.fromEntries(new FormData(event.currentTarget))); await refresh(); toast("Your pockets are ready."); } catch (error) { toast(error.message); } };
}
async function beginImport() {
  modal("Import bank statement", "Choose a CSV file from your bank. It is read only on this device.", `<form id="import-upload"><div class="field"><label for="statement-file">CSV file</label><input id="statement-file" type="file" name="file" accept=".csv,text/csv" required></div>${formButtons("Cancel", "Match columns")}</form>`, () => {
    $("#import-upload").onsubmit = async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      try { const draft = await api("/api/import/preview", { method: "POST", body: form }); state.importDraft = draft; closeModal(); showImportMapping(); }
      catch (error) { toast(error.message); }
    };
  });
}
function showImportMapping() {
  const d = state.importDraft;
  const select = (label, key) => `<div class="field"><label>${label}</label><select data-map="${key}"><option value="-1">Not used</option>${d.headers.map((h, i) => `<option value="${i}" ${Number(d.mapping[key]) === i ? "selected" : ""}>${escapeHtml(h)}</option>`).join("")}</select></div>`;
  modal("Match your columns", "Check the guessed columns, then review every row before saving.", `<div class="form-grid">${select("Date", "date")}${select("Description", "description")}${select("Amount", "amount")}${select("Money out / debit", "debit")}${select("Money in / credit", "credit")}</div><div class="table-wrap" style="margin-top:16px"><table class="data-table"><tbody>${d.sample.slice(0, 5).map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="modal-actions"><button class="button ghost" data-close-modal>Cancel</button><button class="button" id="review-import">Review rows</button></div>`, () => { $("#review-import").onclick = async () => { d.mapping = Object.fromEntries($$('[data-map]').map(node => [node.dataset.map, Number(node.value)])); try { d.checked = (await post("/api/import/check", { mapping: d.mapping, rows: d.rows })).rows; closeModal(); showImportReview(); } catch (error) { toast(error.message); } }; });
}
function importRowValue(row, key) { const idx = Number(state.importDraft.mapping[key] ?? -1); return idx >= 0 ? row[idx] || "" : ""; }
function showImportReview() {
  const d = state.importDraft;
  let rowsHtml = d.rows.map((row, i) => {
    const desc = importRowValue(row, "description");
    const positive = d.checked?.[i]?.cents > 0;
    const suggestion = d.checked?.[i] || {};
    const choices = positive ? `<select data-person-row="${i}">${state.data.people.map(name => `<option ${name === suggestion.suggested_person ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}<option ${!suggestion.suggested_person ? "selected" : ""}>Imported income</option></select>` : `<select data-category-row="${i}">${state.data.categories.map(name => `<option ${name === suggestion.suggested_category || (!suggestion.suggested_category && name === "Other") ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select>`;
    const cashCandidate = /atm|cash withdrawal|cash wd|withdrawal/i.test(desc);
    return `<tr><td><input type="checkbox" data-include-row="${i}" ${suggestion.duplicate ? "" : "checked"}></td><td>${escapeHtml(suggestion.date || importRowValue(row, "date"))}</td><td>${escapeHtml(desc)}${suggestion.duplicate ? `<div class="field-error">Already recorded?</div>` : ""}</td><td>${escapeHtml(importRowValue(row, "amount") || importRowValue(row, "credit") || importRowValue(row, "debit"))}</td><td>${choices}</td><td>${cashCandidate ? `<label><input type="checkbox" data-cash-row="${i}"> Move to Cash in hand</label>` : ""}</td></tr>`;
  }).join("");
  modal("Review import", `${d.rows.length} rows found. Untick anything you don't want to add.`, `<div class="table-wrap"><table class="data-table"><thead><tr><th>Add</th><th>Date</th><th>Description</th><th>Amount</th><th>Person / category</th><th>Cash</th></tr></thead><tbody>${rowsHtml}</tbody></table></div><div class="modal-actions"><button class="button ghost" id="back-import">Back</button><button class="button" id="save-import">Save selected rows</button></div>`, () => {
    $("#back-import").onclick = () => { closeModal(); showImportMapping(); };
    $("#save-import").onclick = async () => {
      const selected = d.rows.map((_, i) => ({ include: $(`[data-include-row="${i}"]`).checked, person: $(`[data-person-row="${i}"]`)?.value || "Imported income", category: $(`[data-category-row="${i}"]`)?.value || "Other", cash: $(`[data-cash-row="${i}"]`)?.checked || false }));
      try { const result = await post("/api/import/save", { rows: d.rows, headers: d.headers, mapping: d.mapping, selected }); closeModal(); toast(`${result.added} rows added · ${result.skipped} skipped · ${result.duplicates} duplicates`); await refresh(); if (result.suggested) openReminder({ import_id: result.import_id, amount: result.total_in, suggested: result.suggested }); }
      catch (error) { toast(error.message); }
    };
  });
}
async function delegatedClick(event) {
  const target = event.target.closest("button,a"); if (!target) return;
  if (target.tagName === "A" && target.getAttribute("href")?.startsWith("/api/")) {
    event.preventDefault();
    try { await window.moneyStore.download(target.pathname + target.search); }
    catch (error) { toast(error.message); }
    return;
  }
  if (target.dataset.action === "retry") { refresh().catch(showOffline); return; }
  if (!state.data && !target.closest("#modal-root")) { toast("Can't reach your computer yet. Check Wi-Fi and that Money Tracker is running."); return; }
  if (target.dataset.view) { navigate(target.dataset.view); return; }
  const action = target.dataset.action;
  if (action === "income") openIncome();
  else if (action === "expense") openExpense();
  else if (action === "import") beginImport();
  else if (action === "add-menu") modal("Add an entry", "What would you like to record?", `<div class="actions"><button class="button block" data-action="income">+ Money in</button><button class="button secondary block" data-action="expense">− Money out</button></div>`, () => {});
  else if (action === "new-goal") openGoal();
  else if (action === "save-settings") saveSettings();
  else if (action === "install-pwa" && installPrompt) {
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") toast("Money Tracker added to your home screen.");
    installPrompt = null;
    await renderSettings();
  }
  else if (action === "restore-backup") $("#device-backup-file")?.click();
  else if (action === "save-openings") {
    const values = Object.fromEntries(new FormData($("#opening-form")));
    try { await post("/api/settings", { savings_pct: $("#savings-pct").value, dark_mode: state.data.dark_mode, opening: values }); toast("Starting balances saved."); await refresh(); }
    catch (error) { toast(error.message); }
  }
  else if (action === "clear-owed") openClearOwed();
  else if (target.dataset.withdraw) openWithdraw(Number(target.dataset.withdraw));
  else if (target.dataset.goalAdd) openGoalAdd(Number(target.dataset.goalAdd));
  else if (target.dataset.period) { state.reportPeriod = target.dataset.period; await renderReports(); }
  else if (target.dataset.date) { state.reportDate = target.dataset.date; await renderReports(); }
  else if (target.dataset.theme) { try { await post("/api/settings", { savings_pct: $("#savings-pct")?.value || state.data.savings_pct, dark_mode: target.dataset.theme, color_palette: state.data.color_palette }); await refresh(); } catch (error) { toast(error.message); } }
  else if (target.dataset.palette) { try { await post("/api/settings", { savings_pct: $("#savings-pct")?.value || state.data.savings_pct, dark_mode: state.data.dark_mode, color_palette: target.dataset.palette }); await refresh(); } catch (error) { toast(error.message); } }
  else if (target.dataset.addList) { const kind = target.dataset.addList, input = $(`#new-${kind === "people" ? "person" : "category"}`); try { await post("/api/list", { kind, action: "add", name: input.value }); await refresh(); } catch (error) { toast(error.message); } }
  else if (target.dataset.removeList) { try { await post("/api/list", { kind: target.dataset.removeList, action: "remove", name: target.dataset.name }); await refresh(); } catch (error) { toast(error.message); } }
  else if (target.dataset.renameList) {
    const name = prompt("Rename this item:", target.dataset.name);
    if (name?.trim()) { try { await post("/api/list", { kind: target.dataset.renameList, action: "rename", name: target.dataset.name, new_name: name.trim() }); await refresh(); } catch (error) { toast(error.message); } }
  }
  else if (target.dataset.editEntry) openEditEntry(Number(target.dataset.editEntry));
  else if (target.dataset.deleteEntry) { if (confirm("Are you sure you want to delete this entry?")) { try { await api(`/api/entries/${target.dataset.deleteEntry}`, { method: "DELETE" }); toast("Entry deleted."); await refresh(); await renderHistory(); } catch (error) { toast(error.message); } } }
  else if (target.dataset.undoImport) { if (confirm("Undo this import and remove all its entries?")) { try { await post("/api/import/undo", { import_id: target.dataset.undoImport }); toast("Import undone."); await refresh(); await renderHistory(); } catch (error) { toast(error.message); } } }
}
document.addEventListener("click", event => { delegatedClick(event).catch(showError); });
document.addEventListener("change", event => {
  if (event.target.matches("[data-filter]")) renderHistory();
  if (event.target.id === "device-backup-file" && event.target.files?.[0]) {
    const file = event.target.files[0];
    if (confirm("Restore this backup on this device? It replaces this device's current records.")) {
      window.moneyStore.restore(file).then(async () => { toast("Backup restored on this device."); await refresh(); navigate("settings"); }).catch(showError);
    }
  }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (state.data?.dark_mode === "system") applyTheme("system"); });
window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; if (state.view === "settings") renderSettings(); });
window.addEventListener("appinstalled", () => { installPrompt = null; toast("Money Tracker installed."); if (state.view === "settings") renderSettings(); });
function showOffline() {
  $("#view").innerHTML = `<article class="card empty"><strong>Can't reach Money Tracker</strong>Make sure your computer is on, the app is running, and your phone is on the same Wi-Fi.<div class="actions" style="justify-content:center"><button class="button" data-action="retry">Try again</button></div></article>`;
}
window.addEventListener("online", () => { if (!state.data) refresh().catch(showOffline); });
refresh().catch(showOffline);