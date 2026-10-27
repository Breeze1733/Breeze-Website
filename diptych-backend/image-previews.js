'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const PREVIEW_VERSION = 1;
const ORIGINAL_EXTENSIONS = /\.(?:jpe?g|png|webp|heic|heif|avif|gif|tiff?|bmp)$/i;

function previewDimensions(width, height) {
    if (!(width > 0 && height > 0)) throw new Error('图片尺寸无效');
    const scale = Math.min(1, 1080 / Math.min(width, height),
        Math.sqrt(2000000 / (width * height)), 8192 / Math.max(width, height));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function safeImageName(value) {
    if (typeof value !== 'string' || !value || value.length > 240 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(value) || !ORIGINAL_EXTENSIONS.test(value)) return null;
    return value;
}

function nameFromUrl(value) {
    try {
        const pathname = decodeURIComponent(new URL(String(value), 'http://localhost').pathname);
        if (!/^\/(?:api\/)?uploads\/[^/]+$/.test(pathname)) return null;
        return safeImageName(pathname.split('/').pop());
    } catch { return null; }
}

async function atomicJson(filename, value) {
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
        await fsp.writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
        await fsp.rename(temporary, filename);
    } finally { await fsp.unlink(temporary).catch(() => {}); }
}

// Detect embedded Android Motion Photo MP4 data without changing the original.
async function hasMotionVideo(filename, format) {
    if (format !== 'jpeg') return false;
    let previous = Buffer.alloc(0);
    for await (const chunk of fs.createReadStream(filename, { highWaterMark: 256 * 1024 })) {
        const data = Buffer.concat([previous, chunk]);
        let offset = data.indexOf('ftyp');
        while (offset >= 0) {
            if (offset >= 4 && offset + 8 <= data.length && data.readUInt32BE(offset - 4) >= 8 &&
                /^(?:isom|iso[2-9]|mp4[12]|avc1|qt  |3gp\w|heic|mif1)$/.test(data.toString('ascii', offset + 4, offset + 8))) return true;
            offset = data.indexOf('ftyp', offset + 4);
        }
        previous = data.subarray(Math.max(0, data.length - 15));
    }
    return false;
}

