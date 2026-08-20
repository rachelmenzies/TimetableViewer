const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const SEMESTERS = ["SEM1", "SEM2", "SUM"];
const START_HOUR = 9;
const END_HOUR = 18;
const STORAGE_KEY = "dundee-timetable-selected-modules";
const DATA_STORAGE_KEY = "dundee-timetable-data";
const PROGRAMMES_STORAGE_KEY = "dundee-timetable-programmes";
const CATALOG_STORAGE_KEY = "dundee-timetable-catalog";

const state = {
  modules: [],
  classes: [],
  selected: new Set(),
  clashes: new Set(),
  clashGroups: [],
  search: "",
  // Per-semester selected week (SEM1/SEM2/SUM -> week number); missing/null means "all weeks".
  weekFilters: {},
  // Module ids that belong to the currently-selected programme; null when the visible list
  // isn't scoped to a programme (Fetch Data, upload, sample). Anything in state.modules that
  // isn't in this set (when it's set) is a manually-added extra, flagged "Additional" in the list.
  programmeModuleIds: null
};

// Held only in memory after "Fetch Data" authenticates, so picking several programmes
// in a row doesn't re-prompt for a password. Reset on page refresh.
let programmeAuth = null;
let programmesByLabel = new Map();

// Every module/class seen this session (Fetch Data, a programme select, or an upload) —
// the searchable pool for "add another module", independent of what's currently visible in
// state.modules. Persisted so it keeps working after a refresh.
let catalogModules = new Map();
let catalogClasses = new Map();

const elements = {
  fetchDataButton: document.querySelector("#fetchDataButton"),
  programmeSearch: document.querySelector("#programmeSearch"),
  programmeSuggestions: document.querySelector("#programmeSuggestions"),
  programmeSelectButton: document.querySelector("#programmeSelectButton"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadInput: document.querySelector("#uploadInput"),
  selectedCount: document.querySelector("#selectedCount"),
  classCount: document.querySelector("#classCount"),
  clashCount: document.querySelector("#clashCount"),
  clashMetric: document.querySelector("#clashMetric"),
  clashList: document.querySelector("#clashList"),
  semesterGroups: document.querySelector("#semesterGroups"),
  moduleList: document.querySelector("#moduleList"),
  moduleSearch: document.querySelector("#moduleSearch"),
  moduleSuggestions: document.querySelector("#moduleSuggestions"),
  selectAllButton: document.querySelector("#selectAllButton"),
  clearButton: document.querySelector("#clearButton"),
  clearTimetableButton: document.querySelector("#clearTimetableButton"),
  dundeeModal: document.querySelector("#dundeeModal"),
  dundeeLoginTitle: document.querySelector("#dundeeLoginTitle"),
  dundeeLoginForm: document.querySelector("#dundeeLoginForm"),
  closeDundeeModal: document.querySelector("#closeDundeeModal"),
  cancelDundeeLogin: document.querySelector("#cancelDundeeLogin"),
  dundeeUsername: document.querySelector("#dundeeUsername"),
  dundeePassword: document.querySelector("#dundeePassword"),
  togglePassword: document.querySelector("#togglePassword"),
  dundeeUrl: document.querySelector("#dundeeUrl"),
  dundeeLimit: document.querySelector("#dundeeLimit"),
  dundeeDebug: document.querySelector("#dundeeDebug"),
  progressModal: document.querySelector("#progressModal"),
  progressTitle: document.querySelector("#progressTitle"),
  progressBar: document.querySelector("#progressBar"),
  progressBarFill: document.querySelector("#progressBarFill"),
  progressLog: document.querySelector("#progressLog"),
  eventTooltip: document.querySelector("#eventTooltip")
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

function semesterOf(event) {
  const weeks = parseWeeks(event.weeks);
  if (!weeks.size) return "SEM1";
  const firstWeek = Math.min(...weeks);
  if (firstWeek <= 11) return "SEM1";
  if (firstWeek <= 24) return "SEM2";
  return "SUM";
}

function moduleFor(id) {
  return state.modules.find((module) => module.id === id) || { code: "", name: "" };
}

function classCountFor(moduleId) {
  return state.classes.filter((event) => event.moduleId === moduleId).length;
}

function parseWeeks(weeksText) {
  const weeks = new Set();
  String(weeksText || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        for (let week = Math.min(start, end); week <= Math.max(start, end); week += 1) {
          weeks.add(week);
        }
        return;
      }
      const single = part.match(/^(\d+)$/);
      if (single) weeks.add(Number(single[1]));
    });
  return weeks;
}

