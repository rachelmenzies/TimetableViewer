// Core Dundee-timetable scraping/parsing logic, kept independent of any HTTP request/response
// so it can be driven either by server.js (live browser requests) or scripts/fetch-timetable.js
// (a scheduled GitHub Actions job that writes a static JSON snapshot for GitHub Pages).

const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const DUNDEE_ORIGIN = "https://timetable.dundee.ac.uk";
const DEFAULT_DUNDEE_URL = `${DUNDEE_ORIGIN}/Scientia/SWS/Dundee2627/`;
const DEBUG_DIR = path.join(__dirname, "..", "debug-output");

function requestText(targetUrl, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const body = options.body || "";
    const req = client.request(
      parsed,
      {
        method: options.method || "GET",
        headers: {
          "User-Agent": "DundeeTimetableViewer/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body)
              }
            : {}),
          ...(options.headers || {})
        }
      },
      (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location &&
          redirectCount < 5
        ) {
          response.resume();
          const nextUrl = new URL(response.headers.location, parsed).toString();
          requestText(nextUrl, options, redirectCount + 1).then(resolve, reject);
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body
          });
        });
      }
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error("The timetable request timed out."));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function fetchText(targetUrl) {
  return requestText(targetUrl);
}

function curlConfigValue(value) {
  return `"${String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function scrubCredentials(text) {
  return String(text || "").replace(/(https?:\/\/[^:/@\s]+):[^@/\s]+@/gi, "$1:***@");
}

function requestDundeeText(targetUrl, options) {
  return new Promise((resolve, reject) => {
    const config = [
      "silent",
      "show-error",
      // curl mishandles following a redirect on a POST while also re-doing NTLM auth on
      // the new URL (it announces "Switch from POST to GET" but sends a bodyless POST
      // instead, which IIS rejects with 411). So redirects are followed manually for
      // POST requests instead of relying on curl's built-in "location" handling.
      ...(options.method === "POST" ? [] : ["location"]),
      "ntlm",
      ...(options.trace ? ["verbose"] : []),
      `url = ${curlConfigValue(targetUrl)}`,
      `user = ${curlConfigValue(`${options.username}:${options.password}`)}`,
      `cookie = ${curlConfigValue(options.cookieFile)}`,
      `cookie-jar = ${curlConfigValue(options.cookieFile)}`,
      `header = ${curlConfigValue("User-Agent: DundeeTimetableViewer/1.0")}`,
      `header = ${curlConfigValue("Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")}`,
      "max-time = 45"
    ];

    if (options.method === "POST") {
      config.push("request = POST");
      config.push(`header = ${curlConfigValue("Content-Type: application/x-www-form-urlencoded")}`);
      config.push(`header = ${curlConfigValue("Expect:")}`);
      config.push(`data = ${curlConfigValue(options.body || "")}`);
    }

    const child = spawn(
      "curl",
      ["--config", "-", "--write-out", "\n__HTTP_STATUS__:%{http_code}\n__REDIRECT_URL__:%{redirect_url}"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      const match = stdout.match(/\n__HTTP_STATUS__:(\d{3})\n__REDIRECT_URL__:([^\n]*)\n?$/);
      const body = match ? stdout.slice(0, match.index) : stdout;
      const statusCode = match ? Number(match[1]) : 0;
      const redirectUrl = match ? match[2] : "";
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }
      resolve({ statusCode, headers: {}, body, trace: stderr, redirectUrl });
    });

    child.stdin.end(`${config.join("\n")}\n`);
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function slugify(value) {
  return String(value || "module")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normaliseDate(value) {
  const match = String(value || "").match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!match) return "";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function normaliseTime(value) {
  const match = String(value || "").match(/\b(\d{1,2})(?::?(\d{2}))\s*(am|pm)?\b/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = (match[3] || "").toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function inferDay(text, date) {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const found = days.find((day) => new RegExp(`\\b${day}\\b`, "i").test(text));
  if (found) return found;
  if (!date) return "";
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return days[(day + 6) % 7] || "";
}

// Co-taught modules appear as slash-joined codes (e.g. "CS31000/CS41000") — the whole
// compound code is matched so neither side is dropped when identifying a module.
function inferModuleCode(text) {
  const code = "[A-Z]{2,4}\\d{5}(?:-[A-Z0-9]+)*";
  const match = String(text || "").match(new RegExp(`\\b${code}(?:\\/${code})*\\b`));
  return match ? match[0] : "";
}

// The bare subject+number, stripping any "-SEM1-A"-style instance suffix and any "/OTHERCODE"
// co-teaching partner. Used to recognise when a picker-listed module (e.g. "CS21002-SEM1-A")
// is really the same underlying module as one already captured under a compound code (e.g.
// "CS21002/MA31008") — Dundee lists cross-listed modules under each linked code separately,
// but only one side's own page tends to carry the actual sessions.
function baseModuleCode(code) {
  const match = String(code || "").match(/^[A-Z]{2,4}\d{5}/);
  return match ? match[0] : String(code || "").toUpperCase();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted && char === '"' && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(value);
      value = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function recordsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headings = rows.shift().map((heading) => heading.trim().toLowerCase());
  return rows.map((row) => {
    const record = {};
    headings.forEach((heading, index) => {
      record[heading] = row[index] ? row[index].trim() : "";
    });
    return record;
  });
}

function unfoldIcs(text) {
  return String(text || "").replace(/\r?\n[ \t]/g, "");
}

function parseIcsDate(value) {
  const match = String(value || "").match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!match) return { date: "", time: "" };
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : ""
  };
}

function recordsFromIcs(text) {
  const unfolded = unfoldIcs(text);
  const events = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return events.map((block) => {
    const lines = block.split(/\r?\n/);
    const get = (name) => {
      const line = lines.find((entry) => entry.toUpperCase().startsWith(name));
      return line ? line.slice(line.indexOf(":") + 1).replace(/\\,/g, ",").replace(/\\n/g, " ") : "";
    };
    const start = parseIcsDate(get("DTSTART"));
    const end = parseIcsDate(get("DTEND"));
    const summary = get("SUMMARY");
    const description = get("DESCRIPTION");
    return {
      module: inferModuleCode(`${summary} ${description}`),
      moduleName: summary,
      title: summary,
      type: "",
      day: inferDay("", start.date),
      date: start.date,
      start: start.time,
      end: end.time,
      location: get("LOCATION"),
      staff: "",
      weeks: ""
    };
  });
}

function recordsFromHtml(html) {
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const records = [];
  let headers = [];

  rows.forEach((rowHtml) => {
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) =>
      stripTags(match[1])
    );
    if (cells.length < 2) return;
    const isHeader = /<th/i.test(rowHtml) || cells.some((cell) => /^(module|subject|activity|start|day|date)$/i.test(cell));
    if (isHeader) {
      headers = cells.map((cell) => cell.toLowerCase());
      return;
    }
    if (headers.length === cells.length) {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index];
      });
      records.push(record);
      return;
    }

    const text = cells.join(" ");
    const timeRange = text.match(/\b(\d{1,2}:?\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:?\d{2}\s*(?:am|pm)?)\b/i);
    const date = normaliseDate(text);
    records.push({
      module: inferModuleCode(text),
      moduleName: "",
      title: cells.find((cell) => cell.length > 8 && !/^\d/.test(cell)) || text,
      type: "",
      day: inferDay(text, date),
      date,
      start: timeRange ? timeRange[1] : "",
      end: timeRange ? timeRange[2] : "",
      location: cells.find((cell) => /\b(room|lt|lecture theatre|building|campus)\b/i.test(cell)) || "",
      staff: "",
      weeks: ""
    });
  });

  if (records.length) return records;

  return stripTags(html)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 20)
    .map((line) => {
      const timeRange = line.match(/\b(\d{1,2}:?\d{2}\s*(?:am|pm)?)\s*[-–]\s*(\d{1,2}:?\d{2}\s*(?:am|pm)?)\b/i);
      const date = normaliseDate(line);
      return {
        module: inferModuleCode(line),
        moduleName: "",
        title: line,
        type: "",
        day: inferDay(line, date),
        date,
        start: timeRange ? timeRange[1] : "",
        end: timeRange ? timeRange[2] : "",
        location: "",
        staff: "",
        weeks: ""
      };
    })
    .filter((record) => record.module && record.start && record.end);
}

function pick(record, names) {
  for (const name of names) {
    if (record[name] != null && String(record[name]).trim()) return String(record[name]).trim();
  }
  return "";
}

function normaliseRecords(records) {
  const modules = new Map();
  const classes = [];
  // Cross-listed/co-taught modules are often listed under each of their linked codes
  // separately in Dundee's picker, and scraping either one returns the same shared
  // timetable — so the same session can genuinely arrive twice across different module
  // scrapes. Deduped here by content (not a scrape-order-dependent id) so it doesn't matter
  // which code produced which copy.
  const seenSignatures = new Set();

  records.forEach((record, index) => {
    const lower = {};
    Object.keys(record || {}).forEach((key) => {
      lower[key.trim().toLowerCase()] = record[key];
    });

    const rawText = Object.values(record || {}).join(" ");
    const moduleCode =
      pick(lower, ["module", "module code", "subject", "subject code", "code"]) || inferModuleCode(rawText);
    const moduleName =
      pick(lower, ["module name", "modulename", "subject name", "name"]) ||
      pick(lower, ["module", "subject"]) ||
      moduleCode ||
      "Unknown module";
    const date = normaliseDate(pick(lower, ["date", "start date"]) || rawText);
    const day = pick(lower, ["day", "weekday"]) || inferDay(rawText, date);
    const start = normaliseTime(pick(lower, ["start", "start time", "from"]) || rawText);
    const end = normaliseTime(pick(lower, ["end", "end time", "to"]) || rawText.replace(start, ""));

    if (!moduleCode || !day || !start || !end) return;

    const moduleId = slugify(moduleCode);
    if (!modules.has(moduleId)) {
      modules.set(moduleId, {
        id: moduleId,
        code: moduleCode,
        name: moduleName === moduleCode ? "" : moduleName
      });
    }

    const title = pick(lower, ["activity", "title", "event", "class"]) || moduleName;
    const location = pick(lower, ["location", "room", "venue"]);
    const weeks = pick(lower, ["weeks", "week", "teaching weeks"]);
    const signature = [moduleId, day, start, end, title, weeks, location].join("|");
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);

    classes.push({
      id: `${moduleId}-${index}`,
      moduleId,
      moduleCode,
      title,
      type: pick(lower, ["type", "activity type", "category"]),
      day,
      date,
      start,
      end,
      location,
      staff: pick(lower, ["staff", "lecturer", "teacher"]),
      weeks
    });
  });

  return {
    modules: [...modules.values()].sort((a, b) => a.code.localeCompare(b.code)),
    classes: classes.sort((a, b) => `${a.day}${a.start}`.localeCompare(`${b.day}${b.start}`)),
    scrapedAt: new Date().toISOString()
  };
}

function parseTimetablePayload(payload) {
  const trimmed = String(payload || "").trim();
  if (!trimmed) return { modules: [], classes: [], scrapedAt: new Date().toISOString() };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normaliseRecords(parsed);
    if (Array.isArray(parsed.classes) && Array.isArray(parsed.modules)) return parsed;
    if (Array.isArray(parsed.events)) return normaliseRecords(parsed.events);
    throw new Error("JSON must be an array of events or an object with modules/classes.");
  }

  if (/BEGIN:VCALENDAR/i.test(trimmed)) return normaliseRecords(recordsFromIcs(trimmed));

  const looksLikeScientiaPage =
    /class=(["'])[^"']*\blabelone\b[^"']*\1/i.test(trimmed) && /class=(["'])[^"']*\bspreadsheet\b[^"']*\1/i.test(trimmed);
  if (looksLikeScientiaPage) {
    const sessions = parseScientiaModuleTimetable(trimmed, { code: "", name: "" });
    if (sessions.length) return normaliseRecords(sessions);
  }

  if (/<(?:html|table|tr|td|th)\b/i.test(trimmed)) return normaliseRecords(recordsFromHtml(trimmed));
  return normaliseRecords(recordsFromCsv(trimmed));
}

function normaliseDundeeUsername(username) {
  const trimmed = String(username || "").trim();
  if (!trimmed || trimmed.includes("\\") || trimmed.includes("@")) return trimmed;
  return `DUNDEE\\${trimmed}`;
}

function defaultPageUrl(sourceUrl) {
  const target = new URL(sourceUrl || DEFAULT_DUNDEE_URL, DEFAULT_DUNDEE_URL);
  if (target.hostname !== "timetable.dundee.ac.uk") {
    throw new Error("Only timetable.dundee.ac.uk URLs can be fetched.");
  }
  if (target.pathname.endsWith("/")) {
    target.pathname += "default.aspx";
  } else if (!/\.aspx$/i.test(target.pathname)) {
    target.pathname = `${target.pathname.replace(/\/?$/, "/")}default.aspx`;
  }
  return target.toString();
}

function formEncode(entries) {
  const params = new URLSearchParams();
  entries.forEach(([key, value]) => {
    params.append(key, value || "");
  });
  return params.toString();
}

function extractHiddenFields(html) {
  const fields = {};
  ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "__LASTFOCUS"].forEach((name) => {
    const tagMatch = String(html || "").match(new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, "i"));
    const valueMatch = tagMatch ? tagMatch[0].match(/\bvalue=(["'])([\s\S]*?)\1/i) : null;
    fields[name] = valueMatch ? decodeHtml(valueMatch[2]) : "";
  });
  return fields;
}

function assertAuthenticated(response) {
  if (response.statusCode === 401 || /401\s*-\s*Unauthorized|Access is denied due to invalid credentials/i.test(response.body)) {
    throw new Error("Dundee rejected those credentials or the timetable requires another login step.");
  }
  if (response.statusCode >= 400) {
    const snippet = stripTags(response.body).slice(0, 160);
    throw new Error(`Dundee returned HTTP ${response.statusCode}${snippet ? `: ${snippet}` : ""}`);
  }
}

function extractModuleOptions(html) {
  const selectMatch = String(html || "").match(/<select[^>]*(?:name|id)=["']dlObject["'][\s\S]*?<\/select>/i);
  if (!selectMatch) return [];

  return [...selectMatch[0].matchAll(/<option[^>]*value=(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/option>/gi)]
    .map((match) => {
      const code = decodeHtml(match[2]);
      const label = stripTags(match[3]);
      const name = label.replace(code, "").replace(/^[-:\s]+/, "").trim();
      return {
        id: slugify(code),
        code,
        name
      };
    })
    .filter((module) => module.code);
}

async function getModulesTab(defaultUrl, auth) {
  const first = await requestDundeeText(defaultUrl, auth);
  assertAuthenticated(first);
  const firstFields = extractHiddenFields(first.body);
  const switchBody = formEncode([
    ["__EVENTTARGET", "LinkBtn_modules"],
    ["__EVENTARGUMENT", ""],
    ["__VIEWSTATE", firstFields.__VIEWSTATE],
    ["__VIEWSTATEGENERATOR", firstFields.__VIEWSTATEGENERATOR],
    ["__EVENTVALIDATION", firstFields.__EVENTVALIDATION],
    ["__LASTFOCUS", firstFields.__LASTFOCUS]
  ]);

  const second = await requestDundeeText(defaultUrl, {
    ...auth,
    method: "POST",
    body: switchBody
  });
  assertAuthenticated(second);
  if (!/name=["']dlObject["']|id=["']dlObject["']/i.test(second.body)) {
    throw new Error("The Modules tab did not load. Dundee may have changed the timetable page.");
  }
  return {
    html: second.body,
    fields: extractHiddenFields(second.body),
    modules: extractModuleOptions(second.body)
  };
}

// The "Programmes of Study" tab isn't verified against a live Dundee page — unlike
// LinkBtn_modules (known-working), this tries a handful of plausible EVENTTARGET names for
// Scientia's programme/student-set picker until one produces the same dlObject select the
// modules tab uses. If Dundee's actual tab id isn't in this list, every attempt fails and the
// caller gets a clear "Programmes tab not found" error rather than a silent wrong result.
const PROGRAMME_TAB_TARGETS = [
  "LinkBtn_programmesofstudy",
  "LinkBtn_programmes",
  "LinkBtn_studentsets",
  "LinkBtn_courses"
];

async function getProgrammesTab(defaultUrl, auth) {
  const first = await requestDundeeText(defaultUrl, auth);
  assertAuthenticated(first);
  const firstFields = extractHiddenFields(first.body);

  for (const eventTarget of PROGRAMME_TAB_TARGETS) {
    try {
      const switchBody = formEncode([
        ["__EVENTTARGET", eventTarget],
        ["__EVENTARGUMENT", ""],
        ["__VIEWSTATE", firstFields.__VIEWSTATE],
        ["__VIEWSTATEGENERATOR", firstFields.__VIEWSTATEGENERATOR],
        ["__EVENTVALIDATION", firstFields.__EVENTVALIDATION],
        ["__LASTFOCUS", firstFields.__LASTFOCUS]
      ]);
      const second = await requestDundeeText(defaultUrl, { ...auth, method: "POST", body: switchBody });
      assertAuthenticated(second);
      if (/name=["']dlObject["']|id=["']dlObject["']/i.test(second.body)) {
        return {
          html: second.body,
          fields: extractHiddenFields(second.body),
          programmes: extractModuleOptions(second.body),
          tLinkType: eventTarget.replace(/^LinkBtn_/, "")
        };
      }
    } catch {
      // Try the next candidate tab id.
    }
  }

  throw new Error(
    "Could not find a Programmes of Study tab on Dundee's timetable page — the live page may label it differently than expected."
  );
}

// Scientia's "TextSpreadsheet" report exports several different layouts depending on how
// it was generated (a single module's page has no Module column since the whole page is
// already scoped to it; a Programme of Study page lists many modules and adds one). Columns
// are read by their header text rather than a fixed position/count so any such layout works.
function parseScientiaModuleTimetable(html, fallbackModule) {
  const text = stripTags(html);
  const moduleMatch = text.match(/Module:\s*(\S+)\s*-\s*(.+?)\s*Weeks:/i);
  const pageModuleCode = moduleMatch ? moduleMatch[1].trim() : fallbackModule.code;
  const pageModuleTitle = moduleMatch ? moduleMatch[2].trim() : fallbackModule.name;
  const sessions = [];

  const dayBlocks = String(html || "").matchAll(
    /<span[^>]*class=(["'])[^"']*\blabelone\b[^"']*\1[^>]*>([\s\S]*?)<\/span>[\s\S]*?<table[^>]*class=(["'])[^"']*\bspreadsheet\b[^"']*\3[^>]*>([\s\S]*?)<\/table>/gi
  );

  for (const block of dayBlocks) {
    const day = stripTags(block[2]);
    if (!["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].includes(day)) continue;

    const rows = block[4].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let headerIndex = null;

    rows.forEach((row) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripTags(match[1]));
      if (!cells.length) return;

      if (/columnTitles/i.test(row)) {
        headerIndex = {};
        cells.forEach((cell, index) => {
          headerIndex[cell.trim().toLowerCase()] = index;
        });
        return;
      }
      if (!headerIndex) return;

      const cellAt = (name) => {
        const index = headerIndex[name];
        return index == null ? "" : (cells[index] || "").trim();
      };

      const activity = cellAt("activity");
      const start = cellAt("start");
      const end = cellAt("end");
      if (!start || !end) return;

      // On a multi-module page (e.g. Programme of Study) the Activity cell is prefixed with
      // the module code to disambiguate ("CS11002-SEM1-A LabPracA /ALL"); that's redundant
      // once split into its own field, so it's stripped for a cleaner display title.
      const rowModuleCode = inferModuleCode(activity) || pageModuleCode;
      const activityLabel = rowModuleCode
        ? activity.replace(new RegExp(`^${rowModuleCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "").trim() ||
          activity
        : activity;

      sessions.push({
        module: rowModuleCode,
        moduleName: cellAt("module") || pageModuleTitle,
        day,
        activity: activityLabel,
        type: cellAt("type"),
        start,
        end,
        duration: cellAt("duration"),
        weeks: cellAt("weeks"),
        staff: cellAt("staff"),
        room: cellAt("room")
      });
    });
  }

  return sessions;
}

