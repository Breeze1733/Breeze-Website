#!/usr/bin/env node
'use strict';

// 默认只检测；--clean 才清理未引用原图及其预览，--backup 可保留可恢复副本。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const backendDir = path.resolve(__dirname, '..');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.svg']);
const PREVIEW_NAME = /^([a-f0-9]{64})-v[1-9]\d*\.(webp|json)$/;
const imageId = name => crypto.createHash('sha256').update(name).digest('hex');
const bytes = files => files.reduce((sum, file) => sum + file.size, 0);
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

function parseDuration(value) {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
    if (!match) throw new Error('保护时间无效，例如 --min-age 1h；取消保护请明确指定 --all');
    const duration = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(match[2] || 'h').toLowerCase()]);
    if (!Number.isFinite(duration)) throw new Error('保护时间过大');
    return duration;
}

function parseArgs(args) {
    const options = { minAgeMs: 3600000, uploadsDir: process.env.UPLOADS_DIR || path.join(backendDir, 'uploads'),
        dataDir: process.env.DATA_DIR || path.join(backendDir, 'data'), previewsDir: process.env.PREVIEWS_DIR };
    for (let i = 0; i < args.length; i++) {
        const equal = args[i].indexOf('=');
        const name = equal < 0 ? args[i] : args[i].slice(0, equal);
        const flag = { '--clean': 'clean', '-c': 'clean', '--delete': 'clean', '-d': 'clean', '--backup': 'backup', '-b': 'backup',
            '--all': 'all', '--stat': 'statOnly', '-s': 'statOnly', '--verbose': 'verbose', '-v': 'verbose', '--json': 'json', '--help': 'help', '-h': 'help' }[name];
        if (flag) {
            if (equal >= 0) throw new Error(`${name} 不接受参数值`);
            options[flag] = true;
            continue;
        }
        const key = { '--uploads-dir': 'uploadsDir', '--previews-dir': 'previewsDir', '--data-dir': 'dataDir', '--backup-dir': 'backupDir', '--min-age': 'minAgeMs' }[name];
        if (!key) throw new Error(`未知选项：${name}`);
        const value = equal < 0 ? args[++i] : args[i].slice(equal + 1);
        if (!value || value.startsWith('-')) throw new Error(`${name} 缺少参数值`);
        options[key] = key === 'minAgeMs' ? parseDuration(value) : path.resolve(value);
        if (key === 'backupDir') options.backup = true;
    }
    options.uploadsDir = path.resolve(options.uploadsDir);
    options.dataDir = path.resolve(options.dataDir);
    options.previewsDir = path.resolve(options.previewsDir || `${options.uploadsDir}_previews`);
    if (options.all) options.minAgeMs = 0;
    if (options.statOnly && options.clean) throw new Error('--stat 与 --clean 不能同时使用');
    return options;
}

function printHelp() {
    console.log(`原图与预览图统计、引用检测及清理（默认只检测，不删除）
用法：node tools/clean-uploads.js [选项]
  --stat, -s             只统计原图与预览，不读取引用数据
  --clean, -c            清理未引用原图、对应预览和无主预览
  --backup, -b           清理前备份，原图和预览分别保存
  --backup-dir <path>    指定备份目录，默认 uploads_backup_<时间戳>
  --min-age <duration>   新文件保护时间，默认 1h，例如 30m、2h、1d
  --all                 取消新文件保护
  --uploads-dir <path>   原图目录（也支持 UPLOADS_DIR）
  --previews-dir <path>  预览目录（也支持 PREVIEWS_DIR，默认原图目录加 _previews）
  --data-dir <path>      引用数据目录（也支持 DATA_DIR）
  --verbose, -v         列出全部待清理文件
  --json                输出 JSON
  --help, -h            显示帮助`);
}

// 解析已有父目录的真实位置，避免通过目录链接把备份写进原图或业务数据中。
function realLocation(directory) {
    let current = path.resolve(directory);
    const missing = [];
    while (!fs.existsSync(current)) {
        missing.unshift(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) throw new Error(`目录无法解析：${directory}`);
        current = parent;
    }
    return path.join(fs.realpathSync(current), ...missing);
}

