const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '1gb' }));

app.use((req, res, next) => {
    if (req.url.startsWith('/api/')) {
        req.url = req.url.slice(4);
    } else if (req.url === '/api') {
        req.url = '/';
    }
    next();
});

function registerRoute(method, routePath, ...handlers) {
    app[method](routePath, ...handlers);
    app[method](`/api${routePath}`, ...handlers);
}

function ok(res, data = {}) {
    return res.json({ ok: true, data });
}

function fail(res, status, error) {
    return res.status(status).json({ ok: false, error });
}

const dataDir = path.join(__dirname, 'data');
const usersFile = path.join(dataDir, 'users.json');
const momentsFile = path.join(dataDir, 'moments.json');

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

function normalizeMomentRecord(moment) {
    const createdAt = moment.created_at ? toIsoUtc8(moment.created_at) : nowIsoUtc8();
    const updatedAt = moment.updated_at ? toIsoUtc8(moment.updated_at) : createdAt;

    return {
        ...moment,
        self_image_url: normalizeUploadUrl(moment.self_image_url),
        partner_image_url: normalizeUploadUrl(moment.partner_image_url),
        mood: normalizeMood(moment.mood),
        comments: normalizeComments(moment.comments, moment.author_id),
        created_at: createdAt,
        updated_at: updatedAt
    };
}

function getPartnerUid(authorId) {
    if (authorId === 'A') return 'B';
    if (authorId === 'B') return 'A';
    return '';
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

// ─── 图片上传配置 ───
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: uploadsDir,
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname);
            const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
            cb(null, name);
        }
    }),
    fileFilter: (_req, file, cb) => {
        const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    }
});

// 上传图片
registerRoute('post', '/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return fail(res, 400, '请选择 jpg/png/webp 图片');
    }
    const url = `https://breeze.qzz.io/api/uploads/${req.file.filename}`;
    return ok(res, { url });
});

// 删除图片
registerRoute('post', '/upload/delete', (req, res) => {
    const { url } = req.body || {};
    if (!url) return fail(res, 400, 'url 不能为空');
    try {
        const filename = String(url).split('/').pop();
        if (filename) {
            const filePath = path.join(uploadsDir, filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    } catch (_) { /* 删失败不阻塞 */ }
    return ok(res);
});

// 静态文件服务 —— 让 /uploads/xxx.jpg 能直接访问
app.use('/uploads', express.static(uploadsDir));

// --- 云剪切板 API ---
const clipsDir = path.join(__dirname, 'clips');
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
const audioDir = path.join(__dirname, '..', 'audio');
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
        avatar_url: normalizeUploadUrl(user.avatar_url)
    });
});

registerRoute('put', '/users/:uid', (req, res) => {
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

    users[index] = next;
    writeJsonArray(usersFile, users);
    return res.json({ ok: true });
});

registerRoute('get', '/moments', (req, res) => {
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
        author_id: authorId,
        self_image_url: selfImageUrl = '',
        partner_image_url: partnerImageUrl = '',
        feeling = '',
        mood: moodInput
    } = req.body || {};

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

    const now = nowIsoUtc8();
    const id = makeMomentId();
    moments.push({
        id,
        date_str: dateStr,
        author_id: authorId,
        self_image_url: String(selfImageUrl || ''),
        partner_image_url: String(partnerImageUrl || ''),
        feeling: String(feeling || ''),
        mood,
        comments: [],
        created_at: now,
        updated_at: now
    });

    writeJsonArray(momentsFile, moments);
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
    const next = { ...original };

    if (typeof updates.self_image_url === 'string') {
        next.self_image_url = updates.self_image_url;
    }
    if (typeof updates.partner_image_url === 'string') {
        next.partner_image_url = updates.partner_image_url;
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
    if (Object.prototype.hasOwnProperty.call(updates, 'comments')) {
        if (!Array.isArray(updates.comments)) {
            return fail(res, 400, 'comments 必须是数组');
        }
        next.comments = normalizeComments(updates.comments, next.author_id);
    }
    if (typeof updates.date_str === 'string') {
        if (!isValidDateStr(updates.date_str)) {
            return fail(res, 400, 'date_str 格式必须为 YYYY-MM-DD');
        }
        next.date_str = updates.date_str;
    }
    if (typeof updates.author_id === 'string') {
        const users = readJsonArray(usersFile);
        if (!users.some(u => u.uid === updates.author_id)) {
            return fail(res, 400, 'author_id 无效');
        }
        next.author_id = updates.author_id;
    }

    const conflict = moments.some((m, i) => {
        if (i === index) return false;
        return m.date_str === next.date_str && m.author_id === next.author_id;
    });
    if (conflict) {
        return fail(res, 409, '更新后与现有动态冲突（同用户同日期）');
    }

    // 仅评论变动不更新编辑时间
    const isOnlyComments = Object.keys(updates).every(k => k === 'comments');
    next.updated_at = isOnlyComments
        ? (original.updated_at ? toIsoUtc8(original.updated_at) : nowIsoUtc8())
        : nowIsoUtc8();
    next.created_at = original.created_at ? toIsoUtc8(original.created_at) : nowIsoUtc8();
    moments[index] = next;
    writeJsonArray(momentsFile, moments);
    return res.json({ ok: true });
});

registerRoute('get', '/moments/:uid/dates', (req, res) => {
    const uid = req.params.uid;
    const users = readJsonArray(usersFile);
    if (!users.some(u => u.uid === uid)) {
        return fail(res, 404, '用户不存在');
    }

    const dates = [...new Set(
        readJsonArray(momentsFile)
            .filter(m => m.author_id === uid)
            .map(m => m.date_str)
    )].sort();

    return ok(res, dates);
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
    const topics = readJsonArray(topicsFile)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return ok(res, topics);
});

// 创建话题
registerRoute('post', '/topics', (req, res) => {
    const { title, author_id } = req.body || {};
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
    const { author_id, content } = req.body || {};
    if (!author_id) return fail(res, 400, 'author_id 不能为空');
    if (!content || !String(content).trim()) return fail(res, 400, '内容不能为空');

    const topics = readJsonArray(topicsFile);
    if (!topics.some(t => t.id === req.params.id)) return fail(res, 404, '话题不存在');

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
    return ok(res, post);
});

// 删帖
registerRoute('delete', '/topics/:id/posts/:postId', (req, res) => {
    const posts = readJsonArray(postsFile);
    const index = posts.findIndex(p => p.id === req.params.postId && p.topic_id === req.params.id);
    if (index === -1) return fail(res, 404, '帖子不存在');
    posts.splice(index, 1);
    writeJsonArray(postsFile, posts);
    return ok(res);
});

const server = app.listen(PORT, () => {
    console.log(`后端运行在 http://localhost:${PORT}`);
});

// --- 版本更新 API ---
const versionFile = path.join(__dirname, 'version.json');
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

const apkDir = path.join(__dirname, 'apk');
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

// --- 大文件传输核心设置 ---
// 设置 1 小时超时，防止传输大文件时连接被 Node.js 主动掐断
server.timeout = 3600000; 
server.keepAliveTimeout = 3600000;
