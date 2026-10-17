'use strict';

const fs = require('node:fs/promises');
const { analyzeMoments } = require('./moments-analytics');

// A single in-flight read prevents parallel refreshes from repeatedly parsing the file.
function createStatsReader(momentsFile, { cacheMs = 0, now = Date.now } = {}) {
    let cached = null, cachedKey = null, cachedAt = 0, pending = null;
    const signature = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    async function read() {
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = await fs.stat(momentsFile);
            const key = signature(before);
            const time = now();
            if (cached && key === cachedKey && time - cachedAt < cacheMs) return cached;
            const source = await fs.readFile(momentsFile, 'utf8');
            const after = await fs.stat(momentsFile);
            if (key !== signature(after)) continue;
            let parsed;
            try { parsed = JSON.parse(source.replace(/^\uFEFF/, '')); }
            catch {
                if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 25)); continue; }
                throw new Error('INVALID_MOMENTS_JSON');
            }
            const report = analyzeMoments(parsed, { now: time });
            cached = report; cachedKey = key; cachedAt = time;
            return report;
        }
        throw new Error('MOMENTS_FILE_CHANGING');
    }
    return function getStats() {
        if (!pending) pending = read().finally(() => { pending = null; });
        return pending;
    };
}

function createStatsHandler(momentsFile, options) {
    const read = createStatsReader(momentsFile, options);
    return async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        try { res.end(JSON.stringify({ ok: true, data: await read() })); }
        catch (error) {
            res.statusCode = 503;
            // Never return parser errors, file paths, or record fragments.
            res.end(JSON.stringify({ ok: false, error: error.code === 'ENOENT' ? '统计数据文件不存在，请检查后端路径。' : '统计暂不可用，请检查数据格式或稍后重试。' }));
        }
    };
}

function installDashboardStats({ registerRoute, momentsFile }) {
    registerRoute('get', '/dashboard/stats', createStatsHandler(momentsFile));
}

module.exports = { installDashboardStats, createStatsReader, createStatsHandler };