function contains(parent, child) {
    const relative = path.relative(parent, child);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function requireSeparate(a, b) {
    if (contains(a, b) || contains(b, a)) throw new Error(`目录不能重叠：${a} 与 ${b}`);
}

function scan(directory, optional = false) {
    if (optional && !fs.existsSync(directory)) return [];
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(directory, entry.name);
        let stat;
        try { stat = fs.lstatSync(fullPath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile()) continue;
        files.push({ name: entry.name, ext: path.extname(entry.name).toLowerCase(), fullPath, size: stat.size,
            mtime: stat.mtime, signature: signature(stat) });
    }
    return files;
}

function dataStamp(directory) {
    return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
        const stat = fs.lstatSync(path.join(directory, name));
        if (!stat.isFile()) throw new Error(`数据文件必须是普通文件：${name}`);
        return `${name}:${signature(stat)}`;
    }).join('\n');
}

function readReferences(directory) {
    const stamp = dataStamp(directory);
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    for (const name of ['users.json', 'moments.json']) {
        if (!names.includes(name)) throw new Error(`缺少 ${name}，停止引用检测和清理`);
    }
    const references = new Map();
    function addReference(name, source) {
        try { name = path.basename(decodeURIComponent(name.split(/[?#]/)[0])).trim(); } catch { return; }
        if (!IMAGE_EXTS.has(path.extname(name).toLowerCase())) return;
        if (!references.has(name)) references.set(name, new Set());
        references.get(name).add(source);
    }
    for (const name of names) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
            if (['users.json', 'moments.json', 'posts.json', 'topics.json', 'notifications.json'].includes(name) && !Array.isArray(data)) throw new Error();
        } catch { throw new Error(`数据文件 ${name} 无法读取或格式错误，停止清理`); }
        // 先解析 JSON 再扫描，兼容 BOM、转义斜线及历史上的纯文件名引用。
        const content = JSON.stringify(data);
        for (const match of content.matchAll(/\/(?:api\/)?uploads\/([^"'`<>?#\s\\]+)/g)) addReference(match[1], name);
        const bareContent = content.replace(/\/(?:api\/)?uploads\/[^"'`<>\s\\]+/g, '');
        for (const match of bareContent.matchAll(/\b([a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?|svg))\b/gi)) addReference(match[1], name);
    }
    if (dataStamp(directory) !== stamp) throw new Error('引用数据正在变化，请稍后重新运行');
    return { references, stamp };
}

function assertUnchanged(file) {
    const stat = fs.lstatSync(file.fullPath);
    if (!stat.isFile() || signature(stat) !== file.signature) throw new Error('文件在扫描后发生变化，跳过清理');
}

function run(options) {
    if (options.help) return printHelp();
    const uploadsDir = realLocation(options.uploadsDir);
    const previewsDir = realLocation(options.previewsDir);
    const dataDir = realLocation(options.dataDir);
    requireSeparate(uploadsDir, previewsDir);
    requireSeparate(uploadsDir, dataDir);
    requireSeparate(previewsDir, dataDir);
    const files = scan(uploadsDir);
    const images = files.filter(file => IMAGE_EXTS.has(file.ext));
    const otherFiles = files.filter(file => !IMAGE_EXTS.has(file.ext));
    const allPreviewFiles = scan(previewsDir, true);
    const previews = allPreviewFiles.filter(file => PREVIEW_NAME.test(file.name));
    const extMap = {};
    for (const file of images) {
        extMap[file.ext] ||= { count: 0, size: 0 };
        extMap[file.ext].count++;
        extMap[file.ext].size += file.size;
    }
    const sortedImages = [...images].sort((a, b) => a.mtime - b.mtime);
    const brief = file => file ? { name: file.name, mtime: file.mtime } : null;
    const report = { mode: options.statOnly ? 'stat' : options.clean ? 'clean' : 'preview', uploadsDir, previewsDir,
        totalFiles: files.length, totalBytes: bytes(files), totalFilesCount: files.length, totalFilesSize: bytes(files),
        imageCount: images.length, imageBytes: bytes(images), extMap, otherFiles: otherFiles.map(file => ({ name: file.name, size: file.size })),
        nonImageCount: otherFiles.length, nonImageSize: bytes(otherFiles), newestImage: brief(sortedImages.at(-1)), oldestImage: brief(sortedImages[0]),
        previewCount: previews.filter(file => file.ext === '.webp').length, previewMetadataCount: previews.filter(file => file.ext === '.json').length,
        previewFileCount: previews.length, previewBytes: bytes(previews), otherPreviewFileCount: allPreviewFiles.length - previews.length,
        totalMediaBytes: bytes(files) + bytes(allPreviewFiles) };

    if (!options.statOnly) {
        const snapshot = readReferences(dataDir);
        const now = Date.now();
        const oldEnough = file => options.minAgeMs === 0 || now - file.mtime.getTime() >= options.minAgeMs;
        const referenced = images.filter(file => snapshot.references.has(file.name));
        const unused = images.filter(file => !snapshot.references.has(file.name));
        const dead = unused.filter(oldEnough);
        const protectedFiles = unused.filter(file => !oldEnough(file));
        const deadNames = new Set(dead.map(file => file.name));
        const owners = new Map(files.map(file => [imageId(file.name), file.name]));
        // 原图丢失但仍被日记引用时，保留其预览，避免删掉最后一份图片。
        for (const name of snapshot.references.keys()) owners.set(imageId(name), name);
        const groups = new Map();
        for (const file of previews) {
            const [, id] = PREVIEW_NAME.exec(file.name);
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(file);
        }
        const previewCleanup = [];
        let protectedPreviewFileCount = 0;
        for (const [id, group] of groups) {
            const owner = owners.get(id);
            if (owner && !deadNames.has(owner)) continue;
            if (!owner && group.some(file => !oldEnough(file))) {
                protectedPreviewFileCount += group.length;
                continue;
            }
            for (const file of group) previewCleanup.push({ ...file, id, owner, reason: owner ? 'dead-original' : 'orphan-preview' });
        }
        Object.assign(report, { referencedCount: referenced.length, referencedSize: bytes(referenced), deadCount: dead.length, deadSize: bytes(dead),
            protectedCount: protectedFiles.length, protectedSize: bytes(protectedFiles), protectedPreviewFileCount,
            previewCleanupFileCount: previewCleanup.length, previewCleanupBytes: bytes(previewCleanup),
            orphanPreviewFileCount: previewCleanup.filter(file => !file.owner).length,
            missingFiles: [...snapshot.references].filter(([name]) => !files.some(file => file.name === name)).map(([name, sources]) => ({ name, referencedBy: [...sources] })),
            deadFiles: dead.map(file => ({ name: file.name, size: file.size, mtime: file.mtime })),
            previewCleanupFiles: previewCleanup.map(file => ({ name: file.name, size: file.size, reason: file.reason })),
            backup: null, cleanedCount: 0, cleanedSize: 0, cleanedPreviewFileCount: 0, cleanedPreviewSize: 0, errors: [] });
        report.missingCount = report.missingFiles.length;

        if (options.clean && (dead.length || previewCleanup.length)) {
            const assertDataUnchanged = () => {
                if (dataStamp(dataDir) !== snapshot.stamp) {
                    const error = new Error('引用数据发生变化，已停止后续清理，请重新运行');
                    error.code = 'DATA_CHANGED';
                    throw error;
                }
            };
            assertDataUnchanged();
            if (options.backup) {
                report.backup = realLocation(options.backupDir || path.join(backendDir, `uploads_backup_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`));
                for (const directory of [uploadsDir, previewsDir, dataDir]) requireSeparate(report.backup, directory);
                fs.mkdirSync(report.backup, { recursive: true });
            }
            const cleanedOriginals = new Set();
            for (const file of [...dead.map(file => ({ ...file, original: true })), ...previewCleanup]) {
                try {
                    assertDataUnchanged();
                    const hasSource = () => file.owner ? fs.existsSync(path.join(uploadsDir, file.owner))
                        : fs.readdirSync(uploadsDir).some(name => imageId(name) === file.id);
                    if (!file.original && (file.owner && !cleanedOriginals.has(file.owner) || hasSource())) continue;
                    assertUnchanged(file);
                    if (report.backup) {
                        const folder = path.join(report.backup, file.original ? 'uploads' : 'uploads_previews');
                        fs.mkdirSync(folder, { recursive: true });
                        if (fs.realpathSync(folder) !== folder) throw new Error('备份子目录不能是目录链接');
                        // 不覆盖已有备份，并兼容备份目录位于其他磁盘的情况。
                        fs.copyFileSync(file.fullPath, path.join(folder, file.name), fs.constants.COPYFILE_EXCL);
                        assertDataUnchanged();
                        assertUnchanged(file);
                        if (!file.original && hasSource()) continue;
                    }
                    fs.unlinkSync(file.fullPath);
                    if (file.original) {
                        cleanedOriginals.add(file.name);
                        report.cleanedCount++;
                        report.cleanedSize += file.size;
                    } else {
                        report.cleanedPreviewFileCount++;
                        report.cleanedPreviewSize += file.size;
                    }
                } catch (error) {
                    report.errors.push({ name: file.name, error: error.message });
                    process.exitCode = 1;
                    if (error.code === 'DATA_CHANGED') break;
                }
            }
        }
        report.cleanedTotalSize = report.cleanedSize + report.cleanedPreviewSize;
    }
    if (options.json) return console.log(JSON.stringify(report, null, 2));
    console.log(`原图目录：${uploadsDir}\n预览目录：${previewsDir}`);
    console.log(`原图：${report.imageCount} 张，${formatSize(report.imageBytes)}；预览：${report.previewCount} 张及 ${report.previewMetadataCount} 份元数据，${formatSize(report.previewBytes)}`);
    console.log(`总占用：${formatSize(report.totalMediaBytes)}`);
    for (const [ext, info] of Object.entries(extMap)) console.log(`  ${ext}：${info.count} 张，${formatSize(info.size)}`);
    if (options.statOnly) return;
    console.log(`引用中：${report.referencedCount} 张；保护期内：${report.protectedCount} 张；缺失原图：${report.missingCount} 张`);
    console.log(`待清理：${report.deadCount} 张未引用原图，${report.previewCleanupFileCount} 份预览/元数据（其中 ${report.orphanPreviewFileCount} 份无主），共 ${formatSize(report.deadSize + report.previewCleanupBytes)}`);
    if (options.clean) {
        console.log(`已清理：${report.cleanedCount} 张原图、${report.cleanedPreviewFileCount} 份预览/元数据，共 ${formatSize(report.cleanedTotalSize)}`);
        if (report.backup) console.log(`备份目录：${report.backup}`);
        for (const error of report.errors) console.error(`未完成 ${error.name}：${error.error}`);
    } else {
        const candidates = [...report.deadFiles, ...report.previewCleanupFiles];
        for (const file of options.verbose ? candidates : candidates.slice(0, 10)) console.log(`  ${file.name}  ${formatSize(file.size)}`);
        if (!options.verbose && candidates.length > 10) console.log('其余文件可加 --verbose 查看');
        console.log('当前仅检测，没有删除文件；执行清理使用 --clean，需要备份时加 --backup。');
    }
}

function formatSize(value) {
    for (const [unit, divisor] of [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]]) {
        if (value >= divisor) return `${(value / divisor).toFixed(2)} ${unit}`;
    }
    return `${value} B`;
}

try { run(parseArgs(process.argv.slice(2))); }
catch (error) { console.error(`清理未执行或已停止：${error.message}`); process.exitCode = 1; }
