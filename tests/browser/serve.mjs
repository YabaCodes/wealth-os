import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const host = "127.0.0.1";
const port = 4173;
const server = createServer(async (req, res) => {
  let file;
  try {
    const rawPath = decodeURIComponent(new URL(req.url, `http://${host}:${port}`).pathname);
    file = resolve(root, "." + (rawPath === "/" ? "/index.html" : rawPath));
    if (!file.startsWith(root + sep)) throw new Error("Invalid path");
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    const bytes = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(bytes);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
});
server.listen(port, host, () => console.log(`Wealth OS browser test server http://${host}:${port}`));
