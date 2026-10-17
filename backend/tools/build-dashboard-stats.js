#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStatsReader } = require('../analytics/dashboard-route');

async function main() {
    const input = path.resolve(process.argv[2] || path.join(__dirname, '../data/moments.json'));
    const output = path.resolve(process.argv[3] || path.join(__dirname, '../../dashboard-stats.json'));
    if (input === output) throw new Error('INPUT_OUTPUT_COLLISION');
    const stats = await createStatsReader(input)();
    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = output + '.' + randomUUID() + '.tmp';
    try {
        await fs.writeFile(temporary, JSON.stringify(stats), { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temporary, output);
    } finally { await fs.rm(temporary, { force: true }); }
    console.log('统计文件已生成；仅包含白名单统计字段。');
}
main().catch(() => { console.error('生成失败：请检查输入路径、JSON 数组格式和输出权限；原始文件未修改。'); process.exitCode = 1; });
