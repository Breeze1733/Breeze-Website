'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');

const TASK_LIFETIME_MS = 12 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function requestError(status, message) {
    return Object.assign(new Error(message), { status });
}

function installUploadRoutes({ registerRoute, uploadsDir, chunksDir, ok, fail }) {
    fs.mkdirSync(chunksDir, { recursive: true });
    const pendingTasks = new Map();
    const receiveChunk = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 }
    }).single('file');

    function taskFor(req) {
        const uploadId = req.body?.upload_id ?? req.query?.upload_id;
        if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(uploadId)) {
            throw requestError(400, 'upload_id 格式无效');
        }
        // A partner cannot overwrite, merge or abort the other user's task.
        const key = `${req.auth.user_id}_${uploadId}`;
        return { key, dir: path.join(chunksDir, key), owner: req.auth.user_id, uploadId };
    }

    function chunkCount(req) {
        const value = req.body?.total_chunks ?? req.query?.total_chunks;
        const count = Number(value);
        if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(count) || count < 1 || count > 10000) {
            throw requestError(400, 'total_chunks 格式无效');
        }
        return count;
    }

    async function serialized(task, action) {
        const previous = pendingTasks.get(task.key) || Promise.resolve();
        const current = previous.catch(() => {}).then(action);
        pendingTasks.set(task.key, current);
        try {
            return await current;
        } finally {
            if (pendingTasks.get(task.key) === current) pendingTasks.delete(task.key);
        }
    }

    function readTask(task) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(task.dir, 'task.json'), 'utf8'));
            if (record.owner !== task.owner || record.upload_id !== task.uploadId ||
                !['pending', 'completed', 'aborted'].includes(record.state)) {
                throw new Error('Invalid task metadata');
            }
            return record;
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
    }

    function saveTask(task, record) {
        fs.mkdirSync(task.dir, { recursive: true });
        const temporaryPath = path.join(task.dir, `.${randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporaryPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporaryPath, path.join(task.dir, 'task.json'));
        } finally {
            fs.rmSync(temporaryPath, { force: true });
        }
    }

    function newTask(task, count) {
        return { owner: task.owner, upload_id: task.uploadId, total_chunks: count, state: 'pending' };
    }

    function requireCount(record, count) {
        if (record.state === 'aborted') throw requestError(410, '分片任务已取消，请重新上传');
        if (record.total_chunks !== count) throw requestError(409, '分片数量与原任务不一致');
    }

    function completedUrl(record) {
        if (!record.final_name || !/^[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(record.final_name)) {
            throw new Error('Invalid completed task filename');
        }
        if (!fs.existsSync(path.join(uploadsDir, record.final_name))) {
            throw requestError(410, '已上传图片已被删除，请重新上传');
        }
        return `https://breeze.qzz.io/api/uploads/${record.final_name}`;
    }

    async function removeChunkFiles(task) {
        const entries = await fs.promises.readdir(task.dir);
        await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(name =>
            fs.promises.rm(path.join(task.dir, name), { force: true })));
    }

    async function respond(res, action) {
        try { return ok(res, await action()); }
        catch (err) {
            if (!err.status) console.error('上传任务失败:', err);
            return fail(res, err.status || 500, err.status ? err.message : '上传任务处理失败，请重试');
        }
    }

    registerRoute('post', '/upload/chunk', (req, res) => {
        receiveChunk(req, res, err => {
            if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? '分片大小超过限制' : '分片数据格式无效');
            return respond(res, async () => {
                if (!req.file) throw requestError(400, '分片数据不能为空');
                const task = taskFor(req);
                const count = chunkCount(req);
                const rawIndex = req.body?.chunk_index ?? req.query?.chunk_index;
                const index = Number(rawIndex);
                if (!/^[0-9]+$/.test(String(rawIndex)) || !Number.isSafeInteger(index) || index < 0 || index >= count) {
                    throw requestError(400, 'chunk_index 格式无效');
                }
                return serialized(task, async () => {
                    const record = readTask(task) || newTask(task, count);
                    requireCount(record, count);
                    if (record.state === 'completed') completedUrl(record);
                    else {
                        saveTask(task, record);
                        const temporaryPath = path.join(task.dir, `.${randomUUID()}.tmp`);
                        try {
                            await fs.promises.writeFile(temporaryPath, req.file.buffer, { flag: 'wx', mode: 0o600 });
                            await fs.promises.rename(temporaryPath, path.join(task.dir, String(index)));
                            saveTask(task, record);
                        } finally {
                            await fs.promises.rm(temporaryPath, { force: true });
                        }
                    }
                    return { upload_id: task.uploadId, chunk_index: index, total_chunks: count };
                });
            });
        });
    });

    registerRoute('post', '/upload/merge', (req, res) => respond(res, async () => {
        const task = taskFor(req);
        const count = chunkCount(req);
        return serialized(task, async () => {
            const record = readTask(task);
            if (!record) throw requestError(404, '分片任务不存在或已过期');
            requireCount(record, count);
            if (record.state === 'completed') return { url: completedUrl(record) };

            // A restart after publishing the file but before recording completion is recoverable.
            if (record.final_name && fs.existsSync(path.join(uploadsDir, record.final_name))) {
                record.state = 'completed';
                saveTask(task, record);
                await removeChunkFiles(task);
                return { url: completedUrl(record) };
            }
            for (let index = 0; index < count; index++) {
                if (!fs.existsSync(path.join(task.dir, String(index)))) {
                    throw requestError(400, `分片不完整，缺少第 ${index} 片`);
                }
            }
            if (!record.final_name) {
                const rawExt = path.extname(typeof req.body.filename === 'string' ? req.body.filename : '').toLowerCase();
                record.final_name = `${randomUUID()}${IMAGE_EXTENSIONS.has(rawExt) ? rawExt : '.jpg'}`;
                saveTask(task, record);
            }
            const finalPath = path.join(uploadsDir, record.final_name);
            const temporaryPath = `${finalPath}.part`;
            try {
                async function* contents() {
                    for (let index = 0; index < count; index++) {
                        yield* fs.createReadStream(path.join(task.dir, String(index)));
                    }
                }
                // pipeline installs error handlers immediately and respects the destination's backpressure.
                await pipeline(Readable.from(contents()), fs.createWriteStream(temporaryPath, { mode: 0o600 }));
                await fs.promises.rename(temporaryPath, finalPath);
                record.state = 'completed';
                saveTask(task, record);
            } finally {
                await fs.promises.rm(temporaryPath, { force: true });
            }
            // Retain the small completion record so a lost response or concurrent retry returns the same URL.
            await removeChunkFiles(task);
            return { url: completedUrl(record) };
        });
    }));

    registerRoute('post', '/upload/abort', (req, res) => respond(res, async () => {
        const task = taskFor(req);
        return serialized(task, async () => {
            const record = readTask(task) || newTask(task, null);
            if (record.state !== 'completed') record.state = 'aborted';
            // Keep a cancellation marker too: a slow chunk arriving after abort cannot recreate the task.
            saveTask(task, record);
            await removeChunkFiles(task);
            return { message: '分片已清理' };
        });
    }));

    async function cleanExpiredChunks() {
        try {
            const entries = await fs.promises.readdir(chunksDir, { withFileTypes: true });
            await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => {
                const task = { key: entry.name, dir: path.join(chunksDir, entry.name) };
                return serialized(task, async () => {
                    const stats = await fs.promises.stat(task.dir).catch(err => {
                        if (err.code !== 'ENOENT') throw err;
                    });
                    if (stats && Date.now() - stats.mtimeMs > TASK_LIFETIME_MS) {
                        await fs.promises.rm(task.dir, { recursive: true, force: true });
                    }
                });
            }));
        } catch (err) { console.error('清理过期分片失败:', err); }
    }
    setInterval(cleanExpiredChunks, 6 * 60 * 60 * 1000).unref();
    cleanExpiredChunks();
}

module.exports = { installUploadRoutes };