function createImagePreviewStore({ originalsDir, previewsDir, concurrency = 2, logger = console, isOriginalOnly = () => false }) {
    originalsDir = path.resolve(originalsDir);
    previewsDir = path.resolve(previewsDir);
    const relative = path.relative(originalsDir, previewsDir);
    const reverse = path.relative(previewsDir, originalsDir);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) ||
        (!reverse.startsWith(`..${path.sep}`) && !path.isAbsolute(reverse))) {
        throw new Error('原图与预览图目录必须分开，不能互相包含');
    }
    fs.mkdirSync(previewsDir, { recursive: true });
    const jobs = new Map();
    const failures = new Map();
    const queue = [];
    let running = 0;

    function paths(name) {
        if (!safeImageName(name)) throw Object.assign(new Error('图片路径无效'), { status: 400 });
        const id = crypto.createHash('sha256').update(name).digest('hex');
        return {
            original: path.join(originalsDir, name),
            preview: path.join(previewsDir, `${id}-v${PREVIEW_VERSION}.webp`),
            info: path.join(previewsDir, `${id}-v${PREVIEW_VERSION}.json`),
        };
    }

    async function source(name) {
        const files = paths(name);
        const stat = await fsp.lstat(files.original);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('图片不存在'), { status: 404 });
        return { ...files, stat, signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
    }

    async function ready(name) {
        const current = await source(name);
        try {
            const info = JSON.parse(await fsp.readFile(current.info, 'utf8'));
            const previewStat = await fsp.stat(current.preview);
            if (info.source_signature === current.signature && previewStat.size > 0) return { ...current, info };
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return null;
    }

    async function generate(name) {
        const cached = await ready(name);
        if (cached) return cached;
        const current = await source(name);
        const temporary = `${current.preview}.${crypto.randomUUID()}.tmp`;
        try {
            const metadata = await sharp(current.original, { animated: false }).metadata();
            const width = metadata.autoOrient?.width ?? (metadata.orientation >= 5 ? metadata.height : metadata.width);
            const height = metadata.autoOrient?.height ?? (metadata.orientation >= 5 ? metadata.width : metadata.height);
            const dimensions = previewDimensions(width, height);
            const output = await sharp(current.original, { animated: false })
                .rotate().resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 78 }).toFile(temporary);
            const motion = await hasMotionVideo(current.original, metadata.format);
            // A deletion or replacement during generation must not resurrect a stale preview.
            const latest = await source(name);
            if (latest.signature !== current.signature) throw new Error('原图已变化，请重试');
            const info = {
                version: PREVIEW_VERSION, source_signature: current.signature,
                width, height, original_bytes: current.stat.size, is_motion: motion,
                format: metadata.format, preview_width: output.width,
                preview_height: output.height, preview_bytes: output.size,
            };
            await fsp.rename(temporary, current.preview);
            await atomicJson(current.info, info);
            return { ...current, info };
        } finally { await fsp.unlink(temporary).catch(() => {}); }
    }

    function pump() {
        while (running < concurrency && queue.length) {
            const job = queue.shift();
            running++;
            generate(job.name).then(job.resolve, error => {
                if (error.code !== 'ENOENT') failures.set(job.name, { until: Date.now() + 30000, error });
                job.reject(error);
            }).finally(() => { running--; jobs.delete(job.name); pump(); });
        }
    }

    function ensure(name) {
        if (!safeImageName(name)) return Promise.reject(Object.assign(new Error('图片路径无效'), { status: 400 }));
        if (jobs.has(name)) return jobs.get(name);
        const failure = failures.get(name);
        if (failure && failure.until > Date.now()) return Promise.reject(failure.error);
        failures.delete(name);
        const promise = new Promise((resolve, reject) => { queue.push({ name, resolve, reject }); });
        jobs.set(name, promise);
        pump();
        return promise;
    }

    function warm(name) {
        ensure(name).catch(error => logger.warn('预览生成未完成，原图仍保留:', name, error.message));
    }

    async function remove(name) {
        const files = paths(name);
        // Delete the source first; a running job must observe its disappearance.
        await fsp.unlink(files.original).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (jobs.has(name)) await jobs.get(name).catch(() => {});
        await Promise.all([files.preview, files.info].map(file => fsp.unlink(file).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        })));
        failures.delete(name);
    }

    async function middleware(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let name;
        try { name = safeImageName(decodeURIComponent(req.path.slice(1))); } catch { /* Invalid escape. */ }
        if (!name) return res.status(404).json({ ok: false, error: '图片不存在' });
        const variant = req.query.variant;
        if (variant !== undefined && !['preview', 'info', 'original'].includes(variant)) {
            return res.status(400).json({ ok: false, error: '图片版本无效' });
        }
        res.set('Vary', 'Authorization');
        res.set('Cache-Control', 'private, max-age=0, must-revalidate');
        try {
            const original = await source(name);
            if (variant && variant !== 'original' && await isOriginalOnly(name)) {
                res.set('Cache-Control', 'private, max-age=0, must-revalidate, no-transform');
                res.set('X-Original-Size', String(original.stat.size));
                res.set('X-Image-Original-Only', '1');
                if (variant === 'info') return res.json({ ok: true, data: {
                    original_bytes: original.stat.size, width: 0, height: 0, is_motion: false, original_only: true,
                } });
                // Older clients require this response label, but receive the original bytes.
                res.set('X-Image-Variant', 'preview');
                return res.sendFile(original.original, { dotfiles: 'allow' }, error => { if (error) next(error); });
            }
            if (!variant || variant === 'original') {
                res.set('Cache-Control', 'private, max-age=0, must-revalidate, no-transform');
                res.set('X-Image-Variant', 'original');
                res.set('X-Original-Size', String(original.stat.size));
                return res.sendFile(original.original, { dotfiles: 'allow' }, error => { if (error) next(error); });
            }
            const cached = await ready(name);
            if (!cached) {
                const failure = failures.get(name);
                if (failure && failure.until > Date.now()) {
                    return res.status(503).json({ ok: false, error: '预览生成失败，可重试或查看原图' });
                }
                warm(name);
                res.set('Cache-Control', 'no-store');
                res.set('Retry-After', '1');
                res.set('X-Image-State', 'preparing');
                return res.status(202).json({ ok: true, data: { state: 'preparing' } });
            }
            const { info } = cached;
            res.set('X-Original-Size', String(info.original_bytes));
            res.set('X-Image-Motion', info.is_motion ? '1' : '0');
            res.set('X-Image-Width', String(info.width));
            res.set('X-Image-Height', String(info.height));
            res.set('X-Preview-Version', String(PREVIEW_VERSION));
            if (variant === 'info') return res.json({ ok: true, data: info });
            res.set('X-Image-Variant', 'preview');
            res.type('webp');
            return res.sendFile(cached.preview, { dotfiles: 'allow' }, error => { if (error) next(error); });
        } catch (error) {
            if (error.code === 'ENOENT' || error.status === 404) return res.status(404).json({ ok: false, error: '图片不存在' });
            next(error);
        }
    }

    return { middleware, warm, ensure, ready, remove, paths };
}

module.exports = { createImagePreviewStore, previewDimensions, safeImageName, nameFromUrl, PREVIEW_VERSION };
