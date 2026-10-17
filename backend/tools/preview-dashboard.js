#!/usr/bin/env node
'use strict';
// Local preview only: serves exactly the page and the aggregate endpoint.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createStatsHandler } = require('../analytics/dashboard-route');
const input = path.resolve(process.argv[2] || path.join(__dirname, '../data/moments.json'));
const port = Number(process.argv[3] || 3180);
const handler = createStatsHandler(input);
http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/api/dashboard/stats') return handler(req, res);
    if (!['/', '/dashboard.html'].includes(url.pathname)) { res.writeHead(404); return res.end(); }
    try {
        const page = await fs.readFile(path.join(__dirname, '../../dashboard.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.end(page);
    } catch { res.writeHead(503); res.end('Dashboard unavailable'); }
}).listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}/dashboard.html`));
