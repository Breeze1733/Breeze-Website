const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

const uploadDir = path.join(__dirname, 'uploads');
// 确保上传目录存在（不仅启动时检查，每次操作前也会检查）
function ensureUploadDir() {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }
}
ensureUploadDir();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // 处理中文乱码
        const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
        const ext = path.extname(originalName);
        const name = path.basename(originalName, ext);
        
        let finalName = originalName;
        let counter = 1;

        // 重名自动加 (1), (2)...
        while (fs.existsSync(path.join(uploadDir, finalName))) {
            finalName = `${name} (${counter})${ext}`;
            counter++;
        }
        cb(null, finalName);
    }
});

const upload = multer({ storage: storage });

registerRoute('post', '/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '未选择文件' });
    res.json({ message: '上传成功', filename: req.file.filename });
});

registerRoute('get', '/files', (req, res) => {
    ensureUploadDir();
    fs.readdir(uploadDir, (err, files) => {
        if (err) return res.status(500).json({ error: '读取目录失败' });
        res.json(files.map(file => ({ name: file })));
    });
});

registerRoute('get', '/download/:filename', (req, res) => {
    const file = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });
    res.download(file, (err) => {
        if (err) console.error("下载中断:", err);
    });
});

registerRoute('delete', '/files/:filename', (req, res) => {
    const filePath = path.join(uploadDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    fs.unlink(filePath, (err) => {
        if (err) return res.status(500).json({ error: '删除失败' });
        res.json({ message: '已删除' });
    });
});

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

const server = app.listen(PORT, () => {
    console.log(`后端运行在 http://localhost:${PORT}`);
});

// --- 大文件传输核心设置 ---
// 设置 1 小时超时，防止传输大文件时连接被 Node.js 主动掐断
server.timeout = 3600000; 
server.keepAliveTimeout = 3600000;