function weeksOverlap(weeksA, weeksB) {
  const a = parseWeeks(weeksA);
  const b = parseWeeks(weeksB);
  // If either side has no parseable week info, be conservative and treat it as overlapping.
  if (!a.size || !b.size) return true;
  for (const week of a) {
    if (b.has(week)) return true;
  }
  return false;
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
        if (!weeksOverlap(a.weeks, b.weeks)) continue;
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

function persistData(status) {
  try {
    localStorage.setItem(
      DATA_STORAGE_KEY,
      JSON.stringify({
        modules: state.modules,
        classes: state.classes,
        status,
        programmeModuleIds: state.programmeModuleIds ? [...state.programmeModuleIds] : null
      })
    );
  } catch {
    // Ignore storage errors (e.g. quota exceeded) — persistence is best-effort.
  }
}

function restoreData() {
  const raw = localStorage.getItem(DATA_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.modules) || !Array.isArray(parsed.classes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistCatalog() {
  try {
    localStorage.setItem(
      CATALOG_STORAGE_KEY,
      JSON.stringify({ modules: [...catalogModules.values()], classes: [...catalogClasses.values()] })
    );
  } catch {
    // Ignore storage errors (e.g. quota exceeded) — persistence is best-effort.
  }
}

function restoreCatalog() {
  const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.modules)) parsed.modules.forEach((module) => catalogModules.set(module.id, module));
    if (Array.isArray(parsed.classes)) parsed.classes.forEach((event) => catalogClasses.set(event.id, event));
  } catch {
    // Ignore malformed storage — the catalog just starts empty.
  }
}

function mergeIntoCatalog(modules, classes) {
  (modules || []).forEach((module) => catalogModules.set(module.id, module));
  (classes || []).forEach((event) => catalogClasses.set(event.id, event));
  persistCatalog();
}

// Only the programme list (codes/names) is persisted — never programmeAuth. Credentials stay
// in memory only, so a hard refresh clears them and "Select" needs a fresh "Fetch Data" login,
// same as it always has; this just saves re-typing your way back to a populated dropdown.
function persistProgrammes(programmes) {
  try {
    localStorage.setItem(PROGRAMMES_STORAGE_KEY, JSON.stringify(programmes));
  } catch {
    // Ignore storage errors (e.g. quota exceeded) — persistence is best-effort.
  }
}

