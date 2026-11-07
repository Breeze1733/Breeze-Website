'use strict';

// Set this environment variable when moving the public service to a new host.
const base = new URL(process.env.DIPTYCH_PUBLIC_BASE_URL || 'https://diptych.breeze.qzz.io');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
    base.pathname !== '/' || base.search || base.hash) {
    throw new Error('DIPTYCH_PUBLIC_BASE_URL must be an HTTP(S) origin');
}
const PUBLIC_BASE_URL = base.origin;

function normalizeUploadUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    let url;
    try { url = new URL(value, PUBLIC_BASE_URL); } catch { return value; }
    if (!['http:', 'https:'].includes(url.protocol) ||
        ![base.origin, 'https://breeze.qzz.io'].includes(url.origin) ||
        !/^\/(?:api\/)?uploads\/[^/]+$/i.test(url.pathname)) return value;
    const pathname = url.pathname.replace(/^\/api\/uploads\//i, '/uploads/');
    return `${pathname}${url.search}${url.hash}`;
}

module.exports = { PUBLIC_BASE_URL, normalizeUploadUrl };
