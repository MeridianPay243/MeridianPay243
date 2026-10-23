const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { handler } = require('./netlify/functions/api');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  // Route API & Webhook requests to the Netlify Function handler
  if (pathname.startsWith('/api/') || pathname.startsWith('/.netlify/functions/api') || pathname === '/webhook/checkbook') {
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(bodyChunks).toString('utf8');
      const event = {
        httpMethod: req.method,
        path: pathname === '/webhook/checkbook' ? '/api/webhook/checkbook' : pathname,
        queryStringParameters: parsed.query || {},
        headers: req.headers || {},
        body: rawBody
      };
      try {
        const result = await handler(event);
        res.writeHead(result.statusCode || 200, result.headers || { 'Content-Type': 'application/json' });
        res.end(result.body || '');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Static page routing matching netlify.toml redirects
  let filePath = pathname;
  if (pathname === '/' || pathname === '/verify') filePath = '/index.html';
  else if (pathname === '/admin') filePath = '/admin.html';

  const absPath = path.join(PUBLIC_DIR, filePath);
  if (absPath.startsWith(PUBLIC_DIR) && fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(absPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Netlify app live at http://0.0.0.0:${PORT}`);
});
