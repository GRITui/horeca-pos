// Local Vercel-ish server: serves a static directory plus fetch-style
// (Request => Response) serverless functions from an app's api/ directory.
// Usage: node --import ./register-loader.mjs serve.mjs <appRoot> <staticDir> <port>
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { pathToFileURL } from "node:url";

const [appRoot, staticDir, portArg] = process.argv.slice(2);
const port = Number(portArg);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const handlers = new Map();
async function loadHandler(name) {
  if (!/^[\w-]+$/.test(name)) return null;
  if (handlers.has(name)) return handlers.get(name);
  try {
    const mod = await import(pathToFileURL(join(appRoot, "api", `${name}.js`)).href);
    handlers.set(name, mod.default ?? null);
    return mod.default ?? null;
  } catch (err) {
    console.error(`[shim] failed to load api/${name}.js:`, err.message);
    handlers.set(name, null);
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    const apiMatch = url.pathname.match(/^\/api\/([\w-]+)\/?$/);
    if (apiMatch) {
      const handler = await loadHandler(apiMatch[1]);
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `no such function: ${apiMatch[1]}` }));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }

    // static
    let filePath = normalize(join(staticDir, url.pathname === "/" ? "index.html" : url.pathname));
    if (!filePath.startsWith(normalize(staticDir))) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) filePath = join(filePath, "index.html");
    } catch { /* fall through to 404 read */ }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      return res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
  } catch (err) {
    console.error("[shim] request error:", err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

server.listen(port, () => console.log(`[shim] ${appRoot} on http://localhost:${port}`));
