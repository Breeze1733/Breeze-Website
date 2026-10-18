const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function stripKnownPrefixes(req, res, next) {
    const prefixes = ['/transfer-api'];

    for (const prefix of prefixes) {
        if (req.url === prefix) {
            req.url = '/';
            break;
        }

        if (req.url.startsWith(prefix + '/')) {
            req.url = req.url.slice(prefix.length);
            break;
        }
    }

    next();
}

app.use(stripKnownPrefixes);

const uploadDir = path.resolve(process.env.TRANSFER_UPLOADS_DIR || path.join(__dirname, 'transfer-uploads'));
const clipsDir = path.resolve(process.env.CLIPS_DIR || path.join(__dirname, 'clips'));

function ensureUploadDir() {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Every API accepts one filename, never a relative path or a symbolic link.
function resolveSingleFile(baseDir, filename) {
    if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' ||
        /[\\/\x00-\x1f\x7f]/.test(filename)) {
        return null;
    }
    const filePath = path.resolve(baseDir, filename);
    if (path.dirname(filePath) !== baseDir) return null;
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return filePath;
}

function resolveClipPath(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    return resolveSingleFile(clipsDir, `${id}.json`);
}

function writeClip(filePath, clip) {
    const temporaryPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(clip));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try {
            fs.unlinkSync(temporaryPath);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
}

function clipFromBody(body) {
    if (typeof body?.content !== 'string' || !body.content.trim()) return null;
    const content = body.content.trim();
    return { content, preview: content.slice(0, 100), createdAt: Date.now() };
}

function buildPublicUrl(filename) {
    return `https://breeze.qzz.io/uploads/${encodeURIComponent(filename)}`;
}

function resolveUploadPath(inputUrl) {
    let pathname = '';
    try {
        pathname = new URL(inputUrl).pathname;
    } catch {
        pathname = inputUrl;
    }

    // 仅保留当前中转站的标准路径解析
    if (pathname.startsWith('/uploads/')) {
        try {
            return decodeURIComponent(pathname.slice('/uploads/'.length));
        } catch {
            return null;
        }
    }

    return null;
}

ensureUploadDir();
fs.mkdirSync(clipsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        try {
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            if (!resolveSingleFile(uploadDir, originalName)) {
                const error = new Error('非法文件名');
                error.status = 400;
                return cb(error);
            }
            const ext = path.extname(originalName);
            const name = path.basename(originalName, ext);

            let finalName = originalName;
            let counter = 1;

            while (fs.existsSync(path.join(uploadDir, finalName))) {
                finalName = `${name} (${counter})${ext}`;
                counter++;
            }

            cb(null, finalName);
        } catch (err) {
            cb(err);
        }
    }
});

const upload = multer({ storage });

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ ok: false, error: '未选择文件' });
    }

    return res.json({
        ok: true,
        data: {
            url: buildPublicUrl(req.file.filename)
        },
        message: '上传成功',
        filename: req.file.filename
    });
});

app.post('/upload/delete', (req, res) => {
    const { url } = req.body || {};
    if (typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ ok: false, error: 'url 必填' });
    }

    const relativeName = resolveUploadPath(url);
    if (!relativeName) {
        return res.status(400).json({ ok: false, error: '仅允许删除上传目录下文件' });
    }

    const targetPath = resolveSingleFile(uploadDir, relativeName);
    if (!targetPath) {
        return res.status(400).json({ ok: false, error: '非法文件路径' });
    }

    if (fs.existsSync(targetPath)) {
        try {
            fs.unlinkSync(targetPath);
        } catch {
            return res.status(500).json({ ok: false, error: '删除失败' });
        }
    }

    return res.json({ ok: true });
});

app.get('/files', (req, res) => {
    ensureUploadDir();
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.status(500).json({ ok: false, error: '读取目录失败' });
        }
        res.json(files.map(file => ({ name: file })));
    });
});

app.get('/download/:filename', (req, res) => {
    const filePath = resolveSingleFile(uploadDir, req.params.filename);
    if (!filePath) return res.status(400).json({ ok: false, error: '非法文件名' });
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ ok: false, error: '文件不存在' });
    }
    res.download(filePath, (err) => {
        if (err) {
            console.error('下载中断:', err);
        }
    });
});

app.delete('/files/:filename', (req, res) => {
    const filePath = resolveSingleFile(uploadDir, req.params.filename);
    if (!filePath) return res.status(400).json({ ok: false, error: '非法文件名' });
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ ok: false, error: '文件不存在' });
    }

    fs.unlink(filePath, (err) => {
        if (err) {
            return res.status(500).json({ ok: false, error: '删除失败' });
        }
        res.json({ ok: true });
    });
});

app.get('/clips', (req, res) => {
    const clips = [];
    for (const filename of fs.readdirSync(clipsDir)) {
        if (!filename.endsWith('.json')) continue;
        const id = filename.slice(0, -'.json'.length);
        const filePath = resolveClipPath(id);
        if (!filePath) continue;
        try {
            const clip = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
            if (typeof clip.content !== 'string' || !Number.isFinite(clip.createdAt)) continue;
            clips.push({ ...clip, id });
        } catch (err) {
            console.error(`读取剪切板 ${filename} 失败:`, err.message);
        }
    }
    res.json(clips.sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/clips', (req, res) => {
    const clip = clipFromBody(req.body);
    if (!clip) return res.status(400).send('内容不能为空');
    let id;
    let filePath;
    do {
        id = Date.now().toString(36) + randomBytes(6).toString('hex');
        filePath = resolveClipPath(id);
    } while (!filePath || fs.existsSync(filePath));
    writeClip(filePath, clip);
    res.send({ message: '保存成功', id });
});

app.put('/clips/:id', (req, res) => {
    const filePath = resolveClipPath(req.params.id);
    if (!filePath) return res.status(400).send('非法剪切板 ID');
    const clip = clipFromBody(req.body);
    if (!clip) return res.status(400).send('内容不能为空');
    if (!fs.existsSync(filePath)) return res.status(404).send('内容不存在');
    writeClip(filePath, clip);
    res.send({ message: '更新成功' });
});

app.delete('/clips/:id', (req, res) => {
    const filePath = resolveClipPath(req.params.id);
    if (!filePath) return res.status(400).send('非法剪切板 ID');
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).send('内容不存在');
        throw err;
    }
    res.send({ message: '已删除' });
});

app.use('/uploads', express.static(uploadDir));

app.use((err, req, res, next) => {
    console.error('请求失败:', err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ ok: false, error: err.status ? err.message : '操作失败' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`文件中转站后端运行在 http://localhost:${PORT}`);
    });
}

module.exports = { app, uploadDir, clipsDir };
