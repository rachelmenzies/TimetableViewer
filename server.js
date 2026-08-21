const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const dundee = require("./lib/dundee");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 6_000_000) {
        reject(new Error("Import is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(contents);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && parsed.pathname === "/api/scrape") {
      const target = parsed.searchParams.get("url") || dundee.DEFAULT_DUNDEE_URL;
      const targetUrl = new URL(target, dundee.DEFAULT_DUNDEE_URL);
      if (targetUrl.hostname !== "timetable.dundee.ac.uk") {
        sendJson(res, 400, { error: "Only timetable.dundee.ac.uk URLs can be fetched." });
        return;
      }

      const response = await dundee.fetchText(targetUrl.toString());
      if (response.statusCode === 401 || /401\s*-\s*Unauthorized/i.test(response.body)) {
        sendJson(res, 401, {
          error:
            "Dundee's timetable page requires university login, so this local app cannot scrape it anonymously. Open the timetable in your browser, export/paste the list or calendar data, then import it here."
        });
        return;
      }

      sendJson(res, 200, dundee.parseTimetablePayload(response.body));
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/import") {
      const body = await readBody(req);
      sendJson(res, 200, dundee.parseTimetablePayload(body));
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/scrape-dundee") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const moduleCodes = Array.isArray(payload.moduleCodes) ? payload.moduleCodes : undefined;
      console.log(
        `[scrape-dundee] starting: limit=${payload.limit ?? "(none)"} modules=${
          moduleCodes ? moduleCodes.length : "(all)"
        } debug=${Boolean(payload.debug)} url=${payload.url || dundee.DEFAULT_DUNDEE_URL}`
      );

      // Streamed as newline-delimited JSON rather than one final response body, so the client
      // can render a real fill-as-you-go progress bar across the (often slow, one-request-per-
      // module) scrape instead of an indeterminate spinner. Once headers are sent, any failure
      // must be reported as a "type":"error" line here — throwing would hit the outer handler's
      // catch, which calls res.writeHead again and crashes with "headers already sent".
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
      const send = (event) => res.write(`${JSON.stringify(event)}\n`);

      try {
        const data = await dundee.scrapeDundeeTimetable({
          username: payload.username,
          password: payload.password,
          url: payload.url || dundee.DEFAULT_DUNDEE_URL,
          limit: payload.limit,
          debug: payload.debug,
          moduleCodes,
          onProgress: send
        });
        console.log(
          `[scrape-dundee] done: ${data.classes.length} classes from ${data.scrapedModules}/${data.availableModules} modules, ${data.failures.length} failures`
        );
        send({ type: "done", data });
      } catch (error) {
        console.error(`[scrape-dundee] failed: ${error.message}`);
        send({ type: "error", error: error.message || "Timetable fetch failed." });
      } finally {
        res.end();
      }
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/dundee-programmes") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      console.log(`[dundee-programmes] discovering programmes url=${payload.url || dundee.DEFAULT_DUNDEE_URL}`);
      const data = await dundee.discoverDundeeProgrammes({
        username: payload.username,
        password: payload.password,
        url: payload.url || dundee.DEFAULT_DUNDEE_URL
      });
      console.log(`[dundee-programmes] found ${data.programmes.length} programmes`);
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/scrape-dundee-programme") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      console.log(
        `[scrape-dundee-programme] programme=${payload.programmeCode} debug=${Boolean(payload.debug)} url=${
          payload.url || dundee.DEFAULT_DUNDEE_URL
        }`
      );
      const data = await dundee.scrapeDundeeProgramme({
        username: payload.username,
        password: payload.password,
        url: payload.url || dundee.DEFAULT_DUNDEE_URL,
        programmeCode: payload.programmeCode,
        debug: payload.debug
      });
      console.log(`[scrape-dundee-programme] done: ${data.classes.length} classes, ${data.modules.length} modules`);
      sendJson(res, 200, data);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error." });
  }
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception (server kept running):", error);
});
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection (server kept running):", error);
});

server.listen(PORT, () => {
  console.log(`Timetable viewer running at http://localhost:${PORT}`);
});
