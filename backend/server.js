const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { installAuth } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.set('trust proxy', 'loopback');

app.use(cors());
app.use(express.json({ limit: '1gb' }));

app.use((req, res, next) => {
    if (/^\/api(?=\/|\?|$)/i.test(req.url)) {
        req.url = req.url.slice(4);
        if (!req.url.startsWith('/')) req.url = '/' + req.url;
    }
    next();
});

function registerRoute(method, routePath, ...handlers) {
    app[method](routePath, ...handlers);
}

function ok(res, data = {}) {
    return res.json({ ok: true, data });
}

function fail(res, status, error) {
    return res.status(status).json({ ok: false, error });
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const usersFile = path.join(dataDir, 'users.json');
const momentsFile = path.join(dataDir, 'moments.json');
const notificationsFile = path.join(dataDir, 'notifications.json');
installAuth({ app, registerRoute, authFile: process.env.AUTH_CONFIG_FILE || path.join(dataDir, 'auth.json') });

function requireSessionAuthor(req, res, claimedId) {
    if (claimedId !== undefined && claimedId !== req.auth.user_id) {
        fail(res, 403, '不能以其他用户身份操作');
        return false;
    }
    return true;
}

function ensureDataFiles() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(usersFile)) {
        fs.writeFileSync(usersFile, '[]', 'utf8');
    }
    if (!fs.existsSync(momentsFile)) {
        fs.writeFileSync(momentsFile, '[]', 'utf8');
    }
    if (!fs.existsSync(notificationsFile)) {
        fs.writeFileSync(notificationsFile, '[]', 'utf8');
    }
}