async function postGetTimetable(defaultUrl, auth, fields, moduleCode, debug) {
  const body = formEncode([
    ["__EVENTTARGET", ""],
    ["__EVENTARGUMENT", ""],
    ["__VIEWSTATE", fields.__VIEWSTATE],
    ["__VIEWSTATEGENERATOR", fields.__VIEWSTATEGENERATOR],
    ["__EVENTVALIDATION", fields.__EVENTVALIDATION],
    ["__LASTFOCUS", fields.__LASTFOCUS],
    ["tLinkType", "modules"],
    ["dlObject", moduleCode],
    ["lbWeeks", Array.from({ length: 52 }, (_, index) => String(index + 1)).join(";")],
    ["lbDays", "1-5"],
    ["dlPeriod", "1-28"],
    ["RadioType", "TextSpreadsheet;swsurl;SWSCUST Module TextSpreadsheet"],
    ["bGetTimetable", "View Timetable"]
  ]);

  let response = await requestDundeeText(defaultUrl, {
    ...auth,
    method: "POST",
    body,
    trace: debug
  });
  let trace = response.trace || "";

  if (response.statusCode >= 300 && response.statusCode < 400 && response.redirectUrl) {
    const nextUrl = new URL(response.redirectUrl, defaultUrl).toString();
    response = await requestDundeeText(nextUrl, { ...auth, method: "GET", trace: debug });
    trace += `\n----- followed redirect to ${nextUrl} -----\n${response.trace || ""}`;
  }

  if (debug) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${slugify(moduleCode)}.html`), response.body);
    fs.writeFileSync(path.join(DEBUG_DIR, `${slugify(moduleCode)}.trace.txt`), scrubCredentials(trace));
  }

  assertAuthenticated(response);
  return response.body;
}

// `fields` (the modules-tab VIEWSTATE snapshot) is shared and reused across every module in a
// scrape instead of being re-fetched per module (a ~3x reduction in requests). If a particular
// module's postback is rejected (a stale/invalidated VIEWSTATE), the snapshot is refreshed once
// and the caller's shared `fields` object is updated in place so later modules benefit too.
async function fetchModuleTimetable(defaultUrl, auth, fields, moduleCode, debug) {
  try {
    return await postGetTimetable(defaultUrl, auth, fields, moduleCode, debug);
  } catch (error) {
    const freshTab = await getModulesTab(defaultUrl, auth);
    Object.assign(fields, freshTab.fields);
    return await postGetTimetable(defaultUrl, auth, fields, moduleCode, debug);
  }
}

// Mirrors postGetTimetable, but for a programme/student-set object rather than a module. The
// RadioType custom report name ("SWSCUST Programme TextSpreadsheet") follows the same naming
// pattern as the module report but, like the tab id above, is a best-effort guess — it hasn't
// been confirmed against Dundee's actual Scientia configuration.
async function postGetProgrammeTimetable(defaultUrl, auth, fields, tLinkType, programmeCode, debug) {
  const body = formEncode([
    ["__EVENTTARGET", ""],
    ["__EVENTARGUMENT", ""],
    ["__VIEWSTATE", fields.__VIEWSTATE],
    ["__VIEWSTATEGENERATOR", fields.__VIEWSTATEGENERATOR],
    ["__EVENTVALIDATION", fields.__EVENTVALIDATION],
    ["__LASTFOCUS", fields.__LASTFOCUS],
    ["tLinkType", tLinkType],
    ["dlObject", programmeCode],
    ["lbWeeks", Array.from({ length: 52 }, (_, index) => String(index + 1)).join(";")],
    ["lbDays", "1-5"],
    ["dlPeriod", "1-28"],
    ["RadioType", "TextSpreadsheet;swsurl;SWSCUST Programme TextSpreadsheet"],
    ["bGetTimetable", "View Timetable"]
  ]);

  let response = await requestDundeeText(defaultUrl, { ...auth, method: "POST", body, trace: debug });
  let trace = response.trace || "";

  if (response.statusCode >= 300 && response.statusCode < 400 && response.redirectUrl) {
    const nextUrl = new URL(response.redirectUrl, defaultUrl).toString();
    response = await requestDundeeText(nextUrl, { ...auth, method: "GET", trace: debug });
    trace += `\n----- followed redirect to ${nextUrl} -----\n${response.trace || ""}`;
  }

  if (debug) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${slugify(programmeCode)}.html`), response.body);
    fs.writeFileSync(path.join(DEBUG_DIR, `${slugify(programmeCode)}.trace.txt`), scrubCredentials(trace));
  }

  assertAuthenticated(response);
  return response.body;
}

