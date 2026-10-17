#!/usr/bin/env node
/**
clean-uploads.js
检测、统计并清理 backend/uploads 目录下的图片与未引用（死图片）文件。
用法：
cd backend
node tools/clean-uploads.js                     # 检测预览 + 格式统计（安全模式，不删除任何文件）
node tools/clean-uploads.js --stat              # 纯统计视图（替代原 stat-images.js）
node tools/clean-uploads.js --clean             # 执行清理（直接删除未引用的死图片）
node tools/clean-uploads.js --clean --backup    # 备份到指定目录后清理（推荐）
node tools/clean-uploads.js --verbose           # 打印全部死图片详细清单
node tools/clean-uploads.js --all               # 忽略保护时间，检测/清理所有死图片
node tools/clean-uploads.js --help              # 查看帮助
 **/

const fs = require('fs');
const path = require('path');
// 脚本位于 backend/tools，默认业务路径始终从 backend 根目录计算。
const backendDir = path.resolve(__dirname, '..');

// 支持的图片扩展名
const IMAGE_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.avif', '.svg'
]);

// 解析命令行参数
const args = process.argv.slice(2);
const options = {
    clean: false,
    backup: false,
    backupDir: '',
    all: false,
    statOnly: false,
    minAgeMs: 60 * 60 * 1000, // 默认保护 1 小时内的新上传文件，避免并发上传中途被清理
    verbose: false,
    json: false,
    uploadsDir: path.join(backendDir, 'uploads'),
    dataDir: path.join(backendDir, 'data')
};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--clean' || arg === '-c' || arg === '--delete' || arg === '-d') {
        options.clean = true;
    } else if (arg === '--stat' || arg === '-s') {
        options.statOnly = true;
    } else if (arg === '--backup' || arg === '-b') {
        options.backup = true;
    } else if (arg.startsWith('--backup-dir=')) {
        options.backup = true;
        options.backupDir = arg.split('=')[1];
    } else if (arg === '--backup-dir') {
        options.backup = true;
        options.backupDir = args[++i];
    } else if (arg === '--all') {
        options.all = true;
        options.minAgeMs = 0;
    } else if (arg.startsWith('--min-age=')) {
        options.minAgeMs = parseDuration(arg.split('=')[1]);
    } else if (arg === '--min-age') {
        options.minAgeMs = parseDuration(args[++i]);
    } else if (arg === '--verbose' || arg === '-v') {
        options.verbose = true;
    } else if (arg === '--json') {
        options.json = true;
    } else if (arg.startsWith('--uploads-dir=')) {
        options.uploadsDir = path.resolve(arg.split('=')[1]);
    } else if (arg.startsWith('--data-dir=')) {
        options.dataDir = path.resolve(arg.split('=')[1]);
    } else if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
    }
}

// 格式化时间与文件体积工具函数
function parseDuration(str) {
    if (!str) return 0;
    const match = String(str).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'h').toLowerCase();
    switch (unit) {
        case 'ms': return num;
        case 's': return num * 1000;
        case 'm': return num * 60 * 1000;
        case 'h': return num * 60 * 60 * 1000;
        case 'd': return num * 24 * 60 * 60 * 1000;
        default: return num * 60 * 60 * 1000;
    }
}

function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
}

function formatDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function printHelp() {
    console.log(`
clean-uploads.js - 统计、检测并清理 backend/uploads 下的图片文件

用法：
  node tools/clean-uploads.js [选项]

选项：
  --stat, -s            纯统计视图（统计图片总数、格式分布、时间范围、体积，不检测引用）
  --clean, -c           执行清理（删除未引用的死图片，默认为预览模式）
  --backup, -b          清理时将图片移动到备份目录而非直接删除
  --backup-dir <path>   指定备份目录（默认: backend/uploads_backup_<时间戳>）
  --all                 忽略创建时间保护，检测/清理所有死图片（默认保护 1 小时内新文件）
  --min-age <duration>  自定义保护时间，如: 30m, 2h, 1d, 0（默认: 1h）
  --verbose, -v         显示全部未引用图片的完整列表
  --json                输出 JSON 格式的统计或清理结果
  --uploads-dir <path>  自定义 uploads 目录路径
  --data-dir <path>     自定义 data 目录路径
  --help, -h            显示此帮助信息

示例：
  node tools/clean-uploads.js                     # 检测预览 + 格式分布
  node tools/clean-uploads.js --stat              # 纯统计输出（兼容 stat-images.js）
  node tools/clean-uploads.js --clean             # 执行清理
  node tools/clean-uploads.js --clean --backup    # 安全清理（先备份）
  node tools/clean-uploads.js --clean --all       # 清理所有死图片（不设时间保护）
`);
}