function readJsonArray(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function writeJsonArray(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensurePresetUsers() {
    const users = readJsonArray(usersFile);
    let created = false;

    if (!users.some(u => u.uid === 'A')) {
        users.push({ uid: 'A', nickname: '用户A', partner_uid: 'B', avatar_url: '' });
        created = true;
    }
    if (!users.some(u => u.uid === 'B')) {
        users.push({ uid: 'B', nickname: '用户B', partner_uid: 'A', avatar_url: '' });
        created = true;
    }

    if (created) {
        writeJsonArray(usersFile, users);
    }

    return created;
}

function isValidDateStr(dateStr) {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function sanitizeUidList(authorIds) {
    return authorIds
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function makeMomentId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function nowIsoUtc8() {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+08:00`;
}

function toIsoUtc8(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return nowIsoUtc8();
    }

    const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}.${pad(shifted.getUTCMilliseconds(), 3)}+08:00`;
}

function normalizeImageUrls(moment) {
    // 新格式：image_urls 数组（第一张为封面）
    if (Array.isArray(moment.image_urls)) {
        return moment.image_urls
            .filter(u => typeof u === 'string' && u)
            .map(normalizeUploadUrl);
    }
    // 旧格式迁移：self_image_url / partner_image_url → image_urls
    return [moment.self_image_url, moment.partner_image_url]
        .filter(u => typeof u === 'string' && u)
        .map(normalizeUploadUrl);
}

function normalizeMomentRecord(moment) {
    const createdAt = moment.created_at ? toIsoUtc8(moment.created_at) : nowIsoUtc8();
    const updatedAt = moment.updated_at ? toIsoUtc8(moment.updated_at) : createdAt;

    const record = {
        ...moment,
        image_urls: normalizeImageUrls(moment),
        mood: normalizeMood(moment.mood),
        comments: normalizeComments(moment.comments, moment.author_id),
        created_at: createdAt,
        updated_at: updatedAt
    };
    delete record.self_image_url;
    delete record.partner_image_url;
    return record;
}

function getPartnerUid(authorId) {
    if (authorId === 'A') return 'B';
    if (authorId === 'B') return 'A';
    return '';
}

function pushNotification(recipientId, notification) {
    if (!recipientId) return;
    const notifications = readJsonArray(notificationsFile);
    // 防刷屏覆盖机制：如果是日记动态(moment)，检查队列中是否已有同一天给该接收者的未消费通知
    if (notification.type === 'moment') {
        const existingIdx = notifications.findIndex(n =>
            n.recipient_id === recipientId &&
            n.type === 'moment' &&
            n.date_str === notification.date_str
        );
        if (existingIdx !== -1) {
            notifications[existingIdx] = {
                ...notifications[existingIdx],
                ...notification,
                id: notifications[existingIdx].id
            };
            writeJsonArray(notificationsFile, notifications);
            return;
        }
    }
    notifications.push(notification);
    writeJsonArray(notificationsFile, notifications);
}

function migrateMomentRecords() {
    const moments = readJsonArray(momentsFile);
    const normalized = moments.map(normalizeMomentRecord);
    const changed = JSON.stringify(moments) !== JSON.stringify(normalized);

    if (changed) {
        writeJsonArray(momentsFile, normalized);
    }
}

function normalizeUploadUrl(value) {
    if (typeof value !== 'string' || !value) {
        return value;
    }
    // 新规范：统一走 /api/uploads/ 路径
    if (value.startsWith('https://breeze.qzz.io/api/uploads/')) {
        return value;
    }
    // 旧格式兼容：/uploads/ → /api/uploads/
    if (value.startsWith('https://breeze.qzz.io/uploads/')) {
        return value.replace('https://breeze.qzz.io/uploads/', 'https://breeze.qzz.io/api/uploads/');
    }
    if (value.startsWith('/api/uploads/')) {
        return value;
    }
    if (value.startsWith('/uploads/')) {
        return value.replace('/uploads/', '/api/uploads/');
    }
    return value;
}

function normalizeMood(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const mood = Number(value);
    if (!Number.isInteger(mood) || mood < 1 || mood > 10) {
        return null;
    }

    return mood;
}

function normalizeComments(value, momentAuthorId) {
    if (Array.isArray(value)) {
        return value.map(item => normalizeComment(item, momentAuthorId));
    }

    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed.map(item => normalizeComment(item, momentAuthorId));
            }
        } catch {
            return [];
        }
    }

    return [];
}

function normalizeComment(item, momentAuthorId) {
    // 兼容旧格式：纯字符串 → 转为新结构，作者设为对方
    if (typeof item === 'string') {
        return {
            id: makeMomentId(),
            author_id: getPartnerUid(momentAuthorId),
            content: item,
            reply_to: null,
            created_at: nowIsoUtc8()
        };
    }
    // 新格式：对象
    if (item && typeof item === 'object') {
        return {
            id: item.id || makeMomentId(),
            author_id: String(item.author_id || getPartnerUid(momentAuthorId)),
            content: String(item.content || ''),
            reply_to: item.reply_to || null,
            created_at: item.created_at ? toIsoUtc8(item.created_at) : nowIsoUtc8()
        };
    }
    return {
        id: makeMomentId(),
        author_id: getPartnerUid(momentAuthorId),
        content: String(item),
        reply_to: null,
        created_at: nowIsoUtc8()
    };
}

ensureDataFiles();
ensurePresetUsers();
migrateMomentRecords();

// Dashboard statistics: local aggregates only.
require('./analytics/dashboard-route').installDashboardStats({ registerRoute, momentsFile });

// ─── 图片上传配置 ───
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'));
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const chunksDir = path.resolve(process.env.CHUNKS_DIR || path.join(__dirname, 'chunks_temp'));
if (!fs.existsSync(chunksDir)) {
    fs.mkdirSync(chunksDir, { recursive: true });
}

const chunkUpload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            const uploadId = (req.body && req.body.upload_id)
                ? String(req.body.upload_id).replace(/[^a-zA-Z0-9_-]/g, '')
                : ((req.query && req.query.upload_id) ? String(req.query.upload_id).replace(/[^a-zA-Z0-9_-]/g, '') : 'default');
            const taskDir = path.join(chunksDir, uploadId);
            if (!fs.existsSync(taskDir)) {
                fs.mkdirSync(taskDir, { recursive: true });
            }
            cb(null, taskDir);
        },
        filename: (req, _file, cb) => {
            const chunkIndex = (req.body && req.body.chunk_index !== undefined)
                ? String(req.body.chunk_index).replace(/[^0-9]/g, '')
                : ((req.query && req.query.chunk_index !== undefined) ? String(req.query.chunk_index).replace(/[^0-9]/g, '') : '0');
            cb(null, chunkIndex);
        }
    }),
    limits: {
        fileSize: 15 * 1024 * 1024
    }
});

// 分片上传接口（完全采用分片切片上传，单片 1MB 彻底规避网关超时）
registerRoute('post', '/upload/chunk', chunkUpload.single('file'), (req, res) => {
    if (!req.file) {
        return fail(res, 400, '分片数据不能为空');
    }
    const { upload_id, chunk_index, total_chunks } = req.body || {};
    return ok(res, {
        upload_id,
        chunk_index: Number(chunk_index),
        total_chunks: Number(total_chunks)
    });
});