const DEFAULT_CONCURRENCY = 4;

// Runs worker(lane, item) over items using up to laneCount concurrent lanes. Each lane calls
// createLane(laneIndex) exactly once, up front, to set up its own independent session — a
// concurrent request can't safely reuse another lane's cookie file (curl doesn't lock it) or
// VIEWSTATE snapshot (each response's hidden fields must feed the very next request on that
// SAME session), so every lane beyond the first logs in separately. JS's single-threaded event
// loop means the shared arrays/counters the callers close over are safe to mutate directly from
// each lane — there's no interleaving mid-statement, only at await points.
async function runInLanes(items, laneCount, createLane, worker) {
  let nextIndex = 0;
  async function runLane(laneIndex) {
    const lane = await createLane(laneIndex);
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(lane, items[index], index);
    }
  }
  const count = Math.max(1, Math.min(laneCount, items.length || 1));
  await Promise.all(Array.from({ length: count }, (_, laneIndex) => runLane(laneIndex)));
}

async function discoverDundeeProgrammes({ username, password, url }) {
  if (!username || !password) {
    throw new Error("Username and password are required for Dundee timetable scraping.");
  }

  const defaultUrl = defaultPageUrl(url);
  const cookieFile = path.join(os.tmpdir(), `dundee-timetable-${process.pid}-${Date.now()}.cookies`);
  const auth = { username: normaliseDundeeUsername(username), password, cookieFile };

  try {
    const tab = await getProgrammesTab(defaultUrl, auth);
    if (!tab.programmes.length) {
      throw new Error("No programmes were found in Dundee's programme picker.");
    }
    return { programmes: tab.programmes, source: defaultUrl };
  } finally {
    fs.rm(cookieFile, { force: true }, () => {});
  }
}