// 主流程
function run() {
    const { uploadsDir, dataDir } = options;

    if (!fs.existsSync(uploadsDir)) {
        console.error(`错误：Uploads 目录不存在: ${uploadsDir}`);
        process.exit(1);
    }
    if (!options.statOnly && !fs.existsSync(dataDir)) {
        console.error(`错误：Data 目录不存在: ${dataDir}`);
        process.exit(1);
    }

    // 1. 扫描 backend/uploads 目录所有文件
    const now = Date.now();
    const uploadEntries = fs.readdirSync(uploadsDir, { withFileTypes: true });

    const totalFiles = [];
    const imageFiles = [];
    const nonImageFiles = [];

    let totalUploadsBytes = 0;
    let totalImagesBytes = 0;
    let nonImageBytes = 0;

    const extMap = {}; // 格式分布统计: ext -> { count, size }

    for (const entry of uploadEntries) {
        if (!entry.isFile()) continue;

        const name = entry.name;
        const fullPath = path.join(uploadsDir, name);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (e) {
            continue;
        }

        totalUploadsBytes += stat.size;
        const ext = path.extname(name).toLowerCase() || '(无扩展名)';
        const fileInfo = {
            name,
            ext,
            size: stat.size,
            mtime: stat.mtime,
            fullPath
        };
        totalFiles.push(fileInfo);

        if (IMAGE_EXTS.has(ext)) {
            imageFiles.push(fileInfo);
            totalImagesBytes += stat.size;

            if (!extMap[ext]) extMap[ext] = { count: 0, size: 0 };
            extMap[ext].count++;
            extMap[ext].size += stat.size;
        } else {
            nonImageFiles.push(fileInfo);
            nonImageBytes += stat.size;
        }
    }

    // 最新与最早图片
    const newestImage = imageFiles.length > 0 ? imageFiles.reduce((a, b) => (a.mtime > b.mtime ? a : b)) : null;
    const oldestImage = imageFiles.length > 0 ? imageFiles.reduce((a, b) => (a.mtime < b.mtime ? a : b)) : null;

    // 纯统计模式 (--stat)
    if (options.statOnly) {
        if (options.json) {
            console.log(JSON.stringify({
                uploadsDir,
                totalFiles: totalFiles.length,
                totalBytes: totalUploadsBytes,
                imageCount: imageFiles.length,
                imageBytes: totalImagesBytes,
                extMap,
                newestImage: newestImage ? { name: newestImage.name, mtime: newestImage.mtime } : null,
                oldestImage: oldestImage ? { name: oldestImage.name, mtime: oldestImage.mtime } : null,
                otherFiles: nonImageFiles.map(f => ({ name: f.name, size: f.size }))
            }, null, 2));
            return;
        }

        console.log('═'.repeat(60));
        console.log('  图片统计：' + uploadsDir);
        console.log('═'.repeat(60));
        console.log(`图片数量：${imageFiles.length} 张`);
        console.log(`图片占用：${formatSize(totalImagesBytes)}（${totalImagesBytes} 字节）`);
        console.log('─'.repeat(60));
        if (imageFiles.length > 0) {
            console.log('按格式分布：');
            const sortedExts = Object.entries(extMap).sort((a, b) => b[1].count - a[1].count);
            for (const [ext, info] of sortedExts) {
                console.log(`  ${ext.padEnd(10)} ${String(info.count).padStart(5)} 张   ${formatSize(info.size).padStart(10)}`);
            }
            console.log('─'.repeat(60));
            console.log(`最新图片：${newestImage.name}（${formatDate(newestImage.mtime)}）`);
            console.log(`最早图片：${oldestImage.name}（${formatDate(oldestImage.mtime)}）`);
            console.log('─'.repeat(60));
        }
        if (nonImageFiles.length > 0) {
            console.log(`其他文件：${nonImageFiles.length} 个，占 ${formatSize(nonImageBytes)}`);
            for (const f of nonImageFiles) {
                console.log(`  - ${f.name}（${formatSize(f.size)}）`);
            }
            console.log('─'.repeat(60));
        }
        console.log(`目录总占用：${formatSize(totalUploadsBytes)}（${totalUploadsBytes} 字节）`);
        console.log('═'.repeat(60));
        return;
    }

    // 2. 收集 backend/data 中所有的图片引用
    const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
    const referencedImages = new Map();

    function addReference(rawName, sourceFile) {
        if (!rawName) return;
        let cleanName = rawName.split('?')[0].split('#')[0];
        try {
            cleanName = decodeURIComponent(cleanName);
        } catch (_) {}
        cleanName = path.basename(cleanName).trim();
        if (!cleanName) return;

        const ext = path.extname(cleanName).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) return;

        if (!referencedImages.has(cleanName)) {
            referencedImages.set(cleanName, new Set());
        }
        referencedImages.get(cleanName).add(sourceFile);
    }

    for (const dataFile of dataFiles) {
        const fullPath = path.join(dataDir, dataFile);
        let content = '';
        try {
            content = fs.readFileSync(fullPath, 'utf8');
        } catch (e) {
            console.error(`警告：无法读取数据文件 ${dataFile}:`, e.message);
            continue;
        }

        // 正则提取所有 /uploads/ 下的文件名
        const uploadRegex = /(?:https?:\/\/[^\s"'`<>]+)?\/(?:api\/)?uploads\/([^"'`<>?#\s\\]+)/g;
        let m;
        while ((m = uploadRegex.exec(content)) !== null) {
            addReference(m[1], dataFile);
        }

        // 兜底提取直接出现的带图片后缀的文件名
        const extRegex = /\b([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp|gif|bmp|heic|avif|svg))\b/gi;
        while ((m = extRegex.exec(content)) !== null) {
            addReference(m[1], dataFile);
        }
    }

    // 3. 对比引用情况
    const referencedFiles = [];
    const deadFiles = [];
    const protectedFiles = [];

    let referencedBytes = 0;
    let deadBytes = 0;
    let protectedBytes = 0;

    for (const fileInfo of imageFiles) {
        if (referencedImages.has(fileInfo.name)) {
            fileInfo.referencedBy = Array.from(referencedImages.get(fileInfo.name));
            referencedFiles.push(fileInfo);
            referencedBytes += fileInfo.size;
        } else {
            const ageMs = now - fileInfo.mtime.getTime();
            if (!options.all && options.minAgeMs > 0 && ageMs < options.minAgeMs) {
                fileInfo.ageMs = ageMs;
                protectedFiles.push(fileInfo);
                protectedBytes += fileInfo.size;
            } else {
                deadFiles.push(fileInfo);
                deadBytes += fileInfo.size;
            }
        }
    }

    // 4. 检查是否有数据引用但物理文件丢失的情况
    const missingFiles = [];
    for (const [refName, sourceFiles] of referencedImages.entries()) {
        const fullPath = path.join(uploadsDir, refName);
        if (!fs.existsSync(fullPath)) {
            missingFiles.push({
                name: refName,
                referencedBy: Array.from(sourceFiles)
            });
        }
    }

    // 5. 如果启用了 --clean，执行实际清理
    let cleanedFiles = [];
    let cleanedBytes = 0;
    let backupPath = null;

    if (options.clean && deadFiles.length > 0) {
        if (options.backup) {
            backupPath = options.backupDir
                ? path.resolve(options.backupDir)
                : path.join(backendDir, `uploads_backup_${Date.now()}`);
            if (!fs.existsSync(backupPath)) {
                fs.mkdirSync(backupPath, { recursive: true });
            }
        }

        for (const file of deadFiles) {
            try {
                if (options.backup) {
                    const dest = path.join(backupPath, file.name);
                    fs.renameSync(file.fullPath, dest);
                } else {
                    fs.unlinkSync(file.fullPath);
                }
                cleanedFiles.push(file);
                cleanedBytes += file.size;
            } catch (err) {
                console.error(`清理失败 [${file.name}]:`, err.message);
            }
        }
    }

    // 6. 输出报告
    if (options.json) {
        console.log(JSON.stringify({
            mode: options.clean ? 'clean' : 'preview',
            backup: options.backup ? backupPath : null,
            totalFilesCount: totalFiles.length,
            totalFilesSize: totalUploadsBytes,
            imageCount: imageFiles.length,
            imageBytes: totalImagesBytes,
            referencedCount: referencedFiles.length,
            referencedSize: referencedBytes,
            deadCount: deadFiles.length,
            deadSize: deadBytes,
            protectedCount: protectedFiles.length,
            protectedSize: protectedBytes,
            nonImageCount: nonImageFiles.length,
            nonImageSize: nonImageBytes,
            missingCount: missingFiles.length,
            cleanedCount: cleanedFiles.length,
            cleanedSize: cleanedBytes,
            extMap,
            newestImage: newestImage ? { name: newestImage.name, mtime: newestImage.mtime } : null,
            oldestImage: oldestImage ? { name: oldestImage.name, mtime: oldestImage.mtime } : null,
            deadFiles: deadFiles.map(f => ({ name: f.name, size: f.size, mtime: f.mtime })),
            missingFiles
        }, null, 2));
        return;
    }

    console.log('\n' + '═'.repeat(60));
    console.log('       Uploads 图片引用检测与清理报告');
    console.log('═'.repeat(60));
    console.log(`扫描目录: uploads => ${uploadsDir}`);
    console.log(`数据目录: data    => ${dataDir}`);
    console.log(`数据源  : ${dataFiles.join(', ')}`);
    console.log('─'.repeat(60));
    console.log(`📁 目录总文件数  : ${totalFiles.length} 个  (${formatSize(totalUploadsBytes)})`);
    console.log(`   ├─ 正式引用图片: ${referencedFiles.length} 个  (${formatSize(referencedBytes)})`);
    console.log(`   ├─ 💀 死图片(未引用): ${deadFiles.length} 个  (${formatSize(deadBytes)})`);
    if (protectedFiles.length > 0) {
        console.log(`   ├─ ⏳ 保护中近期上传: ${protectedFiles.length} 个  (${formatSize(protectedBytes)}) [小于 ${(options.minAgeMs / 3600000).toFixed(1)} 小时]`);
    }
    if (nonImageFiles.length > 0) {
        console.log(`   └─ 📄 非图片文件    : ${nonImageFiles.length} 个  (${formatSize(nonImageBytes)}) [跳过不清理]`);
        for (const f of nonImageFiles) {
            console.log(`        • ${f.name} (${formatSize(f.size)})`);
        }
    }
    console.log('─'.repeat(60));

    if (imageFiles.length > 0) {
        console.log('📊 图片格式分布统计：');
        const sortedExts = Object.entries(extMap).sort((a, b) => b[1].count - a[1].count);
        for (const [ext, info] of sortedExts) {
            console.log(`   ${ext.padEnd(8)} ${String(info.count).padStart(5)} 张   ${formatSize(info.size).padStart(10)}`);
        }
        if (newestImage && oldestImage) {
            console.log(`   最新图片: ${newestImage.name} (${formatDate(newestImage.mtime)})`);
            console.log(`   最早图片: ${oldestImage.name} (${formatDate(oldestImage.mtime)})`);
        }
        console.log('─'.repeat(60));
    }

    if (missingFiles.length > 0) {
        console.log(`⚠️  发现 ${missingFiles.length} 个在 data 中引用但在 uploads 中缺失的图片:`);
        for (const m of missingFiles.slice(0, 10)) {
            console.log(`    - ${m.name} (来源: ${m.referencedBy.join(', ')})`);
        }
        if (missingFiles.length > 10) {
            console.log(`    ... 其余 ${missingFiles.length - 10} 个省略`);
        }
        console.log('─'.repeat(60));
    } else {
        console.log('✅ 数据完整性校验通过：data 中引用的全部图片均存在于 uploads 中。');
        console.log('─'.repeat(60));
    }

    if (options.clean) {
        if (cleanedFiles.length > 0) {
            if (options.backup) {
                console.log(`🎉 清理完成！已将 ${cleanedFiles.length} 个死图片安全移动至备份目录:`);
                console.log(`   📦 备份路径: ${backupPath}`);
            } else {
                console.log(`🎉 清理完成！已永久删除 ${cleanedFiles.length} 个死图片。`);
            }
            console.log(`   💾 本次释放磁盘空间: ${formatSize(cleanedBytes)}`);
        } else {
            console.log('✨ 没有需要清理的死图片。');
        }
    } else {
        if (deadFiles.length > 0) {
            console.log(`🔍 检测到 ${deadFiles.length} 个死图片，预计可释放空间: ${formatSize(deadBytes)}`);
            const displayList = options.verbose ? deadFiles : deadFiles.slice(0, 10);
            console.log(`\n📋 ${options.verbose ? '全部' : '部分'}死图片列表${options.verbose ? '' : '（展示前 10 个，加 --verbose 查看全部）'}:`);
            for (const f of displayList) {
                console.log(`   - ${f.name.padEnd(24)} ${formatSize(f.size).padStart(9)}   修改于: ${formatDate(f.mtime)}`);
            }
            if (!options.verbose && deadFiles.length > 10) {
                console.log(`   ... 还有 ${deadFiles.length - 10} 个未展示`);
            }
            console.log('\n💡 提示：当前为【检测预览模式（Dry Run）】，没有文件被删除。');
            console.log('   如需执行清理，可使用以下命令：');
            console.log('   1. 备份后清理（推荐，安全可逆）：');
            console.log('      node tools/clean-uploads.js --clean --backup');
            console.log('   2. 直接删除死图片：');
            console.log('      node tools/clean-uploads.js --clean');
            console.log('   3. 清理全部（包含近期 1 小时内）：');
            console.log('      node tools/clean-uploads.js --clean --all\n');
        } else {
            console.log('🎉 恭喜！uploads 文件夹非常干净，未发现任何死图片。');
        }
    }
    console.log('═'.repeat(60) + '\n');
}

run();
