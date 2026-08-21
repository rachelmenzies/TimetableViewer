#!/usr/bin/env node
// Run on a schedule by .github/workflows/fetch-timetable.yml. Pulls every module from Dundee
// and writes it to public/sample-data.json, the same static file the app already loads by
// default — GitHub Pages just serves whatever's there, so this file is the entire "backend"
// for the public, read-only deployment. On any failure this exits non-zero WITHOUT touching
// the output file, so a bad run (expired password, Dundee down) never overwrites good data
// with an empty or partial one.

const fs = require("fs");
const path = require("path");
const {
  scrapeDundeeTimetable,
  discoverDundeeProgrammes,
  scrapeDundeeProgramme,
  DEFAULT_DUNDEE_URL
} = require("../lib/dundee");

const OUTPUT_PATH = path.join(__dirname, "..", "public", "sample-data.json");

async function main() {
  const username = process.env.DUNDEE_USERNAME;
  const password = process.env.DUNDEE_PASSWORD;
  const url = process.env.DUNDEE_URL || DEFAULT_DUNDEE_URL;

  if (!username || !password) {
    throw new Error("DUNDEE_USERNAME and DUNDEE_PASSWORD environment variables are required.");
  }

  console.log(`Fetching all Dundee modules from ${url} ...`);
  const data = await scrapeDundeeTimetable({
    username,
    password,
    url,
    onProgress: (event) => {
      if (event.type === "start") console.log(`Found ${event.total} modules.`);
      if (event.type === "progress" && event.completed % 25 === 0) {
        console.log(`  ${event.completed}/${event.total} (${event.module})`);
      }
    }
  });

  if (!data.classes.length) {
    throw new Error("Scrape returned zero classes — refusing to overwrite the existing data file.");
  }

  // Best-effort: the programme picker's tab id/report format aren't confirmed against the live
  // site (see lib/dundee.js), so this is allowed to fail without losing the module fetch above —
  // the site just won't show a programme list that day.
  let programmes = [];
  try {
    const result = await discoverDundeeProgrammes({ username, password, url });
    programmes = result.programmes;
    console.log(`Found ${programmes.length} programmes.`);
  } catch (error) {
    console.warn(`Programme discovery failed (continuing without it): ${error.message}`);
  }

  // For each programme, record which module ids belong to it — this is what lets the static
  // site's "Select" button work with no backend: it just filters the already-loaded module/class
  // arrays down to these ids instead of asking a server for a fresh scrape. One live request per
  // programme (same cost per item as the module loop above), so a programme's entry is simply
  // left without moduleIds if its own scrape fails; the app falls back to a clear "not available"
  // message for that one programme rather than losing the rest.
  let programmesDone = 0;
  for (const programme of programmes) {
    try {
      const result = await scrapeDundeeProgramme({ username, password, url, programmeCode: programme.code });
      programme.moduleIds = result.modules.map((module) => module.id);
    } catch (error) {
      console.warn(`  ${programme.code} failed (no moduleIds): ${error.message}`);
    }
    programmesDone += 1;
    if (programmesDone % 10 === 0 || programmesDone === programmes.length) {
      console.log(`  programmes ${programmesDone}/${programmes.length}`);
    }
  }

  const output = { modules: data.modules, classes: data.classes, programmes, scrapedAt: data.scrapedAt };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  const failedText = data.failures.length ? `, ${data.failures.length} modules failed` : "";
  const programmesWithModules = programmes.filter((programme) => programme.moduleIds).length;
  console.log(
    `Wrote ${data.classes.length} classes from ${data.scrapedModules}/${data.availableModules} modules${failedText}, ${programmesWithModules}/${programmes.length} programmes with module associations to ${OUTPUT_PATH}`
  );
}

main().catch((error) => {
  console.error(`Fetch failed: ${error.message}`);
  process.exit(1);
});
