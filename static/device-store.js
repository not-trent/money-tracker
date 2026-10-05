(() => {
  const DB_NAME = "money-tracker-device";
  const STORE_NAME = "state";
  const STATE_KEY = "ledger";
  const CATEGORIES = ["Food", "Transport", "Rent", "Airtime and data", "Electricity", "Clothing", "Family", "Bank and ATM fees", "Other"];
  let dbPromise;
  let writeQueue = Promise.resolve();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function freshState() {
    return {
      settings: { setup_done: false, savings_pct: 20, dark_mode: "system", opening: { bank: 0, cash: 0, waiting: 0, savings: 0 }, opening_owed: 0, csv_mapping: {} },
      people: [], categories: [...CATEGORIES], goals: [], entries: [], rules: [], nextId: 1, nextGoalId: 1
    };
  }

  async function readState() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result?.value || freshState());
      request.onerror = () => reject(request.error);
    });
  }

  async function saveState(state) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key: STATE_KEY, value: state });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function mutate(change) {
    const task = writeQueue.then(async () => {
      const state = await readState();
      const result = await change(state);
      await saveState(state);
      return result;
    });
    writeQueue = task.catch(() => {});
    return task;
  }

  function cents(value) {
    const amount = Number(String(value ?? "").replace(/[, ]/g, ""));
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter a valid amount of zero or more.");
    return Math.round(amount * 100);
  }

  function validDate(value) {
    const parsed = new Date(`${value}T00:00:00`);
    if (!value || Number.isNaN(parsed.valueOf())) throw new Error("Choose a valid date.");
    const latest = new Date();
    latest.setDate(latest.getDate() + 1);
    latest.setHours(23, 59, 59, 999);
    if (parsed > latest) throw new Error("The date cannot be more than one day in the future.");
    return value;
  }

  function addEntry(state, type, amount, date, fields = {}) {
    const entry = { id: state.nextId++, entry_type: type, amount, entry_date: date, person: "", category: "", arrival: "", note: "", pocket: "", linked_id: null, import_id: "", goal_id: null, ...fields };
    state.entries.push(entry);
    return entry;
  }

  function balance(state) {
    const result = { ...state.settings.opening };
    let owed = state.settings.opening_owed || 0;
    for (const entry of state.entries) {
      const amount = entry.amount;
      if (entry.entry_type === "INCOME") result[{ bank: "bank", cash: "cash", cashsend: "waiting" }[entry.arrival]] += amount;
      else if (entry.entry_type === "EXPENSE" && ["bank", "cash"].includes(entry.pocket)) result[entry.pocket] -= amount;
      else if (entry.entry_type === "WITHDRAWAL") { result.waiting -= amount; result.cash += amount - Number(entry.category || 0); }
      else if (entry.entry_type === "BANK_CASH") { result.bank -= amount; result.cash += amount; }
      else if (entry.entry_type === "SAVE") { result[entry.pocket] -= amount; result.savings += amount; }
      else if (entry.entry_type === "OWED") owed += amount;
      else if (entry.entry_type === "OWED_CLEAR") owed -= amount;
    }
    result.owed = owed;
    return result;
  }

  function periodBounds(period, anchor) {
    const start = new Date(`${anchor}T12:00:00`);
    if (period === "week") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return [dateString(start), dateString(end)];
    }
    if (period === "year") return [`${start.getFullYear()}-01-01`, `${start.getFullYear()}-12-31`];
    const first = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    return [dateString(first), dateString(last)];
  }

  function dateString(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

  function report(state, period, anchor) {
    const [start, end] = periodBounds(period, anchor);
    const rows = state.entries.filter(entry => entry.entry_date >= start && entry.entry_date <= end);
    const income = rows.filter(entry => entry.entry_type === "INCOME");
    const expenses = rows.filter(entry => entry.entry_type === "EXPENSE");
    const savedRows = rows.filter(entry => entry.entry_type === "SAVE");
    const sum = items => items.reduce((total, item) => total + item.amount, 0);
    const groups = (items, field) => items.reduce((result, item) => { const key = item[field] || "Unknown"; result[key] = (result[key] || 0) + item.amount; return result; }, {});
    const result = { period, start, end, in: sum(income), out: sum(expenses), saved: sum(savedRows), left: sum(income) - sum(expenses) - sum(savedRows), people: groups(income, "person"), arrivals: groups(income, "arrival"), categories: groups(expenses, "category") };
    if (period === "year") {
      result.months = Array.from({ length: 12 }, (_, month) => {
        const first = new Date(Number(anchor.slice(0, 4)), month, 1);
        const last = new Date(Number(anchor.slice(0, 4)), month + 1, 0);
        const monthRows = state.entries.filter(entry => entry.entry_date >= dateString(first) && entry.entry_date <= dateString(last));
        return { month: first.toLocaleDateString("en-US", { month: "short" }), in: sum(monthRows.filter(entry => entry.entry_type === "INCOME")), out: sum(monthRows.filter(entry => entry.entry_type === "EXPENSE")), saved: sum(monthRows.filter(entry => entry.entry_type === "SAVE")) };
      });
      result.save_rate = result.in ? Math.round(result.saved * 1000 / result.in) / 10 : 0;
    }
    return result;
  }

  function csvDate(raw) {
    const value = String(raw || "").trim();
    for (const format of [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/]) {
      const match = value.match(format);
      if (match) {
        const parts = format === format && format.toString().startsWith("/^(") && match[1].length === 4 ? [match[1], match[2], match[3]] : [match[3], match[2], match[1]];
        const parsed = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return Number.isNaN(parsed.valueOf()) ? "" : dateString(parsed);
      }
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? "" : dateString(parsed);
  }

  function csvAmount(raw) {
    let text = String(raw || "").trim().replace(/R/gi, "").replace(/\s/g, "");
    const negative = text.startsWith("-") || /dr$/i.test(text);
    text = text.replace(/(dr|cr)$/i, "").replace(/[+-]/g, "");
    if (text.includes(",") && text.includes(".")) text = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    else if (text.includes(",")) text = text.replace(",", ".");
    const result = Number(text);
    return Number.isFinite(result) ? Math.round(result * 100) * (negative ? -1 : 1) : 0;
  }

  function parseCsv(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
    let headerIndex = -1;
    for (let index = 0; index < Math.min(lines.length, 20); index++) {
      if (/date/i.test(lines[index]) && /(description|details|amount|debit|credit|withdrawal|deposit|value)/i.test(lines[index])) { headerIndex = index; break; }
    }
    if (headerIndex < 0) throw new Error("I couldn't find the CSV column headings.");
    const sample = lines[headerIndex];
    const delimiter = [",", ";", "\t", "|"].sort((a, b) => sample.split(b).length - sample.split(a).length)[0];
    const parseLine = line => {
      const cells = []; let value = "", quoted = false;
      for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === '"' && line[index + 1] === '"' && quoted) { value += '"'; index++; }
        else if (char === '"') quoted = !quoted;
        else if (char === delimiter && !quoted) { cells.push(value.trim()); value = ""; }
        else value += char;
      }
      cells.push(value.trim());
      return cells;
    };
    const headers = parseLine(lines[headerIndex]);
    const rows = lines.slice(headerIndex + 1).map(parseLine);
    const lower = headers.map(item => item.toLowerCase());
    const guess = words => lower.findIndex(name => words.some(word => name.includes(word)));
    let mapping = { date: guess(["date"]), description: guess(["description", "details", "narration", "reference", "payee"]), amount: guess(["amount", "value"]), debit: guess(["debit", "withdrawal", "money out"]), credit: guess(["credit", "deposit", "money in"]) };
    return { headers, rows, mapping };
  }

  function valueAt(row, mapping, key) { const index = Number(mapping[key] ?? -1); return index >= 0 ? String(row[index] || "").trim() : ""; }

  async function checkedRows(state, mapping, rows) {
    const known = new Set(state.entries.filter(entry => (entry.entry_type === "INCOME" && entry.arrival === "bank") || (entry.entry_type === "EXPENSE" && entry.pocket === "bank") || entry.entry_type === "BANK_CASH").map(entry => `${entry.entry_date}:${entry.amount}`));
    const seen = new Set();
    const rules = [...state.rules].sort((a, b) => b.rule_text.length - a.rule_text.length);
    return rows.map(row => {
      const date = csvDate(valueAt(row, mapping, "date"));
      const centsValue = Number(mapping.debit) >= 0 || Number(mapping.credit) >= 0 ? (csvAmount(valueAt(row, mapping, "credit")) || -Math.abs(csvAmount(valueAt(row, mapping, "debit")))) : csvAmount(valueAt(row, mapping, "amount"));
      const signature = `${date}:${Math.abs(centsValue)}`;
      const duplicate = !!date && !!centsValue && (known.has(signature) || seen.has(signature));
      if (date && centsValue) seen.add(signature);
      const description = valueAt(row, mapping, "description");
      const rule = rules.find(item => description.toUpperCase().includes(item.rule_text.toUpperCase()));
      return { date, cents: centsValue, duplicate, description, suggested_person: rule?.person || "", suggested_category: rule?.category || "" };
    });
  }

  async function handle(path, options = {}) {
    const url = new URL(path, location.origin);
    const method = options.method || "GET";
    const payload = options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : {};
    if (url.pathname === "/api/initialize") {
      const state = await readState();
      const b = balance(state);
      const waiting = state.entries.filter(entry => entry.entry_type === "INCOME" && entry.arrival === "cashsend" && !state.entries.some(item => item.entry_type === "WITHDRAWAL" && item.linked_id === entry.id)).map(entry => ({ ...entry, remaining: Math.max(0, entry.amount - state.entries.filter(item => item.entry_type === "SAVE" && item.linked_id === entry.id).reduce((sum, item) => sum + item.amount, 0)) }));
      return { setup_done: state.settings.setup_done, balances: b, savings_pct: state.settings.savings_pct, dark_mode: state.settings.dark_mode, people: state.people, categories: state.categories, entries: [...state.entries].sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.id - a.id).slice(0, 8), goals: state.goals, waiting };
    }
    if (url.pathname === "/api/home-summary") {
      const state = await readState(); const b = balance(state); const now = new Date(); const today = dateString(now);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const days = Math.max(1, Math.round((monthEnd - new Date(`${today}T00:00:00`)) / 86400000) + 1);
      const week = report(state, "week", today); const month = report(state, "month", today);
      const firstPrev = new Date(now.getFullYear(), now.getMonth() - 3, 1); const lastPrev = new Date(now.getFullYear(), now.getMonth(), 0);
      const prev = state.entries.filter(entry => entry.entry_date >= dateString(firstPrev) && entry.entry_date <= dateString(lastPrev));
      const sumType = type => prev.filter(entry => entry.entry_type === type).reduce((sum, entry) => sum + entry.amount, 0) / 3;
      const available = Math.max(0, b.bank + b.cash - b.owed);
      return { balances: b, today: Math.min(Math.floor(available / days), available), week: Math.min(Math.floor(available / days) * Math.min(7, days), available), month: available, avg_in: Math.floor(sumType("INCOME")), avg_out: Math.floor(sumType("EXPENSE")), week_in: week.in, week_out: week.out, week_saved: week.saved, month_in: month.in, month_out: month.out, month_saved: month.saved };
    }
    if (url.pathname === "/api/setup" && method === "POST") return mutate(state => { for (const key of ["bank", "cash", "waiting", "savings"]) state.settings.opening[key] = cents(payload[key] || 0); state.settings.setup_done = true; return { ok: true }; });
    if (url.pathname === "/api/income" && method === "POST") return mutate(state => {
      const amount = cents(payload.amount); const date = validDate(payload.date || dateString(new Date())); const arrival = payload.arrival || "bank"; const person = String(payload.person || "").trim();
      if (!person || !["bank", "cash", "cashsend"].includes(arrival)) throw new Error("Enter who paid you and how the money arrived.");
      if (!state.people.some(item => item.toLowerCase() === person.toLowerCase())) state.people.push(person);
      const entry = addEntry(state, "INCOME", amount, date, { arrival, person, note: String(payload.note || "") });
      return { id: entry.id, amount, suggested: Math.round(amount * Number(state.settings.savings_pct) / 100), person, arrival };
    });
    if (url.pathname === "/api/reminder" && method === "POST") return mutate(state => {
      const parent = state.entries.find(entry => entry.id === Number(payload.income_id) && entry.entry_type === "INCOME");
      if (!parent) throw new Error("That income entry could not be found.");
      const amount = cents(payload.amount || 0); const action = payload.action;
      if (action === "done") { const pocket = { bank: "bank", cash: "cash", cashsend: "waiting" }[parent.arrival]; if (amount > balance(state)[pocket]) throw new Error("There is not enough money in that pocket to move this amount."); addEntry(state, "SAVE", amount, parent.entry_date, { pocket, note: "Savings from income", linked_id: parent.id }); }
      else if (action === "later") addEntry(state, "OWED", amount, parent.entry_date, { linked_id: parent.id });
      else if (action !== "skip") throw new Error("Choose Done, Later, or Skip.");
      return { ok: true };
    });
    if (url.pathname === "/api/withdraw" && method === "POST") return mutate(state => {
      const parent = state.entries.find(entry => entry.id === Number(payload.income_id) && entry.entry_type === "INCOME" && entry.arrival === "cashsend");
      if (!parent || state.entries.some(item => item.entry_type === "WITHDRAWAL" && item.linked_id === parent.id)) throw new Error("Cash send not found or already withdrawn.");
      const fee = cents(payload.fee || 0); const date = validDate(payload.date || dateString(new Date()));
      const saved = state.entries.filter(item => item.entry_type === "SAVE" && item.linked_id === parent.id).reduce((sum, item) => sum + item.amount, 0);
      const withdrawal = addEntry(state, "WITHDRAWAL", Math.max(0, parent.amount - saved), date, { category: String(fee), linked_id: parent.id, note: "Cash send withdrawal" });
      if (fee) addEntry(state, "EXPENSE", fee, date, { category: "Bank and ATM fees", pocket: "memo", note: "ATM fee", linked_id: withdrawal.id });
      return { ok: true };
    });
    if (url.pathname === "/api/expense" && method === "POST") return mutate(state => {
      const amount = cents(payload.amount); const date = validDate(payload.date || dateString(new Date())); const pocket = payload.pocket || "bank";
      if (!["bank", "cash"].includes(pocket)) throw new Error("Choose Bank or Cash in hand.");
      addEntry(state, "EXPENSE", amount, date, { category: String(payload.category || "Other"), pocket, note: String(payload.note || "") });
      return { ok: true };
    });
    if (url.pathname === "/api/settings" && method === "GET") { const state = await readState(); return { savings_pct: state.settings.savings_pct, dark_mode: state.settings.dark_mode, opening: state.settings.opening, owed: state.settings.opening_owed }; }
    if (url.pathname === "/api/settings" && method === "POST") return mutate(state => {
      const pct = Number(payload.savings_pct ?? state.settings.savings_pct);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error("Savings percentage must be a whole number from 0 to 100.");
      state.settings.savings_pct = pct; state.settings.dark_mode = ["system", "light", "dark"].includes(payload.dark_mode) ? payload.dark_mode : state.settings.dark_mode;
      if (payload.opening) for (const key of ["bank", "cash", "waiting", "savings"]) state.settings.opening[key] = cents(payload.opening[key] || 0);
      return { ok: true };
    });
    if (url.pathname === "/api/list" && method === "POST") return mutate(state => {
      const list = payload.kind === "people" ? state.people : payload.kind === "categories" ? state.categories : null;
      if (!list) throw new Error("Unknown list.");
      if (payload.action === "add") { const name = String(payload.name || "").trim(); if (!name) throw new Error("A name is required."); if (list.some(item => item.toLowerCase() === name.toLowerCase())) throw new Error("That name is already on the list."); list.push(name); }
      else if (payload.action === "rename") {
        const next = String(payload.new_name || "").trim(); if (!next) throw new Error("A name is required.");
        const field = payload.kind === "people" ? "person" : "category";
        for (const entry of state.entries) if (entry[field] === payload.name) entry[field] = next;
        for (const rule of state.rules) if (rule[field] === payload.name) rule[field] = next;
        const index = list.indexOf(payload.name); if (index >= 0) list[index] = next;
      } else if (payload.action === "remove") { const index = list.indexOf(payload.name); if (index >= 0) list.splice(index, 1); }
      return { ok: true };
    });
    if (url.pathname === "/api/history" && method === "GET") {
      const state = await readState(); let rows = [...state.entries];
      for (const [param, field] of [["type", "entry_type"], ["person", "person"], ["category", "category"]]) if (url.searchParams.has(param)) rows = rows.filter(entry => entry[field] === url.searchParams.get(param));
      if (url.searchParams.has("from")) rows = rows.filter(entry => entry.entry_date >= url.searchParams.get("from"));
      if (url.searchParams.has("to")) rows = rows.filter(entry => entry.entry_date <= url.searchParams.get("to"));
      const imports = [...new Set(rows.map(entry => entry.import_id).filter(Boolean))];
      return { entries: rows.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.id - a.id).slice(0, 500), imports };
    }
    const entryMatch = url.pathname.match(/^\/api\/entries\/(\d+)$/);
    if (entryMatch && method === "PUT") return mutate(state => {
      const entry = state.entries.find(item => item.id === Number(entryMatch[1])); if (!entry) throw new Error("Entry not found.");
      entry.amount = cents(payload.amount); entry.entry_date = validDate(payload.date); entry.person = payload.person ?? entry.person; entry.category = payload.category ?? entry.category; entry.note = payload.note ?? entry.note; entry.pocket = payload.pocket ?? entry.pocket;
      return { ok: true };
    });
    if (entryMatch && method === "DELETE") return mutate(state => { const id = Number(entryMatch[1]); state.entries = state.entries.filter(entry => entry.id !== id && entry.linked_id !== id); return { ok: true }; });
    if (url.pathname === "/api/import/undo" && method === "POST") return mutate(state => { const id = payload.import_id; state.entries = state.entries.filter(entry => entry.import_id !== id); return { ok: true }; });
    if (url.pathname === "/api/owed/clear" && method === "POST") return mutate(state => {
      const amount = cents(payload.amount); const current = balance(state); const pocket = payload.pocket || "bank";
      if (amount > current.owed) throw new Error("That amount is more than the savings still owed."); if (amount > current[pocket]) throw new Error("There is not enough money in that pocket.");
      addEntry(state, "SAVE", amount, dateString(new Date()), { pocket, note: "Savings owed paid" }); addEntry(state, "OWED_CLEAR", amount, dateString(new Date()), { note: "Savings owed cleared" }); return { ok: true };
    });
    if (url.pathname === "/api/import/preview" && method === "POST") {
      const file = payload.get("file"); if (!file) throw new Error("Choose a CSV file first.");
      const result = parseCsv(await file.text()); const state = await readState();
      if (state.settings.csv_mapping?.headers?.join("\u0000") === result.headers.join("\u0000")) result.mapping = { ...result.mapping, ...state.settings.csv_mapping.mapping };
      return { ...result, sample: result.rows.slice(0, 5) };
    }
    if (url.pathname === "/api/import/check" && method === "POST") { const state = await readState(); return { rows: await checkedRows(state, payload.mapping, payload.rows) }; }
    if (url.pathname === "/api/import/save" && method === "POST") return mutate(async state => {
      const importId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      state.settings.csv_mapping = { headers: payload.headers || [], mapping: payload.mapping };
      let added = 0, skipped = 0, duplicates = 0, totalIn = 0;
      const checked = await checkedRows(state, payload.mapping, payload.rows);
      for (let index = 0; index < payload.rows.length; index++) {
        const selected = payload.selected[index]; const row = payload.rows[index]; const parsed = checked[index];
        if (!selected?.include) { skipped++; continue; }
        if (!parsed.date || !parsed.cents) { skipped++; continue; }
        if (parsed.duplicate) { duplicates++; continue; }
        if (selected.cash) addEntry(state, "BANK_CASH", Math.abs(parsed.cents), parsed.date, { note: parsed.description, import_id: importId });
        else if (parsed.cents > 0) {
          const person = selected.person || "Imported income";
          if (!state.people.includes(person)) state.people.push(person);
          addEntry(state, "INCOME", parsed.cents, parsed.date, { arrival: "bank", person, note: parsed.description, import_id: importId });
          totalIn += parsed.cents;
          if (parsed.description) { const existing = state.rules.find(rule => rule.rule_text.toLowerCase() === parsed.description.toLowerCase()); if (existing) existing.person = person; else state.rules.push({ rule_text: parsed.description, person, category: "" }); }
        } else {
          const category = selected.category || "Other";
          addEntry(state, "EXPENSE", Math.abs(parsed.cents), parsed.date, { category, pocket: "bank", note: parsed.description, import_id: importId });
          if (parsed.description) { const existing = state.rules.find(rule => rule.rule_text.toLowerCase() === parsed.description.toLowerCase()); if (existing) existing.category = category; else state.rules.push({ rule_text: parsed.description, person: "", category }); }
        }
        added++;
      }
      return { import_id: importId, added, skipped, duplicates, total_in: totalIn, suggested: Math.round(totalIn * state.settings.savings_pct / 100) };
    });
    if (url.pathname === "/api/import/reminder" && method === "POST") return mutate(state => {
      const amount = cents(payload.amount || 0); const importId = payload.import_id;
      if (!state.entries.some(entry => entry.import_id === importId && entry.entry_type === "INCOME")) throw new Error("That import could not be found.");
      if (payload.action === "done") { if (amount > balance(state).bank) throw new Error("There is not enough in Bank to move this amount."); addEntry(state, "SAVE", amount, dateString(new Date()), { pocket: "bank", note: "Savings from bank import", import_id: importId }); }
      else if (payload.action === "later") addEntry(state, "OWED", amount, dateString(new Date()), { note: "Savings from bank import", import_id: importId });
      else if (payload.action !== "skip") throw new Error("Choose Done, Later, or Skip.");
      return { ok: true };
    });
    if (url.pathname === "/api/goals" && method === "GET") {
      const state = await readState();
      return { goals: state.goals.map(goal => { const saved = state.entries.filter(entry => entry.entry_type === "GOAL" && entry.goal_id === goal.id).reduce((sum, entry) => sum + entry.amount, 0); return { ...goal, saved, finished: Number(saved >= goal.target) }; }) };
    }
    if (url.pathname === "/api/goals" && method === "POST") return mutate(state => {
      const name = String(payload.name || "").trim(); const target = cents(payload.target);
      if (!name || !target) throw new Error("Enter a name and a target above zero.");
      const id = state.nextGoalId++; state.goals.push({ id, name, target, target_date: payload.target_date || null, finished: 0 }); return { id };
    });
    const goalMatch = url.pathname.match(/^\/api\/goals\/(\d+)\/add$/);
    if (goalMatch && method === "POST") return mutate(state => {
      const goal = state.goals.find(item => item.id === Number(goalMatch[1])); if (!goal) throw new Error("Goal not found.");
      const amount = cents(payload.amount); const allocated = state.entries.filter(entry => entry.entry_type === "GOAL").reduce((sum, entry) => sum + entry.amount, 0);
      if (amount > balance(state).savings - allocated) throw new Error("There is not enough in Savings.");
      addEntry(state, "GOAL", amount, dateString(new Date()), { goal_id: goal.id, note: "Added to goal" });
      return { ok: true };
    });
    if (url.pathname === "/api/reports" && method === "GET") { const state = await readState(); const period = ["week", "month", "year"].includes(url.searchParams.get("period")) ? url.searchParams.get("period") : "month"; return report(state, period, url.searchParams.get("date") || dateString(new Date())); }
    if (url.pathname === "/api/export.csv" && method === "GET") return { download: "csv", text: csvExport(await readState(), url.searchParams.get("period") || "month", url.searchParams.get("date") || dateString(new Date())) };
    if (url.pathname === "/api/backup" && method === "GET") return { download: "json", text: JSON.stringify({ format: "money-tracker-device-backup-v1", state: await readState() }, null, 2) };
    if (url.pathname === "/api/backup/restore" && method === "POST") return mutate(state => { const backup = payload.state || payload; if (!backup.settings || !Array.isArray(backup.entries)) throw new Error("That file is not a Money Tracker backup."); Object.assign(state, backup); return { ok: true }; });
    throw new Error(`Unsupported local action: ${method} ${url.pathname}`);
  }

  function csvExport(state, period, date) {
    const [start, end] = periodBounds(period, date);
    const rows = state.entries.filter(entry => entry.entry_date >= start && entry.entry_date <= end);
    const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return ["Date,Type,Amount (R),Person,Category,Arrival,Pocket,Note", ...rows.map(entry => [entry.entry_date, entry.entry_type, (entry.amount / 100).toFixed(2), entry.person, entry.category, entry.arrival, entry.pocket, entry.note].map(quote).join(","))].join("\r\n");
  }

  function download(kind, text) {
    const blob = new Blob([text], { type: kind === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = kind === "csv" ? "money-tracker.csv" : "money-tracker-backup.json";
    anchor.click(); URL.revokeObjectURL(url);
  }

  window.moneyStore = {
    api: handle,
    async download(path) { const result = await handle(path); download(result.download, result.text); },
    async restore(file) { const backup = JSON.parse(await file.text()); return handle("/api/backup/restore", { method: "POST", body: JSON.stringify(backup) }); }
  };
})();