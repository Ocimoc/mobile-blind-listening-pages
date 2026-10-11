"use strict";

// Local phone preview only. Serve the three public page assets, never repository files or learner data.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"]
};
const port = Number(process.argv[2] || 8765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid preview port");

http.createServer((request, response) => {
  const entry = files[new URL(request.url, "http://localhost").pathname];
  if (!entry || request.method !== "GET") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": entry[1],
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(path.join(root, entry[0])).pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log(`Local preview listening on port ${port}`);
});