// 合并分片接口
registerRoute('post', '/upload/merge', async (req, res) => {
    const { upload_id, filename, total_chunks } = req.body || {};
    if (!upload_id || total_chunks === undefined) {
        return fail(res, 400, '参数不完整 (upload_id 与 total_chunks 必填)');
    }
    const safeUploadId = String(upload_id).replace(/[^a-zA-Z0-9_-]/g, '');
    const taskDir = path.join(chunksDir, safeUploadId);
    if (!fs.existsSync(taskDir)) {
        return fail(res, 404, '分片任务不存在或已过期');
    }

    const count = Number(total_chunks);
    if (isNaN(count) || count <= 0) {
        return fail(res, 400, 'total_chunks 格式无效');
    }

    // 校验所有切片是否全部到齐
    for (let i = 0; i < count; i++) {
        const chunkPath = path.join(taskDir, String(i));
        if (!fs.existsSync(chunkPath)) {
            return fail(res, 400, '分片不完整，缺少第 ' + i + ' 片');
        }
    }

    // 生成正式图片文件名
    const rawExt = path.extname(filename || '').toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = allowed.includes(rawExt) ? rawExt : '.jpg';
    const finalName = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
    const finalPath = path.join(uploadsDir, finalName);

    try {
        const writeStream = fs.createWriteStream(finalPath);
        for (let i = 0; i < count; i++) {
            const chunkPath = path.join(taskDir, String(i));
            const buf = await fs.promises.readFile(chunkPath);
            writeStream.write(buf);
        }
        await new Promise((resolve, reject) => {
            writeStream.end(resolve);
            writeStream.on('error', reject);
        });

        // 异步安全清理该任务的临时分片目录
        fs.rm(taskDir, { recursive: true, force: true }, () => {});

        const url = `https://breeze.qzz.io/api/uploads/${finalName}`;
        return ok(res, { url });
    } catch (err) {
        console.error('合并切片失败:', err);
        return fail(res, 500, `文件合并失败: ${err.message}`);
    }
});

// 取消分片上传并立即清理临时分片
registerRoute('post', '/upload/abort', (req, res) => {
    const { upload_id } = req.body || {};
    if (!upload_id) {
        return fail(res, 400, 'upload_id 不能为空');
    }
    const safeUploadId = String(upload_id).replace(/[^a-zA-Z0-9_-]/g, '');
    const taskDir = path.join(chunksDir, safeUploadId);
    if (fs.existsSync(taskDir)) {
        fs.rm(taskDir, { recursive: true, force: true }, () => {});
    }
    return ok(res, { message: '分片已清理' });
});

// 定时清理超过 12 小时未合并的孤儿分片目录（每 6 小时检查一次）
function cleanExpiredChunks() {
    if (!fs.existsSync(chunksDir)) return;
    const now = Date.now();
    const expireMs = 12 * 60 * 60 * 1000;
    fs.readdir(chunksDir, { withFileTypes: true }, (err, entries) => {
        if (err || !entries) return;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const dirPath = path.join(chunksDir, entry.name);
                fs.stat(dirPath, (statErr, stats) => {
                    if (!statErr && now - stats.mtimeMs > expireMs) {
                        fs.rm(dirPath, { recursive: true, force: true }, () => {});
                    }
                });
            }
        }
    });
}
setInterval(cleanExpiredChunks, 6 * 60 * 60 * 1000).unref();
cleanExpiredChunks();

// 删除图片
registerRoute('post', '/upload/delete', (req, res) => {
    const { url } = req.body || {};
    if (!url) return fail(res, 400, 'url 不能为空');
    const imageName = value => {
        try { return new URL(String(value), 'http://localhost').pathname.split('/').pop(); }
        catch { return ''; }
    };
    const targetName = imageName(url);
    if (!targetName || !/^[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(targetName)) {
        return fail(res, 400, '图片路径无效');
    }
    const usedByOtherProfile = readJsonArray(usersFile).some(user =>
        user.uid !== req.auth.user_id &&
        [user.avatar_url, user.wallpaper_diary_url, user.wallpaper_topic_url].some(value => imageName(value) === targetName));
    const usedByOtherDiary = readJsonArray(momentsFile).some(moment =>
        moment.author_id !== req.auth.user_id && normalizeImageUrls(moment).some(value => imageName(value) === targetName));
    if (usedByOtherProfile || usedByOtherDiary) return fail(res, 403, '图片仍被另一用户引用');
    try {
        const filePath = path.join(uploadsDir, targetName);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) { /* 删失败不阻塞 */ }
    return ok(res);
});

// 静态文件服务 —— 让 /uploads/xxx.jpg 能直接访问
app.use('/uploads', express.static(uploadsDir, {
    setHeaders(res) {
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        res.setHeader('Vary', 'Authorization');
    }
}));

// --- 云剪切板 API ---
const clipsDir = path.resolve(process.env.CLIPS_DIR || path.join(__dirname, 'clips'));
if (!fs.existsSync(clipsDir)) {
    fs.mkdirSync(clipsDir);
}

// 获取所有剪切板内容
registerRoute('get', '/clips', (req, res) => {
    fs.readdir(clipsDir, (err, files) => {
        if (err) return res.status(500).send('读取剪切板失败');
        const clips = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(clipsDir, f), 'utf8'));
                    return { id: f.replace('.json', ''), ...data };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.createdAt - a.createdAt);
        res.json(clips);
    });
});

// 保存新的剪切板内容
registerRoute('post', '/clips', (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).send('内容不能为空');
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const clip = {
        content: content.trim(),
        preview: content.trim().slice(0, 100),
        createdAt: Date.now()
    };
    fs.writeFileSync(path.join(clipsDir, `${id}.json`), JSON.stringify(clip));
    res.send({ message: '保存成功', id });
});

