const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const SEMESTERS = ["SEM1", "SEM2", "SUM"];
const START_HOUR = 9;
const END_HOUR = 18;
const STORAGE_KEY = "dundee-timetable-selected-modules";
const DEFAULT_PREFIXES = ["AC", "CS", "MA"];

const state = {
  modules: [],
  classes: [],
  selected: new Set(),
  clashes: new Set(),
  clashGroups: [],
  search: ""
};

// Held only in memory between the two fetch steps (module discovery, then the
// actual scrape of the modules the user picked) so the password isn't asked
// for twice. Cleared as soon as either step finishes or is cancelled.
let pendingAuth = null;
let discoveredModules = [];
let selectedPrefixes = new Set();

const elements = {
  loadDundeeButton: document.querySelector("#loadDundeeButton"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadInput: document.querySelector("#uploadInput"),
  selectedCount: document.querySelector("#selectedCount"),
  classCount: document.querySelector("#classCount"),
  clashCount: document.querySelector("#clashCount"),
  clashMetric: document.querySelector("#clashMetric"),
  dataStatus: document.querySelector("#dataStatus"),
  clashList: document.querySelector("#clashList"),
  semesterGroups: document.querySelector("#semesterGroups"),
  moduleList: document.querySelector("#moduleList"),
  moduleSearch: document.querySelector("#moduleSearch"),
  selectAllButton: document.querySelector("#selectAllButton"),
  clearButton: document.querySelector("#clearButton"),
  dundeeModal: document.querySelector("#dundeeModal"),
  dundeeModalError: document.querySelector("#dundeeModalError"),
  dundeeLoginForm: document.querySelector("#dundeeLoginForm"),
  closeDundeeModal: document.querySelector("#closeDundeeModal"),
  cancelDundeeLogin: document.querySelector("#cancelDundeeLogin"),
  dundeeUsername: document.querySelector("#dundeeUsername"),
  dundeePassword: document.querySelector("#dundeePassword"),
  dundeeUrl: document.querySelector("#dundeeUrl"),
  prefixModal: document.querySelector("#prefixModal"),
  prefixModalError: document.querySelector("#prefixModalError"),
  prefixForm: document.querySelector("#prefixForm"),
  prefixSummary: document.querySelector("#prefixSummary"),
  prefixList: document.querySelector("#prefixList"),
  prefixAllButton: document.querySelector("#prefixAllButton"),
  prefixNoneButton: document.querySelector("#prefixNoneButton"),
  prefixLimit: document.querySelector("#prefixLimit"),
  prefixDebug: document.querySelector("#prefixDebug"),
  closePrefixModal: document.querySelector("#closePrefixModal"),
  cancelPrefixModal: document.querySelector("#cancelPrefixModal")
};

function minutes(time) {
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function prefixOf(moduleCode) {
  const match = String(moduleCode || "").match(/^[A-Z]+/);
  return match ? match[0] : "OTHER";
}

function semesterOf(moduleCode) {
  const code = String(moduleCode || "").toUpperCase();
  if (/SEM.?1/.test(code)) return "SEM1";
  if (/SEM.?2/.test(code)) return "SEM2";
  if (/\bSUM/.test(code)) return "SUM";
  return "SEM1";
}

function moduleFor(id) {
  return state.modules.find((module) => module.id === id) || { code: "", name: "" };
}

function classCountFor(moduleId) {
  return state.classes.filter((event) => event.moduleId === moduleId).length;
}

function findClashes(events) {
  const clashIds = new Set();
  const groups = [];

  DAYS.forEach((day) => {
    const dayEvents = events
      .filter((event) => event.day === day)
      .slice()
      .sort((a, b) => minutes(a.start) - minutes(b.start));

    for (let index = 0; index < dayEvents.length; index += 1) {
      for (let next = index + 1; next < dayEvents.length; next += 1) {
        const a = dayEvents[index];
        const b = dayEvents[next];
        if (minutes(b.start) >= minutes(a.end)) break;
        clashIds.add(a.id);
        clashIds.add(b.id);
        groups.push([a, b]);
      }
    }
  });

  return { clashIds, groups };
}

function selectedEvents() {
  return state.classes.filter((event) => state.selected.has(event.moduleId));
}

function persistSelection() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.selected]));
}

function restoreSelection() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const ids = JSON.parse(raw);
    state.selected = new Set(ids.filter((id) => state.modules.some((module) => module.id === id)));
    return state.selected.size > 0;
  } catch {
    return false;
  }
}

