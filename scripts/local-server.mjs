// Minimal static file server, zero dependencies. Serves the repo root so
// both pages/ (the Playwright-driven harness) and site/ (the standalone
// visitor self-test) are reachable over http://, which real ES module
// dynamic import() + Web Worker + WASM loading all require (file:// breaks
// at least one of those in Chromium).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function createServer() {
  return http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let filePath = path.join(ROOT, urlPath === '/' ? '/pages/harness.html' : urlPath);
      // prevent path traversal outside the repo
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath);
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        // Harness scaffolding itself is never meant to be measured as
        // "shippable weight" and must not be served stale between rows.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end('server error: ' + err.message);
    }
  });
}

export function startServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({ server, port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}` });
    });
  });
}

// Allow `node scripts/local-server.mjs` standalone for manual poking.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const { port, baseUrl } = await startServer(8420);
  console.log(`shipgauge local server: ${baseUrl}  (harness: ${baseUrl}/pages/harness.html , self-test: ${baseUrl}/site/index.html)`);
}