async function scrapeDundeeProgramme({ username, password, url, programmeCode, debug }) {
  if (!username || !password) {
    throw new Error("Username and password are required for Dundee timetable scraping.");
  }
  if (!programmeCode) {
    throw new Error("A programme code is required.");
  }

  const defaultUrl = defaultPageUrl(url);
  const cookieFile = path.join(os.tmpdir(), `dundee-timetable-${process.pid}-${Date.now()}.cookies`);
  const auth = { username: normaliseDundeeUsername(username), password, cookieFile };

  try {
    const tab = await getProgrammesTab(defaultUrl, auth);
    const programme = tab.programmes.find((item) => item.code === programmeCode);
    if (!programme) {
      throw new Error(`Programme ${programmeCode} was not found in Dundee's programme picker.`);
    }

    const html = await postGetProgrammeTimetable(defaultUrl, auth, tab.fields, tab.tLinkType, programmeCode, debug);
    const records = parseScientiaModuleTimetable(html, programme);
    const data = normaliseRecords(records);
    data.source = defaultUrl;
    data.programme = programme;
    if (debug) data.debugFiles = [DEBUG_DIR];
    return data;
  } finally {
    fs.rm(cookieFile, { force: true }, () => {});
  }
}

// `tabState` (the programmes-tab VIEWSTATE snapshot) is shared and reused across every
// programme a lane handles, the same way fetchModuleTimetable reuses `fields` across modules —
// instead of scrapeDundeeProgramme's one-fresh-login-per-call, which is fine for a single live
// "Select Programme" click but far too slow to call in a loop for every programme.
async function fetchProgrammeTimetable(defaultUrl, auth, tabState, programmeCode, debug) {
  try {
    return await postGetProgrammeTimetable(defaultUrl, auth, tabState.fields, tabState.tLinkType, programmeCode, debug);
  } catch (error) {
    const freshTab = await getProgrammesTab(defaultUrl, auth);
    Object.assign(tabState.fields, freshTab.fields);
    return await postGetProgrammeTimetable(defaultUrl, auth, tabState.fields, tabState.tLinkType, programmeCode, debug);
  }
}