function setData(data, status, options = {}) {
  // A fresh upload or fetch always fully replaces whatever was loaded before —
  // no merging with prior data, and (unless explicitly restoring, i.e. only on
  // the initial page load) no carrying over a previous session's selection.
  state.modules = Array.isArray(data.modules) ? data.modules : [];
  state.classes = Array.isArray(data.classes) ? data.classes : [];
  state.selected = new Set();
  state.search = "";
  elements.moduleSearch.value = "";

  const restored = options.restoreSelection !== false && restoreSelection();
  if (!restored) {
    state.modules.slice(0, 2).forEach((module) => state.selected.add(module.id));
  }

  elements.dataStatus.textContent = status;
  persistSelection();
  render();
}

function layoutEvents(events) {
  const byDay = new Map(DAYS.map((day) => [day, []]));
  events.forEach((event) => {
    if (byDay.has(event.day)) byDay.get(event.day).push(event);
  });

  byDay.forEach((dayEvents) => {
    dayEvents.sort((a, b) => minutes(a.start) - minutes(b.start));
    const active = [];
    dayEvents.forEach((event) => {
      for (let i = active.length - 1; i >= 0; i -= 1) {
        if (minutes(active[i].end) <= minutes(event.start)) active.splice(i, 1);
      }
      active.push(event);
      const overlapCount = active.length;
      active.forEach((activeEvent, column) => {
        activeEvent.layoutColumn = column;
        activeEvent.layoutColumns = Math.max(activeEvent.layoutColumns || 1, overlapCount);
      });
    });
  });
}

function timeLabelsHtml() {
  let html = "";
  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    html += `<div class="time-label">${String(hour).padStart(2, "0")}:00</div>`;
  }
  return html;
}

function renderSemesterBlock(label, events, clashIds) {
  const block = document.createElement("div");
  block.className = "semester-block";
  block.innerHTML = `<h3 class="semester-heading">${escapeHtml(label)}</h3>`;

  const frame = document.createElement("div");
  frame.className = "timetable-frame";

  const timeColumn = document.createElement("div");
  timeColumn.className = "time-column";
  timeColumn.innerHTML = timeLabelsHtml();
  frame.appendChild(timeColumn);

  const daysGrid = document.createElement("div");
  daysGrid.className = "days-grid";

  DAYS.forEach((day) => {
    const column = document.createElement("div");
    column.className = "day-column";
    column.innerHTML = `<div class="day-heading">${day}</div>`;

    const dayEvents = events.filter((event) => event.day === day);
    if (!dayEvents.length) {
      const empty = document.createElement("div");
      empty.className = "empty-day";
      empty.textContent = "No selected classes";
      column.appendChild(empty);
    }

    dayEvents.forEach((event) => {
      const start = minutes(event.start);
      const end = minutes(event.end);
      const top = 42 + ((start - START_HOUR * 60) / 60) * 76;
      const height = Math.max(42, ((end - start) / 60) * 76 - 6);
      const width = 100 / (event.layoutColumns || 1);
      const left = width * (event.layoutColumn || 0);
      const eventBlock = document.createElement("article");
      eventBlock.className = `event${clashIds.has(event.id) ? " is-clash" : ""}`;
      eventBlock.style.top = `${top}px`;
      eventBlock.style.height = `${height}px`;
      eventBlock.style.left = `calc(${left}% + 8px)`;
      eventBlock.style.right = `calc(${100 - left - width}% + 8px)`;
      eventBlock.title = `${event.moduleCode} ${event.start}-${event.end}`;
      eventBlock.innerHTML = `
        <span class="event-time">${escapeHtml(event.start)}-${escapeHtml(event.end)} · ${escapeHtml(event.moduleCode)}</span>
        <span class="event-title">${escapeHtml(event.title)}</span>
        <span class="event-detail">${escapeHtml([event.type, event.location, event.weeks && `Weeks ${event.weeks}`].filter(Boolean).join(" · "))}</span>
      `;
      column.appendChild(eventBlock);
    });

    daysGrid.appendChild(column);
  });

  frame.appendChild(daysGrid);
  block.appendChild(frame);
  return block;
}

function renderSchedule() {
  const events = selectedEvents().map((event) => ({ ...event }));
  const buckets = new Map(SEMESTERS.map((label) => [label, []]));
  events.forEach((event) => {
    buckets.get(semesterOf(event.moduleCode)).push(event);
  });

  const allClashIds = new Set();
  let allClashGroups = [];

  elements.semesterGroups.innerHTML = "";

  SEMESTERS.forEach((label) => {
    const bucketEvents = buckets.get(label);
    const { clashIds, groups } = findClashes(bucketEvents);
    clashIds.forEach((id) => allClashIds.add(id));
    allClashGroups = allClashGroups.concat(groups);
    layoutEvents(bucketEvents);
    elements.semesterGroups.appendChild(renderSemesterBlock(label, bucketEvents, clashIds));
  });

  state.clashes = allClashIds;
  state.clashGroups = allClashGroups;

  elements.selectedCount.textContent = state.selected.size;
  elements.classCount.textContent = events.length;
  elements.clashCount.textContent = allClashGroups.length;
  elements.clashMetric.classList.toggle("has-clashes", allClashGroups.length > 0);
  renderClashes(allClashGroups);
}