function restoreProgrammes() {
  const raw = localStorage.getItem(PROGRAMMES_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setData(data, status, options = {}) {
  // A fresh upload or fetch always fully replaces whatever was loaded before —
  // no merging with prior data, and (unless explicitly restoring, i.e. only on
  // the initial page load) no carrying over a previous session's selection.
  // The timetable otherwise always starts blank: modules are added by clicking them.
  state.modules = Array.isArray(data.modules) ? data.modules : [];
  state.classes = Array.isArray(data.classes) ? data.classes : [];
  state.selected = new Set();
  state.search = "";
  state.weekFilters = {};
  state.programmeModuleIds = options.programmeModuleIds ? new Set(options.programmeModuleIds) : null;
  elements.moduleSearch.value = "";

  const restored = options.restoreSelection !== false && restoreSelection();
  if (!restored && options.selectAll) {
    state.modules.forEach((module) => state.selected.add(module.id));
  }

  persistSelection();
  if (options.persist !== false) persistData(status);
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

function tooltipRow(label, value) {
  return value ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>` : "";
}

function showEventTooltip(event, mouseEvent) {
  const module = moduleFor(event.moduleId);
  elements.eventTooltip.innerHTML = `
    <h4>${escapeHtml(event.moduleCode)}</h4>
    ${module.name ? `<p class="event-tooltip-name">${escapeHtml(module.name)}</p>` : ""}
    <dl>
      ${tooltipRow("Title", event.title)}
      ${tooltipRow("Type", event.type)}
      ${tooltipRow("Day", event.day)}
      ${tooltipRow("Time", event.start && event.end ? `${event.start}-${event.end}` : "")}
      ${tooltipRow("Date", event.date)}
      ${tooltipRow("Weeks", event.weeks)}
      ${tooltipRow("Location", event.location)}
      ${tooltipRow("Staff", event.staff)}
    </dl>
  `;
  elements.eventTooltip.hidden = false;
  positionEventTooltip(mouseEvent);
}

function positionEventTooltip(mouseEvent) {
  if (elements.eventTooltip.hidden) return;
  const offset = 16;
  const tooltip = elements.eventTooltip;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
  const maxTop = window.innerHeight - tooltip.offsetHeight - 8;
  tooltip.style.left = `${Math.min(mouseEvent.clientX + offset, Math.max(8, maxLeft))}px`;
  tooltip.style.top = `${Math.min(mouseEvent.clientY + offset, Math.max(8, maxTop))}px`;
}

function hideEventTooltip() {
  elements.eventTooltip.hidden = true;
}

function renderSemesterBlock(label, events, clashIds, weeksAvailable, selectedWeek) {
  const block = document.createElement("div");
  block.className = "semester-block";

  const heading = document.createElement("div");
  heading.className = "semester-heading-row";

  const title = document.createElement("h3");
  title.className = "semester-heading";
  title.textContent = label;
  heading.appendChild(title);

  if (weeksAvailable.length) {
    const weekPicker = document.createElement("div");
    weekPicker.className = "week-picker";

    const allPill = document.createElement("button");
    allPill.type = "button";
    allPill.className = `week-pill${selectedWeek == null ? " is-active" : ""}`;
    allPill.textContent = "All";
    allPill.dataset.semester = label;
    weekPicker.appendChild(allPill);

    weeksAvailable.forEach((week) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `week-pill${selectedWeek === week ? " is-active" : ""}`;
      pill.textContent = String(week);
      pill.dataset.semester = label;
      pill.dataset.week = String(week);
      weekPicker.appendChild(pill);
    });

    heading.appendChild(weekPicker);
  }

  block.appendChild(heading);

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
      eventBlock.innerHTML = `
        <span class="event-time">${escapeHtml(event.start)}-${escapeHtml(event.end)} · ${escapeHtml(event.moduleCode)}</span>
        <span class="event-title">${escapeHtml(event.title)}</span>
        <span class="event-detail">${escapeHtml([event.type, event.location, event.weeks && `Weeks ${event.weeks}`].filter(Boolean).join(" · "))}</span>
      `;
      eventBlock.addEventListener("mouseenter", (mouseEvent) => showEventTooltip(event, mouseEvent));
      eventBlock.addEventListener("mousemove", positionEventTooltip);
      eventBlock.addEventListener("mouseleave", hideEventTooltip);
      column.appendChild(eventBlock);
    });

    daysGrid.appendChild(column);
  });

  frame.appendChild(daysGrid);
  block.appendChild(frame);
  return block;
}

function weeksForEvents(events) {
  const weeks = new Set();
  events.forEach((event) => {
    parseWeeks(event.weeks).forEach((week) => weeks.add(week));
  });
  return [...weeks].sort((a, b) => a - b);
}

function renderSchedule() {
  const events = selectedEvents().map((event) => ({ ...event }));
  const buckets = new Map(SEMESTERS.map((label) => [label, []]));
  events.forEach((event) => {
    buckets.get(semesterOf(event)).push(event);
  });

  const allClashIds = new Set();
  let allClashGroups = [];

  elements.semesterGroups.innerHTML = "";

  SEMESTERS.forEach((label) => {
    const bucketEvents = buckets.get(label);
    const { clashIds, groups } = findClashes(bucketEvents);
    clashIds.forEach((id) => allClashIds.add(id));
    allClashGroups = allClashGroups.concat(groups);

    const weeksAvailable = weeksForEvents(bucketEvents);
    const selectedWeek = state.weekFilters[label] ?? null;
    const visibleEvents =
      selectedWeek == null ? bucketEvents : bucketEvents.filter((event) => parseWeeks(event.weeks).has(selectedWeek));

    layoutEvents(visibleEvents);
    elements.semesterGroups.appendChild(
      renderSemesterBlock(label, visibleEvents, clashIds, weeksAvailable, selectedWeek)
    );
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
      const isAdditional = state.programmeModuleIds && !state.programmeModuleIds.has(module.id);
      label.innerHTML = `
        <input type="checkbox" ${state.selected.has(module.id) ? "checked" : ""} data-module-id="${escapeHtml(module.id)}" />
        <span>
          <span class="module-code">${escapeHtml(module.code)}</span>
          <span class="module-name">${escapeHtml(module.name || "Unnamed module")}</span>
          <span class="module-meta">
            <span class="pill">${count} ${count === 1 ? "class" : "classes"}</span>
            ${isAdditional ? `<span class="pill additional">Additional</span>` : ""}
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

function loadInitialData() {
  restoreCatalog();

  const persistedProgrammes = restoreProgrammes();
  if (persistedProgrammes && persistedProgrammes.length) {
    populateProgrammeOptions(persistedProgrammes, { persist: false });
  }

  const persisted = restoreData();
  if (persisted) {
    setData(persisted, persisted.status || "Restored previous session", {
      persist: false,
      programmeModuleIds: persisted.programmeModuleIds || undefined
    });
    return;
  }
  loadSample();
}

function clearTimetable() {
  setData({ modules: [], classes: [] }, "No timetable loaded", { restoreSelection: false });
  elements.programmeSearch.value = "";
}

let progressHasError = false;

function openProgress(title) {
  progressHasError = false;
  elements.progressTitle.textContent = title;
  elements.progressLog.innerHTML = "";
  setProgressBusy();
  elements.progressModal.hidden = false;
}

// Indeterminate sweep, used while we have no way to know how far through an operation we are
// (logging in, a single non-looped request like programme discovery).
function setProgressBusy() {
  elements.progressBar.className = "progress-bar is-busy";
  elements.progressBarFill.style.width = "";
}

// Real fill-as-you-go progress, driven by completed/total counts streamed from the server.
function setProgressPercent(percent) {
  elements.progressBar.className = "progress-bar";
  elements.progressBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function logProgress(message, tone = "info") {
  if (tone === "error") progressHasError = true;
  const item = document.createElement("li");
  item.className = `progress-line${tone !== "info" ? ` progress-${tone}` : ""}`;
  item.textContent = message;
  elements.progressLog.appendChild(item);
  elements.progressLog.scrollTop = elements.progressLog.scrollHeight;
}

function finishProgress(options = {}) {
  const { autoClose = true } = options;
  elements.progressBarFill.style.width = "100%";
  elements.progressBar.className = `progress-bar ${progressHasError ? "is-error" : "is-done"}`;
  if (autoClose && !progressHasError) {
    setTimeout(() => {
      elements.progressModal.hidden = true;
    }, 1800);
  }
}

function closeProgress() {
  elements.progressModal.hidden = true;
}

async function handleUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;

  openProgress("Importing File");
  logProgress(`Importing ${file.name}...`);
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
    logProgress(`Imported ${data.classes.length} classes from ${file.name}.`, "success");
    mergeIntoCatalog(data.modules, data.classes);
    setData(data, `Imported ${data.classes.length} classes from ${file.name}`, { restoreSelection: false });
    finishProgress();
  } catch (error) {
    logProgress(error.message, "error");
    finishProgress({ autoClose: false });
  }
}

function openDundeeModal() {
  elements.dundeeModal.hidden = false;
  elements.dundeeUsername.focus();
}

function closeDundeeModal() {
  elements.dundeeModal.hidden = true;
  elements.dundeePassword.value = "";
  elements.dundeePassword.type = "password";
  elements.togglePassword.textContent = "Show";
}

function populateProgrammeOptions(programmes, options = {}) {
  programmesByLabel = new Map();
  programmes.forEach((programme) => {
    const label = `${programme.code} — ${programme.name || programme.code}`;
    programmesByLabel.set(label, programme);
  });
  elements.programmeSearch.disabled = false;
  elements.programmeSearch.value = "";
  elements.programmeSelectButton.disabled = programmes.length === 0;
  if (options.persist !== false) persistProgrammes(programmes);
}

// Shared by the programme and module search boxes: a text input paired with a filterable
// dropdown of every available item. `onPick` decides what picking an item actually does —
// for programmes that's filling the box for a later "Select" click; for modules it's an
// immediate add.
function createSuggestionBox({ input, list, getItems, getLabel, onPick }) {
  function hide() {
    list.hidden = true;
    list.innerHTML = "";
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    const items = getItems()
      .filter((item) => !query || getLabel(item).toLowerCase().includes(query))
      .slice(0, 50);

    if (!items.length) {
      hide();
      return;
    }

    list.innerHTML = "";
    items.forEach((item) => {
      const label = getLabel(item);
      const entry = document.createElement("li");
      entry.className = "suggestion-item";
      entry.textContent = label;
      entry.addEventListener("mousedown", (event) => {
        // mousedown (not click) fires before the input's blur, so the suggestion is still there to read.
        event.preventDefault();
        onPick(item, label);
        hide();
      });
      list.appendChild(entry);
    });
    list.hidden = false;
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
}

// Picking a module from the catalog search adds it (and its classes, if not already present)
// straight into the visible list and ticks it on — unlike programme search, there's no
// separate "Select" step since the data's already known.
function addModuleFromCatalog(module) {
  if (!state.modules.some((existing) => existing.id === module.id)) {
    state.modules = [...state.modules, module].sort((a, b) => a.code.localeCompare(b.code));
  }
  const existingClassIds = new Set(state.classes.map((event) => event.id));
  const newClasses = [...catalogClasses.values()].filter(
    (event) => event.moduleId === module.id && !existingClassIds.has(event.id)
  );
  if (newClasses.length) state.classes = [...state.classes, ...newClasses];

  state.selected.add(module.id);
  elements.moduleSearch.value = "";
  state.search = "";
  persistSelection();
  persistData(`Added ${module.code}`);
  render();
}

async function selectProgramme() {
  const programme = programmesByLabel.get(elements.programmeSearch.value.trim());
  if (!programme) {
    openProgress("Select Programme");
    logProgress("Pick a programme from the list first.", "error");
    finishProgress({ autoClose: false });
    return;
  }
  if (!programmeAuth) {
    openProgress("Select Programme");
    logProgress("Session expired — click Fetch Data again.", "error");
    finishProgress({ autoClose: false });
    return;
  }

  elements.programmeSelectButton.disabled = true;
  openProgress(`Fetching ${programme.code}`);
  logProgress(`Fetching activities for ${programme.code}...`);

  try {
    const response = await fetch("/api/scrape-dundee-programme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: programmeAuth.username,
        password: programmeAuth.password,
        url: programmeAuth.url,
        programmeCode: programme.code,
        debug: elements.dundeeDebug.checked
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not fetch that programme's timetable.");
    logProgress(`Loaded ${data.classes.length} classes for ${programme.code}.`, "success");
    mergeIntoCatalog(data.modules, data.classes);
    setData(data, `Loaded ${data.classes.length} classes for ${programme.code}`, {
      restoreSelection: false,
      selectAll: true,
      programmeModuleIds: data.modules.map((module) => module.id)
    });
    finishProgress();
  } catch (error) {
    logProgress(error.message, "error");
    finishProgress({ autoClose: false });
  } finally {
    elements.programmeSelectButton.disabled = false;
  }
}

// Reads a newline-delimited JSON stream (one JSON object per line), calling onEvent for each
// as it arrives — used so the module-scrape progress bar can fill in real time instead of
// waiting for one big response at the end.
async function readNdjson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !done });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  const trailing = buffer.trim();
  if (trailing) onEvent(JSON.parse(trailing));
}

async function submitDundeeLogin(event) {
  event.preventDefault();
  const submitButton = elements.dundeeLoginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Fetching...";

  const username = elements.dundeeUsername.value.trim();
  const password = elements.dundeePassword.value;
  const url = elements.dundeeUrl.value.trim();
  const limit = elements.dundeeLimit.value ? Number(elements.dundeeLimit.value) : undefined;
  const debug = elements.dundeeDebug.checked;

  closeDundeeModal();
  openProgress("Fetching Dundee Data");
  logProgress("Logging in...");

  try {
    const response = await fetch("/api/scrape-dundee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, url, limit, debug })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || "Timetable fetch failed.");
    }

    let scrapedData = null;
    await readNdjson(response, (streamEvent) => {
      if (streamEvent.type === "start") {
        logProgress(`Fetching ${streamEvent.total} modules...`);
        setProgressPercent(0);
      } else if (streamEvent.type === "progress") {
        setProgressPercent((streamEvent.completed / streamEvent.total) * 100);
      } else if (streamEvent.type === "error") {
        throw new Error(streamEvent.error);
      } else if (streamEvent.type === "done") {
        scrapedData = streamEvent.data;
      }
    });
    if (!scrapedData) throw new Error("Timetable fetch failed.");

    const data = scrapedData;
    const failedText =
      data.failures && data.failures.length
        ? ` (${data.failures.length} modules failed, e.g. ${data.failures[0].module}: ${data.failures[0].error})`
        : "";
    logProgress(
      `Fetched ${data.classes.length} classes from ${data.scrapedModules} modules${failedText}`,
      data.failures && data.failures.length ? "error" : "success"
    );
    mergeIntoCatalog(data.modules, data.classes);
    setData(data, `Scraped ${data.classes.length} classes from ${data.scrapedModules} Dundee modules`, {
      restoreSelection: false
    });
  } catch (error) {
    logProgress(`Module fetch failed: ${error.message}`, "error");
    finishProgress({ autoClose: false });
    submitButton.disabled = false;
    submitButton.textContent = "Fetch Data";
    return;
  }

  setProgressBusy();

  logProgress("Fetching programme list...");
  try {
    const response = await fetch("/api/dundee-programmes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not fetch the programme list.");
    programmeAuth = { username, password, url };
    populateProgrammeOptions(data.programmes || []);
    logProgress(`Loaded ${data.programmes.length} programmes.`, "success");
  } catch (error) {
    logProgress(`Programme list unavailable: ${error.message}`, "error");
  }

  finishProgress();
  submitButton.disabled = false;
  submitButton.textContent = "Fetch Data";
}

elements.fetchDataButton.addEventListener("click", openDundeeModal);
elements.programmeSelectButton.addEventListener("click", selectProgramme);
createSuggestionBox({
  input: elements.programmeSearch,
  list: elements.programmeSuggestions,
  getItems: () => [...programmesByLabel.keys()],
  getLabel: (label) => label,
  onPick: (label) => {
    elements.programmeSearch.value = label;
  }
});
createSuggestionBox({
  input: elements.moduleSearch,
  list: elements.moduleSuggestions,
  getItems: () => [...catalogModules.values()],
  getLabel: (module) => `${module.code} — ${module.name || module.code}`,
  onPick: (module) => addModuleFromCatalog(module)
});
elements.togglePassword.addEventListener("click", () => {
  const showing = elements.dundeePassword.type === "text";
  elements.dundeePassword.type = showing ? "password" : "text";
  elements.togglePassword.textContent = showing ? "Show" : "Hide";
});
elements.progressModal.addEventListener("click", (event) => {
  if (event.target === elements.progressModal) closeProgress();
});
elements.uploadButton.addEventListener("click", () => elements.uploadInput.click());
elements.uploadInput.addEventListener("change", handleUpload);
elements.dundeeLoginForm.addEventListener("submit", submitDundeeLogin);
elements.closeDundeeModal.addEventListener("click", closeDundeeModal);
elements.cancelDundeeLogin.addEventListener("click", closeDundeeModal);
elements.dundeeModal.addEventListener("click", (event) => {
  if (event.target === elements.dundeeModal) closeDundeeModal();
});

elements.moduleSearch.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderModules();
});

elements.semesterGroups.addEventListener("click", (event) => {
  const pill = event.target.closest(".week-pill");
  if (!pill) return;
  state.weekFilters[pill.dataset.semester] = pill.dataset.week ? Number(pill.dataset.week) : null;
  render();
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

elements.clearTimetableButton.addEventListener("click", clearTimetable);

loadInitialData();
