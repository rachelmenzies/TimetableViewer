#!/usr/bin/env node
// Run on a schedule by .github/workflows/fetch-timetable.yml. Pulls every module from Dundee
// and writes it to public/sample-data.json, the same static file the app already loads by
// default — GitHub Pages just serves whatever's there, so this file is the entire "backend"
// for the public, read-only deployment. On any failure this exits non-zero WITHOUT touching
// the output file, so a bad run (expired password, Dundee down) never overwrites good data
// with an empty or partial one.

const fs = require("fs");
const path = require("path");
const { scrapeDundeeTimetable, DEFAULT_DUNDEE_URL } = require("../lib/dundee");

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

  const output = { modules: data.modules, classes: data.classes, scrapedAt: data.scrapedAt };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  const failedText = data.failures.length ? `, ${data.failures.length} modules failed` : "";
  console.log(
    `Wrote ${data.classes.length} classes from ${data.scrapedModules}/${data.availableModules} modules${failedText} to ${OUTPUT_PATH}`
  );
}

main().catch((error) => {
  console.error(`Fetch failed: ${error.message}`);
  process.exit(1);
});