function renderClashes(groups) {
  if (!groups.length) {
    elements.clashList.hidden = true;
    elements.clashList.innerHTML = "";
    return;
  }

  const items = groups.slice(0, 6).map(([a, b]) => {
    return `<div>${escapeHtml(a.day)} ${escapeHtml(a.start)}-${escapeHtml(a.end)}: ${escapeHtml(a.moduleCode)} overlaps ${escapeHtml(b.moduleCode)}</div>`;
  });

  elements.clashList.hidden = false;
  elements.clashList.innerHTML = `<strong>Clashes found</strong>${items.join("")}`;
}

function renderModules() {
  const query = state.search.trim().toLowerCase();
  elements.moduleList.innerHTML = "";

  state.modules
    .filter((module) => {
      if (!query) return true;
      return `${module.code} ${module.name}`.toLowerCase().includes(query);
    })
    .forEach((module) => {
      const label = document.createElement("label");
      label.className = "module-item";
      const count = classCountFor(module.id);
      const moduleClasses = state.classes.filter((event) => event.moduleId === module.id);
      const clashes = moduleClasses.filter((event) => state.clashes.has(event.id)).length;
      label.innerHTML = `
        <input type="checkbox" ${state.selected.has(module.id) ? "checked" : ""} data-module-id="${escapeHtml(module.id)}" />
        <span>
          <span class="module-code">${escapeHtml(module.code)}</span>
          <span class="module-name">${escapeHtml(module.name || "Unnamed module")}</span>
          <span class="module-meta">
            <span class="pill">${count} ${count === 1 ? "class" : "classes"}</span>
            ${clashes ? `<span class="pill warning">${clashes} clash${clashes === 1 ? "" : "es"}</span>` : ""}
          </span>
        </span>
      `;
      elements.moduleList.appendChild(label);
    });
}

function render() {
  renderSchedule();
  renderModules();
}

async function loadSample() {
  const response = await fetch("sample-data.json");
  const data = await response.json();
  setData(data, "Sample timetable loaded");
}

async function handleUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;

  elements.dataStatus.textContent = `Importing ${file.name}...`;
  try {
    const text = await file.text();
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Import failed.");
    if (!data.classes.length) throw new Error("No classes were found in that file.");
    setData(data, `Imported ${data.classes.length} classes from ${file.name}`, { restoreSelection: false });
  } catch (error) {
    elements.dataStatus.textContent = error.message;
  }
}

function showModalError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function clearModalError(el) {
  el.hidden = true;
  el.textContent = "";
}

function openDundeeModal() {
  clearModalError(elements.dundeeModalError);
  elements.dundeeModal.hidden = false;
  elements.dundeeUsername.focus();
}

function closeDundeeModal() {
  elements.dundeeModal.hidden = true;
  elements.dundeePassword.value = "";
  clearModalError(elements.dundeeModalError);
}

let prefixCounts = new Map();

function updatePrefixSummary() {
  const moduleTotal = [...selectedPrefixes].reduce((total, prefix) => total + (prefixCounts.get(prefix) || 0), 0);
  elements.prefixSummary.textContent = `${moduleTotal} module${moduleTotal === 1 ? "" : "s"} selected across ${
    selectedPrefixes.size
  } prefix${selectedPrefixes.size === 1 ? "" : "es"}`;
}

function renderPrefixList() {
  const prefixes = [...prefixCounts.keys()].sort();
  elements.prefixList.innerHTML = "";
  prefixes.forEach((prefix) => {
    const count = prefixCounts.get(prefix);
    const item = document.createElement("div");
    item.className = "prefix-item";
    item.innerHTML = `
      <label>
        <input type="checkbox" data-prefix="${escapeHtml(prefix)}" ${selectedPrefixes.has(prefix) ? "checked" : ""} />
        ${escapeHtml(prefix)}
      </label>
      <span class="prefix-count">${count} module${count === 1 ? "" : "s"}</span>
    `;
    elements.prefixList.appendChild(item);
  });
  updatePrefixSummary();
}

function openPrefixModal() {
  prefixCounts = new Map();
  discoveredModules.forEach((module) => {
    const prefix = prefixOf(module.code);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  });
  selectedPrefixes = new Set([...prefixCounts.keys()].filter((prefix) => DEFAULT_PREFIXES.includes(prefix)));
  clearModalError(elements.prefixModalError);
  renderPrefixList();
  elements.prefixModal.hidden = false;
}