// 更新剪切板内容
registerRoute('put', '/clips/:id', (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).send('内容不能为空');
    const filePath = path.join(clipsDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).send('内容不存在');
    const clip = {
        content: content.trim(),
        preview: content.trim().slice(0, 100),
        createdAt: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(clip));
    res.send({ message: '更新成功' });
});

// 删除剪切板内容
registerRoute('delete', '/clips/:id', (req, res) => {
    const filePath = path.join(clipsDir, `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).send('内容不存在');
    fs.unlink(filePath, (err) => {
        if (err) return res.status(500).send('删除失败');
        res.send({ message: '已删除' });
    });
});

// 扫描 audio 文件夹返回音乐列表
const audioDir = path.resolve(process.env.AUDIO_DIR || path.join(__dirname, '..', 'audio'));
registerRoute('get', '/audio-list', (req, res) => {
    fs.readdir(audioDir, (err, files) => {
        if (err) return res.status(500).json({ error: '读取音频目录失败' });
        const audioExts = ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'];
        const songs = files
            .filter(f => audioExts.includes(path.extname(f).toLowerCase()))
            .map(f => ({
                title: path.basename(f, path.extname(f)),
                src: './audio/' + encodeURIComponent(f)
            }));
        res.json(songs);
    });
});

// --- Split Moments API ---
registerRoute('post', '/users/ensure', (req, res) => {
    const created = ensurePresetUsers();
    return ok(res, { created });
});

registerRoute('get', '/users/:uid', (req, res) => {
    const users = readJsonArray(usersFile);
    const user = users.find(u => u.uid === req.params.uid);
    if (!user) {
        return fail(res, 404, '用户不存在');
    }
    return ok(res, {
        ...user,
        avatar_url: normalizeUploadUrl(user.avatar_url),
        wallpaper_diary_url: normalizeUploadUrl(user.wallpaper_diary_url),
        wallpaper_topic_url: normalizeUploadUrl(user.wallpaper_topic_url),
        card_opacity: user.card_opacity ?? 235 / 255
    });
});

registerRoute('put', '/users/:uid', (req, res) => {
    if (!requireSessionAuthor(req, res, req.params.uid)) return;
    const users = readJsonArray(usersFile);
    const index = users.findIndex(u => u.uid === req.params.uid);
    if (index === -1) {
        return fail(res, 404, '用户不存在');
    }

    const updates = req.body || {};
    const next = { ...users[index] };

    if (Object.prototype.hasOwnProperty.call(updates, 'nickname')) {
        if (typeof updates.nickname !== 'string') {
            return fail(res, 400, 'nickname 必须是字符串');
        }
        next.nickname = updates.nickname;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'avatar_url')) {
        if (typeof updates.avatar_url !== 'string') {
            return fail(res, 400, 'avatar_url 必须是字符串');
        }
        next.avatar_url = updates.avatar_url;
    }

    // 壁纸字段：日记/话题各一条 URL + 透明度，以及共用的卡片不透明度
    if (Object.prototype.hasOwnProperty.call(updates, 'wallpaper_diary_url')) {
        if (typeof updates.wallpaper_diary_url !== 'string') {
            return fail(res, 400, 'wallpaper_diary_url 必须是字符串');
        }
        next.wallpaper_diary_url = updates.wallpaper_diary_url;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'wallpaper_topic_url')) {
        if (typeof updates.wallpaper_topic_url !== 'string') {
            return fail(res, 400, 'wallpaper_topic_url 必须是字符串');
        }
        next.wallpaper_topic_url = updates.wallpaper_topic_url;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'wallpaper_diary_opacity')) {
        const opacity = Number(updates.wallpaper_diary_opacity);
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            return fail(res, 400, 'wallpaper_diary_opacity 必须是 0~1 的数字');
        }
        next.wallpaper_diary_opacity = opacity;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'wallpaper_topic_opacity')) {
        const opacity = Number(updates.wallpaper_topic_opacity);
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            return fail(res, 400, 'wallpaper_topic_opacity 必须是 0~1 的数字');
        }
        next.wallpaper_topic_opacity = opacity;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'card_opacity')) {
        const opacity = updates.card_opacity;
        if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
            return fail(res, 400, 'card_opacity 必须是 0~1 的数字');
        }
        next.card_opacity = opacity;
    }

    users[index] = next;
    writeJsonArray(usersFile, users);
    return res.json({ ok: true });
});

registerRoute('get', '/moments', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { date_str: dateStr, author_ids: authorIds } = req.query;
    if (!dateStr || !authorIds) {
        return fail(res, 400, 'date_str 和 author_ids 为必填参数');
    }
    if (!isValidDateStr(dateStr)) {
        return fail(res, 400, 'date_str 格式必须为 YYYY-MM-DD');
    }

    const uidList = sanitizeUidList(String(authorIds));
    if (uidList.length === 0) {
        return fail(res, 400, 'author_ids 不能为空');
    }

    const moments = readJsonArray(momentsFile)
        .filter(m => m.date_str === dateStr && uidList.includes(m.author_id))
        .sort((a, b) => String(a.author_id).localeCompare(String(b.author_id)));

    return ok(res, moments.map(normalizeMomentRecord));
});

registerRoute('post', '/moments', (req, res) => {
    const {
        date_str: dateStr,
        author_id: claimedAuthorId,
        image_urls: imageUrlsInput,
        self_image_url: selfImageUrl = '',
        partner_image_url: partnerImageUrl = '',
        feeling = '',
        mood: moodInput
    } = req.body || {};
    if (!requireSessionAuthor(req, res, claimedAuthorId)) return;
    const authorId = req.auth.user_id;

    if (imageUrlsInput !== undefined && !Array.isArray(imageUrlsInput)) {
        return fail(res, 400, 'image_urls 必须是数组');
    }

    if (!dateStr || !authorId) {
        return fail(res, 400, 'date_str 和 author_id 为必填字段');
    }
    if (!isValidDateStr(dateStr)) {
        return fail(res, 400, 'date_str 格式必须为 YYYY-MM-DD');
    }

    const users = readJsonArray(usersFile);
    if (!users.some(u => u.uid === authorId)) {
        return fail(res, 400, 'author_id 无效');
    }

    // created_at / updated_at 由服务端生成，前端无需也不能传入。

    const moments = readJsonArray(momentsFile);
    const duplicated = moments.some(m => m.date_str === dateStr && m.author_id === authorId);
    if (duplicated) {
        return fail(res, 409, '该用户在该日期已有动态');
    }

    const mood = normalizeMood(moodInput);
    if (moodInput !== undefined && mood === null) {
        return fail(res, 400, 'mood 必须是 1-10 的整数');
    }

    // 新格式优先；无 image_urls 时兼容旧字段
    const imageUrls = normalizeImageUrls({
        image_urls: imageUrlsInput,
        self_image_url: selfImageUrl,
        partner_image_url: partnerImageUrl
    });

    const now = nowIsoUtc8();
    const id = makeMomentId();
    moments.push({
        id,
        date_str: dateStr,
        author_id: authorId,
        image_urls: imageUrls,
        feeling: String(feeling || ''),
        mood,
        comments: [],
        created_at: now,
        updated_at: now
    });

    writeJsonArray(momentsFile, moments);

    const partnerUid = getPartnerUid(authorId);
    pushNotification(partnerUid, {
        id: makeMomentId(),
        recipient_id: partnerUid,
        type: 'moment',
        title: `对方发布了 ${dateStr} 的日记`,
        content: String(feeling || ''),
        date_str: dateStr,
        created_at: now
    });

    return ok(res, { id });
});

registerRoute('put', '/moments/:id', (req, res) => {
    const moments = readJsonArray(momentsFile);
    const index = moments.findIndex(m => String(m.id) === String(req.params.id));
    if (index === -1) {
        return fail(res, 404, '动态不存在');
    }

    const original = moments[index];
    const updates = req.body || {};
    if (original.author_id !== req.auth.user_id) return fail(res, 403, '只能修改自己的日记');
    if (!requireSessionAuthor(req, res, updates.author_id)) return;
    if (Object.prototype.hasOwnProperty.call(updates, 'comments')) {
        return fail(res, 400, '请使用独立评论接口，不能覆盖整份评论列表');
    }
    const next = { ...original };

    if (Object.prototype.hasOwnProperty.call(updates, 'image_urls')) {
        if (!Array.isArray(updates.image_urls)) {
            return fail(res, 400, 'image_urls 必须是数组');
        }
        next.image_urls = updates.image_urls
            .filter(u => typeof u === 'string' && u)
            .map(normalizeUploadUrl);
    }
    // 旧客户端兼容：仍接受 self/partner 字段，合并进 image_urls
    if (typeof updates.self_image_url === 'string' || typeof updates.partner_image_url === 'string') {
        if (!Object.prototype.hasOwnProperty.call(updates, 'image_urls')) {
            next.image_urls = normalizeImageUrls({
                self_image_url: updates.self_image_url,
                partner_image_url: updates.partner_image_url
            });
        }
    }
    if (typeof updates.feeling === 'string') {
        next.feeling = updates.feeling;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'mood')) {
        const mood = normalizeMood(updates.mood);
        if (updates.mood !== null && updates.mood !== undefined && mood === null) {
            return fail(res, 400, 'mood 必须是 1-10 的整数');
        }
        next.mood = mood;
    }
    if (typeof updates.date_str === 'string') {
        if (!isValidDateStr(updates.date_str)) {
            return fail(res, 400, 'date_str 格式必须为 YYYY-MM-DD');
        }
        next.date_str = updates.date_str;
    }

    const conflict = moments.some((m, i) => {
        if (i === index) return false;
        return m.date_str === next.date_str && m.author_id === next.author_id;
    });
    if (conflict) {
        return fail(res, 409, '更新后与现有动态冲突（同用户同日期）');
    }

    next.updated_at = nowIsoUtc8();
    next.created_at = original.created_at ? toIsoUtc8(original.created_at) : nowIsoUtc8();
    moments[index] = next;
    writeJsonArray(momentsFile, moments);

    const partnerUid = getPartnerUid(next.author_id);
    pushNotification(partnerUid, {
        id: makeMomentId(),
        recipient_id: partnerUid,
        type: 'moment',
        title: `对方更新了 ${next.date_str} 的日记`,
        content: String(next.feeling || ''),
        date_str: next.date_str,
        created_at: nowIsoUtc8()
    });

    return res.json({ ok: true });
});

// 搜索日记内容（从新到旧倒序扫描，断点游标续搜，每批 limit 条）
registerRoute('get', '/moments/search', (req, res) => {
    const { keyword, q, author_ids: authorIds, limit = 10, cursor } = req.query;
    const query = String(keyword || q || '').trim().toLowerCase();
    if (!query) {
        return fail(res, 400, '搜索关键词不能为空');
    }

    const uidList = authorIds ? sanitizeUidList(String(authorIds)) : [];
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));

    // 获取所有日记并按时间从新到旧排序（从下往上）
    const moments = readJsonArray(momentsFile);
    const candidateMoments = uidList.length > 0
        ? moments.filter(m => uidList.includes(m.author_id))
        : moments;

    candidateMoments.sort((a, b) => {
        const dateCmp = (b.date_str || '').localeCompare(a.date_str || '');
        if (dateCmp !== 0) return dateCmp;
        return (b.created_at || '').localeCompare(a.created_at || '');
    });

    // 定位扫描起点：若有 cursor，直接从暂停的下一条恢复扫描
    let startIndex = 0;
    if (cursor) {
        const cursorIdx = candidateMoments.findIndex(m => String(m.id) === String(cursor));
        if (cursorIdx !== -1) {
            startIndex = cursorIdx + 1;
        }
    }

    const matchedItems = [];
    let lastScannedId = null;
    let nextIndex = startIndex;

    while (nextIndex < candidateMoments.length && matchedItems.length < limitNum) {
        const m = candidateMoments[nextIndex];
        lastScannedId = m.id;

        const feeling = String(m.feeling || '');
        const hasFeelingMatch = feeling.toLowerCase().includes(query);

        let hasCommentMatch = false;
        if (Array.isArray(m.comments)) {
            for (const c of m.comments) {
                if (String(c.content || '').toLowerCase().includes(query)) {
                    hasCommentMatch = true;
                    break;
                }
            }
        }

        if (hasFeelingMatch || hasCommentMatch) {
            matchedItems.push(normalizeMomentRecord(m));
        }

        nextIndex++;
    }

    const hasMore = nextIndex < candidateMoments.length;
    const nextCursor = hasMore ? lastScannedId : null;

    return ok(res, {
        items: matchedItems,
        has_more: hasMore,
        next_cursor: nextCursor
    });
});

registerRoute('get', '/moments/calendar/dates', (req, res) => {
    const moments = readJsonArray(momentsFile);
    const datesByAuthor = {};
    for (const m of moments) {
        if (!m.author_id || !m.date_str) continue;
        if (!datesByAuthor[m.author_id]) {
            datesByAuthor[m.author_id] = new Set();
        }
        datesByAuthor[m.author_id].add(m.date_str);
    }
    const result = {};
    for (const [authorId, dateSet] of Object.entries(datesByAuthor)) {
        result[authorId] = Array.from(dateSet).sort();
    }
    if (!result['A']) result['A'] = [];
    if (!result['B']) result['B'] = [];
    return ok(res, result);
});



// 日记详情放在 search/calendar 等固定路径之后，避免动态 id 抢先匹配。
registerRoute('get', '/moments/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const moment = readJsonArray(momentsFile).find(m => String(m.id) === req.params.id);
    if (!moment) return fail(res, 404, '日记不存在');
    return ok(res, normalizeMomentRecord(moment));
});

// 同步读改写单条追加，不接受客户端提交旧的整份评论列表。
registerRoute('post', '/moments/:id/comments', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const moments = readJsonArray(momentsFile);
    const index = moments.findIndex(m => String(m.id) === req.params.id);
    if (index < 0) return fail(res, 404, '日记不存在');
    const body = req.body || {};
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        return fail(res, 400, '评论 id 无效');
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
        return fail(res, 400, '评论不能为空');
    }
    if (!requireSessionAuthor(req, res, body.author_id)) return;
    const authorId = req.auth.user_id;
    if (body.reply_to != null && typeof body.reply_to !== 'string') {
        return fail(res, 400, '回复目标无效');
    }
    const moment = normalizeMomentRecord(moments[index]);
    const content = body.content.trim();
    const replyTo = body.reply_to || null;
    const duplicate = moment.comments.find(c => String(c.id) === body.id);
    if (duplicate) {
        if (duplicate.author_id !== authorId || duplicate.content !== content || duplicate.reply_to !== replyTo) {
            return fail(res, 409, '评论 id 已用于其他内容');
        }
        return ok(res, moment);
    }
    if (replyTo && !moment.comments.some(c => String(c.id) === replyTo)) {
        return fail(res, 409, '回复的评论已不存在，请刷新日记后重试');
    }
    const comment = {
        id: body.id, author_id: authorId, content,
        reply_to: replyTo, created_at: nowIsoUtc8()
    };
    moment.comments.push(comment);
    moments[index] = moment;
    writeJsonArray(momentsFile, moments);
    const recipient = getPartnerUid(comment.author_id);
    const preview = content.length > 7 ? `${content.slice(0, 7)}...` : content;
    pushNotification(recipient, {
        id: comment.id, recipient_id: recipient, type: 'momentComment',
        title: `对方在 ${moment.date_str} 的日记中评论：“${preview}”`,
        content, date_str: moment.date_str, created_at: comment.created_at
    });
    return ok(res, moment);
});

registerRoute('delete', '/moments/:id/comments/:commentId', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const moments = readJsonArray(momentsFile);
    const index = moments.findIndex(m => String(m.id) === req.params.id);
    if (index < 0) return fail(res, 404, '日记不存在');
    const moment = normalizeMomentRecord(moments[index]);
    const comment = moment.comments.find(c => String(c.id) === req.params.commentId);
    if (!comment) return ok(res, moment);
    if (comment.author_id !== req.auth.user_id) return fail(res, 403, '只能删除自己的评论');
    const removed = new Set([String(comment.id)]);
    let changed;
    do {
        changed = false;
        for (const child of moment.comments) {
            if (removed.has(String(child.reply_to)) && !removed.has(String(child.id))) {
                removed.add(String(child.id));
                changed = true;
            }
        }
    } while (changed);
    moment.comments = moment.comments.filter(c => !removed.has(String(c.id)));
    moments[index] = moment;
    writeJsonArray(momentsFile, moments);
    return ok(res, moment);
});

// ─── 话题讨论 API ───
const topicsFile = path.join(dataDir, 'topics.json');
const postsFile = path.join(dataDir, 'posts.json');

function ensureTopicFiles() {
    if (!fs.existsSync(topicsFile)) fs.writeFileSync(topicsFile, '[]', 'utf8');
    if (!fs.existsSync(postsFile)) fs.writeFileSync(postsFile, '[]', 'utf8');
}
ensureTopicFiles();

function makeTopicId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makePostId() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 话题列表
registerRoute('get', '/topics', (req, res) => {
    const latestByTopic = new Map();
    for (const post of readJsonArray(postsFile)) {
        const candidate = post.updated_at || post.created_at;
        if (!Number.isFinite(Date.parse(candidate))) continue;
        const previous = latestByTopic.get(post.topic_id);
        if (candidate && (!previous || new Date(candidate) > new Date(previous))) latestByTopic.set(post.topic_id, candidate);
    }
    const topics = readJsonArray(topicsFile)
        .map(topic => {
            const postTime = latestByTopic.get(topic.id);
            const topicTime = topic.updated_at || topic.created_at;
            return { ...topic, latest_updated_at: postTime && new Date(postTime) > new Date(topicTime) ? postTime : topicTime };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return ok(res, topics);
});

// 创建话题
registerRoute('post', '/topics', (req, res) => {
    const { title, author_id: claimedAuthorId } = req.body || {};
    if (!requireSessionAuthor(req, res, claimedAuthorId)) return;
    const author_id = req.auth.user_id;
    if (!title || !String(title).trim()) return fail(res, 400, '标题不能为空');
    if (!author_id) return fail(res, 400, 'author_id 不能为空');

    const topics = readJsonArray(topicsFile);
    const topic = {
        id: makeTopicId(),
        title: String(title).trim(),
        author_id: String(author_id),
        created_at: nowIsoUtc8()
    };
    topics.push(topic);
    writeJsonArray(topicsFile, topics);

    const partnerUid = getPartnerUid(author_id);
    pushNotification(partnerUid, {
        id: makeTopicId(),
        recipient_id: partnerUid,
        type: 'topicCreated',
        title: `对方发起了新话题「${topic.title}」`,
        content: '',
        topic_id: topic.id,
        topic_title: topic.title,
        created_at: topic.created_at
    });

    return ok(res, topic);
});

// 话题详情（含帖子列表）
registerRoute('get', '/topics/:id', (req, res) => {
    const topics = readJsonArray(topicsFile);
    const topic = topics.find(t => t.id === req.params.id);
    if (!topic) return fail(res, 404, '话题不存在');

    const posts = readJsonArray(postsFile)
        .filter(p => p.topic_id === req.params.id)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return ok(res, { ...topic, posts });
});

// 发帖
registerRoute('post', '/topics/:id/posts', (req, res) => {
    const { author_id: claimedAuthorId, content } = req.body || {};
    if (!requireSessionAuthor(req, res, claimedAuthorId)) return;
    const author_id = req.auth.user_id;
    if (!author_id) return fail(res, 400, 'author_id 不能为空');
    if (!content || !String(content).trim()) return fail(res, 400, '内容不能为空');

    const topics = readJsonArray(topicsFile);
    const topicObj = topics.find(t => t.id === req.params.id);
    if (!topicObj) return fail(res, 404, '话题不存在');

    const posts = readJsonArray(postsFile);
    const post = {
        id: makePostId(),
        topic_id: req.params.id,
        author_id: String(author_id),
        content: String(content).trim(),
        created_at: nowIsoUtc8()
    };
    posts.push(post);
    writeJsonArray(postsFile, posts);

    const partnerUid = getPartnerUid(author_id);
    const contentStr = String(content).trim();
    const preview = contentStr.length > 10 ? `${contentStr.slice(0, 10)}...` : contentStr;
    pushNotification(partnerUid, {
        id: post.id,
        recipient_id: partnerUid,
        type: 'topicPost',
        title: `对方在话题「${topicObj.title}」中发布了帖子`,
        content: contentStr,
        topic_id: req.params.id,
        topic_title: topicObj.title,
        created_at: post.created_at
    });

    return ok(res, post);
});

// 删帖
registerRoute('delete', '/topics/:id/posts/:postId', (req, res) => {
    const posts = readJsonArray(postsFile);
    const index = posts.findIndex(p => p.id === req.params.postId && p.topic_id === req.params.id);
    if (index === -1) return fail(res, 404, '帖子不存在');
    if (posts[index].author_id !== req.auth.user_id) return fail(res, 403, '只能删除自己的帖子');
    posts.splice(index, 1);
    writeJsonArray(postsFile, posts);
    return ok(res);
});

// ─── 动态通知队列 API（纯粹单次请求：取出并自毁） ───
registerRoute('get', '/notifications', (req, res) => {
    const { user_id: userId } = req.query;
    if (!userId) return fail(res, 400, 'user_id 为必填参数');
    if (!requireSessionAuthor(req, res, userId)) return;
    const notifications = readJsonArray(notificationsFile);
    const userNotifs = notifications
        .filter(n => n.recipient_id === String(userId))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 立即从队列中清除取出的通知（读完自毁）
    if (userNotifs.length > 0) {
        const remaining = notifications.filter(n => n.recipient_id !== String(userId));
        writeJsonArray(notificationsFile, remaining);
    }
    return ok(res, userNotifs);
});

// --- 版本更新 API ---
const versionFile = path.resolve(process.env.VERSION_FILE || path.join(__dirname, 'version.json'));
function readVersion() {
    try {
        return JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    } catch {
        return { version: '1.0.0', version_code: 1, release_notes: '' };
    }
}

registerRoute('get', '/version/latest', (req, res) => {
    const ver = readVersion();
    return ok(res, {
        version: ver.version,
        version_code: ver.version_code,
        download_url: 'https://breeze.qzz.io/api/version/download',
        release_notes: ver.release_notes || ''
    });
});

const apkDir = path.resolve(process.env.APK_DIR || path.join(__dirname, 'apk'));
if (!fs.existsSync(apkDir)) {
    fs.mkdirSync(apkDir, { recursive: true });
}

registerRoute('get', '/version/download', (req, res) => {
    const files = fs.readdirSync(apkDir).filter(f => f.endsWith('.apk'));
    if (files.length === 0) return fail(res, 404, '暂无安装包');
    const apkFile = path.join(apkDir, files[0]);
    res.download(apkFile);
});

// 全局错误处理 —— 防止任何未捕获异常返回 HTML
app.use((err, req, res, _next) => {
    console.error('未捕获错误:', err);
    if (req.url.startsWith('/api/') || req.url.startsWith('/upload') || req.url.startsWith('/moments') || req.url.startsWith('/users')) {
        return res.status(500).json({ ok: false, error: '服务器内部错误: ' + (err.message || '未知错误') });
    }
    return res.status(500).send('Internal Server Error');
});

// Importing the app allows isolated verification without opening a fixed port.
module.exports = app;
if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`后端运行在 http://localhost:${PORT}`);
    });
    // Preserve the existing large-transfer connection limits.
    server.timeout = 3600000;
    server.keepAliveTimeout = 3600000;
}