// Batch version used by the nightly fetch script to get every programme's module associations
// in one run. Logs in once per lane (see runInLanes) and reuses that session across every
// programme the lane processes, rather than scrapeDundeeProgramme's per-call fresh login —
// combined with running several lanes concurrently, this is the fix for the programme phase
// taking roughly 3x longer per item than the module phase. Mutates each programme object in
// `programmes` with a `moduleIds` array (left absent if that one programme's fetch failed).
async function scrapeDundeeProgrammes({ username, password, url, programmes, debug, onProgress, concurrency }) {
  if (!username || !password) {
    throw new Error("Username and password are required for Dundee timetable scraping.");
  }

  const defaultUrl = defaultPageUrl(url);
  const primaryCookieFile = path.join(os.tmpdir(), `dundee-timetable-programmes-${process.pid}-${Date.now()}-0.cookies`);
  const primaryAuth = { username: normaliseDundeeUsername(username), password, cookieFile: primaryCookieFile };
  const cookieFiles = [primaryCookieFile];

  try {
    const tab = await getProgrammesTab(defaultUrl, primaryAuth);
    const failures = [];
    let completed = 0;

    if (onProgress) onProgress({ type: "start", total: programmes.length });

    await runInLanes(
      programmes,
      Number(concurrency) || DEFAULT_CONCURRENCY,
      async (laneIndex) => {
        if (laneIndex === 0) {
          return { auth: primaryAuth, tabState: { fields: { ...tab.fields }, tLinkType: tab.tLinkType } };
        }
        const laneCookieFile = path.join(
          os.tmpdir(),
          `dundee-timetable-programmes-${process.pid}-${Date.now()}-${laneIndex}.cookies`
        );
        cookieFiles.push(laneCookieFile);
        const laneAuth = { ...primaryAuth, cookieFile: laneCookieFile };
        const laneTab = await getProgrammesTab(defaultUrl, laneAuth);
        return { auth: laneAuth, tabState: { fields: { ...laneTab.fields }, tLinkType: laneTab.tLinkType } };
      },
      async (lane, programme) => {
        try {
          const html = await fetchProgrammeTimetable(defaultUrl, lane.auth, lane.tabState, programme.code, debug);
          const records = parseScientiaModuleTimetable(html, programme);
          programme.moduleIds = [...new Set(records.map((record) => slugify(record.module)))];
        } catch (error) {
          console.error(`[scrape-dundee-programmes] ${programme.code} failed: ${error.message}`);
          failures.push({ programme: programme.code, error: error.message });
        }
        completed += 1;
        if (onProgress) onProgress({ type: "progress", completed, total: programmes.length, programme: programme.code });
      }
    );

    return { programmes, failures };
  } finally {
    cookieFiles.forEach((file) => fs.rm(file, { force: true }, () => {}));
  }
}