function closePrefixModal() {
  elements.prefixModal.hidden = true;
  clearModalError(elements.prefixModalError);
  pendingAuth = null;
  discoveredModules = [];
}

async function discoverModules(event) {
  event.preventDefault();
  clearModalError(elements.dundeeModalError);
  const submitButton = elements.dundeeLoginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Finding modules...";
  try {
    const username = elements.dundeeUsername.value.trim();
    const password = elements.dundeePassword.value;
    const url = elements.dundeeUrl.value.trim();
    const response = await fetch("/api/dundee-modules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not fetch the module list.");

    pendingAuth = { username, password, url };
    discoveredModules = data.modules || [];
    elements.dundeeModal.hidden = true;
    elements.dundeePassword.value = "";
    openPrefixModal();
  } catch (error) {
    showModalError(elements.dundeeModalError, error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Find Modules";
  }
}

async function fetchSelectedModules(event) {
  event.preventDefault();
  clearModalError(elements.prefixModalError);

  if (!selectedPrefixes.size) {
    showModalError(elements.prefixModalError, "Select at least one prefix.");
    return;
  }
  if (!pendingAuth) {
    showModalError(elements.prefixModalError, "Session expired — please log in again.");
    return;
  }

  const moduleCodes = discoveredModules
    .filter((module) => selectedPrefixes.has(prefixOf(module.code)))
    .map((module) => module.code);

  const submitButton = elements.prefixForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Fetching...";
  elements.dataStatus.textContent = `Fetching ${moduleCodes.length} Dundee modules. This can take a while...`;

  try {
    const response = await fetch("/api/scrape-dundee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: pendingAuth.username,
        password: pendingAuth.password,
        url: pendingAuth.url,
        moduleCodes,
        limit: elements.prefixLimit.value ? Number(elements.prefixLimit.value) : undefined,
        debug: elements.prefixDebug.checked
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Timetable fetch failed.");
    const failedText =
      data.failures && data.failures.length
        ? `; ${data.failures.length} modules failed (${data.failures[0].module}: ${data.failures[0].error})`
        : "";
    const debugText = data.debugFiles && data.debugFiles.length ? `; saved raw HTML to debug-output/` : "";
    setData(
      data,
      `Scraped ${data.classes.length} classes from ${data.scrapedModules} Dundee modules${failedText}${debugText}`,
      { restoreSelection: false }
    );
    elements.prefixModal.hidden = true;
    pendingAuth = null;
    discoveredModules = [];
  } catch (error) {
    showModalError(elements.prefixModalError, error.message);
    elements.dataStatus.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Fetch Selected Modules";
  }
}

elements.loadDundeeButton.addEventListener("click", openDundeeModal);
elements.uploadButton.addEventListener("click", () => elements.uploadInput.click());
elements.uploadInput.addEventListener("change", handleUpload);
elements.dundeeLoginForm.addEventListener("submit", discoverModules);
elements.closeDundeeModal.addEventListener("click", closeDundeeModal);
elements.cancelDundeeLogin.addEventListener("click", closeDundeeModal);
elements.dundeeModal.addEventListener("click", (event) => {
  if (event.target === elements.dundeeModal) closeDundeeModal();
});

elements.prefixForm.addEventListener("submit", fetchSelectedModules);
elements.closePrefixModal.addEventListener("click", closePrefixModal);
elements.cancelPrefixModal.addEventListener("click", closePrefixModal);
elements.prefixModal.addEventListener("click", (event) => {
  if (event.target === elements.prefixModal) closePrefixModal();
});
elements.prefixList.addEventListener("change", (event) => {
  const prefix = event.target.dataset.prefix;
  if (!prefix) return;
  if (event.target.checked) {
    selectedPrefixes.add(prefix);
  } else {
    selectedPrefixes.delete(prefix);
  }
  updatePrefixSummary();
});
elements.prefixAllButton.addEventListener("click", () => {
  selectedPrefixes = new Set(prefixCounts.keys());
  renderPrefixList();
});
elements.prefixNoneButton.addEventListener("click", () => {
  selectedPrefixes = new Set();
  renderPrefixList();
});

elements.moduleSearch.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderModules();
});

elements.moduleList.addEventListener("change", (event) => {
  const moduleId = event.target.dataset.moduleId;
  if (!moduleId) return;
  if (event.target.checked) {
    state.selected.add(moduleId);
  } else {
    state.selected.delete(moduleId);
  }
  persistSelection();
  render();
});

elements.selectAllButton.addEventListener("click", () => {
  state.modules.forEach((module) => state.selected.add(module.id));
  persistSelection();
  render();
});

elements.clearButton.addEventListener("click", () => {
  state.selected.clear();
  persistSelection();
  render();
});

loadSample();
