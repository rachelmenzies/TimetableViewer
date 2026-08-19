# Dundee Timetable Viewer

A local clash checker for University of Dundee module timetables. It fetches your
modules directly from Dundee's Scientia timetable system, groups them by semester
(SEM1 / SEM2 / SUM), and shows overlapping classes across whichever modules you
select.

This is a **local-only app**: it runs entirely on your own computer. Nothing is
hosted online, and your Dundee credentials never leave your machine — see
[Privacy & security](#privacy--security) below.

## Requirements

- **Node.js** (v16 or later). Check with `node -v`. Get it from
  [nodejs.org](https://nodejs.org/) if you don't have it.
- **curl**, available on your system `PATH`. This is preinstalled on macOS, most
  Linux distributions, and Windows 10+. Check with `curl --version` in a terminal.
  (curl is what actually talks to Dundee — it's the only way to do the NTLM
  authentication Dundee's timetable system requires.)

No other dependencies are needed — this project has no `npm install` step beyond
the placeholder `package.json` (there's nothing to download).

## Setup

1. Copy or clone this folder onto your computer.
2. Open a terminal in the folder.
3. Start the server:

   ```bash
   npm start
   ```

   You should see:

   ```
   Timetable viewer running at http://localhost:3000
   ```

4. Open **http://localhost:3000** in your browser.

To stop the server, go back to the terminal and press `Ctrl+C`.

If port 3000 is already in use on your machine, run it on a different port:

```bash
PORT=3001 npm start
```

(then open `http://localhost:3001` instead).

## Using the app

The page loads with sample data so you can try the clash checker immediately.

### Fetching your real timetable

1. Click **Fetch Dundee** (top right).
2. Enter your Dundee username and password.
   - A bare username (e.g. `abc123`) is automatically tried as `DUNDEE\abc123`.
   - You can also enter `DUNDEE\abc123` or `abc123@dundee.ac.uk` directly.
3. **Source URL** — leave as the default unless Dundee changes their timetable
   URL (it currently includes the academic year, e.g. `Dundee2627`).
4. **Limit modules** — Dundee's module picker lists the *entire university's*
   modules (currently ~1600), not just yours. Fetching all of them can take a
   long time (many minutes) since each one is a separate request. Leave this
   blank to fetch everything, or enter a number to fetch only the first N
   modules — useful for a quick test.
5. **Save raw HTML for inspection** — a debugging option (see
   [Troubleshooting](#troubleshooting) below). Leave unchecked for normal use.
6. Click **Fetch All Modules** and wait. The status line will say "Fetching
   Dundee timetable. This can take a few minutes..." — that's expected, not a
   hang, especially with no limit set.

When it finishes, the status line reports how many classes were found and
whether any modules failed to fetch.

### Viewing and checking clashes

- The **Modules** panel (right) lists every module found, with a search box and
  **All** / **None** selection buttons. Your selection is remembered between
  visits (stored in your browser's local storage).
- The main area shows three separately-scrollable tables — **SEM1**, **SEM2**,
  **SUM** — stacked vertically, each a Monday–Friday grid of your selected
  modules' classes for that semester.
- Overlapping classes are highlighted in red, and a summary of clashes is
  listed above the tables.
- The modules list and the schedule area scroll independently, so you can
  browse one without losing your place in the other.

### Importing data another way

If you already have timetable data as JSON, CSV, ICS, or pasted Scientia
list-view HTML, you can send it to the server's `/api/import` endpoint
directly (there's currently no button for this in the UI). CSV columns can
include:

```csv
module,module name,day,start,end,title,type,location,staff,weeks
CS10001,Example Module,Monday,09:00,10:00,Lecture,Lecture,QMB,,1-11
```

## Privacy & security

- Your Dundee username and password are sent **only** from your browser to
  the local server running on your own machine (`localhost`), and from there
  directly to `timetable.dundee.ac.uk` for that one request. They are never
  written to disk and never sent anywhere else.
- Nothing about this app is hosted online. Running it does not expose
  anything to the internet — `localhost` is only reachable from your own
  computer.
- The **debug** option (see below) does write files to disk locally
  (`debug-output/`). These are for troubleshooting only — delete that folder
  when you're done, and don't share its contents with anyone, since they can
  contain session cookies from your login (passwords are scrubbed from the
  saved trace files, but treat the folder as sensitive regardless).

## Troubleshooting

**"Failed to fetch" partway through a scrape**
Usually means the request is still running — a full, unlimited scrape (~1600
modules) genuinely takes a long time. Try a small **Limit modules** value
first (e.g. 5–20) to confirm everything works before running the full fetch.

**A module fails with "Dundee returned HTTP ..."**
Check the server's terminal output — each failure is logged there with the
module code and the underlying error.

**Nothing happens / scrape immediately fails with a credentials error**
Double-check your username/password. Dundee uses NTLM authentication; if your
account uses a different login format, try entering it as
`DUNDEE\yourusername` explicitly in the Username field.

**Debugging a specific module**
Check **Save raw HTML for inspection**, set **Limit modules** to `1`, and
fetch. This drops two files per attempted module into `debug-output/`:

- `<module>.html` — the raw page Dundee returned.
- `<module>.trace.txt` — the full curl request/response trace (headers,
  status codes, redirects).

Delete `debug-output/` afterwards — see [Privacy & security](#privacy--security).

**`curl: command not found`**
Install curl for your OS (see [Requirements](#requirements)), or make sure it's
on your `PATH`.

**Port 3000 already in use**
Another process is using that port. Either stop it, or run this app on a
different port with `PORT=3001 npm start`.

## How it works (for reference)

- `server.js` is a small Node.js HTTP server with no external dependencies.
  It serves the static frontend in `public/`, and drives `curl` (with
  `--ntlm`) as a subprocess to authenticate against Dundee's Scientia
  timetable system, since Node's built-in HTTP client can't do NTLM auth.
- It replays Dundee's ASP.NET postback flow: switch to the "Modules" tab,
  then for each module, submit a "View Timetable" postback and follow the
  resulting redirect to the actual timetable page, parsing the returned
  list-view HTML into individual class sessions.
- `public/app.js` renders the parsed data into the module list and the
  semester-grouped clash-checker grids, entirely client-side.