async function scrapeDundeeTimetable({ username, password, url, limit, debug, moduleCodes, onProgress, concurrency }) {
  if (!username || !password) {
    throw new Error("Username and password are required for Dundee timetable scraping.");
  }

  const defaultUrl = defaultPageUrl(url);
  const primaryCookieFile = path.join(os.tmpdir(), `dundee-timetable-${process.pid}-${Date.now()}-0.cookies`);
  const primaryAuth = { username: normaliseDundeeUsername(username), password, cookieFile: primaryCookieFile };
  const cookieFiles = [primaryCookieFile];

  try {
    const tab = await getModulesTab(defaultUrl, primaryAuth);
    const modules = tab.modules;
    if (!modules.length) {
      throw new Error("No modules were found in Dundee's module picker.");
    }

    let candidateModules = modules;
    if (Array.isArray(moduleCodes) && moduleCodes.length) {
      const wanted = new Set(moduleCodes);
      candidateModules = modules.filter((module) => wanted.has(module.code));
    }

    const selectedModules = Number(limit) > 0 ? candidateModules.slice(0, Number(limit)) : candidateModules;
    const records = [];
    const failures = [];
    let completed = 0;

    if (onProgress) onProgress({ type: "start", total: selectedModules.length });

    await runInLanes(
      selectedModules,
      Number(concurrency) || DEFAULT_CONCURRENCY,
      async (laneIndex) => {
        if (laneIndex === 0) {
          return { auth: primaryAuth, fields: { ...tab.fields } };
        }
        const laneCookieFile = path.join(os.tmpdir(), `dundee-timetable-${process.pid}-${Date.now()}-${laneIndex}.cookies`);
        cookieFiles.push(laneCookieFile);
        const laneAuth = { ...primaryAuth, cookieFile: laneCookieFile };
        const laneTab = await getModulesTab(defaultUrl, laneAuth);
        return { auth: laneAuth, fields: { ...laneTab.fields } };
      },
      async (lane, module) => {
        try {
          const html = await fetchModuleTimetable(defaultUrl, lane.auth, lane.fields, module.code, debug);
          records.push(...parseScientiaModuleTimetable(html, module));
        } catch (error) {
          console.error(`[scrape-dundee] ${module.code} failed: ${error.message}`);
          failures.push({ module: module.code, error: error.message });
        }
        completed += 1;
        if (onProgress) onProgress({ type: "progress", completed, total: selectedModules.length, module: module.code });
      }
    );

    const data = normaliseRecords(records);
    const knownIds = new Set(data.modules.map((module) => module.id));
    // Modules that got real classes "cover" their own base code(s) — including both halves of
    // a compound co-taught code. A picker-listed module with zero classes of its own is only
    // padded in as an (empty) entry if nothing already covers its base code; otherwise it's a
    // shadow duplicate of a module already represented (see baseModuleCode above).
    const coveredBaseCodes = new Set();
    data.modules.forEach((module) => {
      module.code.split("/").forEach((part) => coveredBaseCodes.add(baseModuleCode(part)));
    });
    selectedModules.forEach((module) => {
      if (knownIds.has(module.id)) return;
      if (coveredBaseCodes.has(baseModuleCode(module.code))) return;
      data.modules.push(module);
    });
    data.modules.sort((a, b) => a.code.localeCompare(b.code));
    data.failures = failures;
    data.source = defaultUrl;
    data.scrapedModules = selectedModules.length;
    data.availableModules = modules.length;
    if (debug) data.debugFiles = [DEBUG_DIR];
    return data;
  } finally {
    cookieFiles.forEach((file) => fs.rm(file, { force: true }, () => {}));
  }
}

module.exports = {
  DEFAULT_DUNDEE_URL,
  fetchText,
  parseTimetablePayload,
  scrapeDundeeTimetable,
  discoverDundeeProgrammes,
  scrapeDundeeProgramme,
  scrapeDundeeProgrammes
};
