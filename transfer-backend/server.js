const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =========================================================
// 【核心修改】物理隔离：改在当前独立后端目录下创建独立的文件夹
// =========================================================
const uploadDir = path.join(__dirname, 'transfer-uploads');

function ensureUploadDir() {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
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
        return decodeURIComponent(pathname.replace(/^\/uploads\//, ''));
    }

    return null;
}

ensureUploadDir();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(originalName);
        const name = path.basename(originalName, ext);

        let finalName = originalName;
        let counter = 1;

        while (fs.existsSync(path.join(uploadDir, finalName))) {
            finalName = `${name} (${counter})${ext}`;
            counter++;
        }

        cb(null, finalName);
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

    const targetPath = path.resolve(uploadDir, relativeName);
    const baseDir = path.resolve(uploadDir);
    if (!targetPath.startsWith(baseDir + path.sep) && targetPath !== baseDir) {
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
    const filePath = path.join(uploadDir, req.params.filename);
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
    const filePath = path.join(uploadDir, req.params.filename);
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

// =========================================================
// 【干净清爽】仅映射当前中转站的独立目录，移除 /api/uploads
// =========================================================
app.use('/uploads', express.static(uploadDir));

app.listen(PORT, () => {
    console.log(`文件中转站后端运行在 http://localhost:${PORT}`);
});