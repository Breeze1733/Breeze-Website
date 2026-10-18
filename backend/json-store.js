'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class DataStoreError extends Error {
    constructor(filePath, cause) {
        super(`数据文件 ${path.basename(filePath)} 读写失败，请检查服务端数据后重试`, { cause });
        this.name = 'DataStoreError';
    }
}

function readJsonArray(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error('Expected a JSON array');
        return data;
    } catch (err) {
        // A missing, unreadable or malformed database must never become an empty one.
        throw new DataStoreError(filePath, err);
    }
}

function writeJsonArray(filePath, data) {
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let fd;
    try {
        if (!Array.isArray(data)) throw new Error('Expected a JSON array');
        fd = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporaryPath, filePath);
    } catch (err) {
        throw new DataStoreError(filePath, err);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporaryPath); } catch (err) {
            if (err.code !== 'ENOENT') console.error('清理临时数据文件失败:', err);
        }
    }
}

module.exports = { DataStoreError, readJsonArray, writeJsonArray };
