'use strict';

const BLOCK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AUTHORS = new Set(['A', 'B']);
const MAX_BLOCKS = 1000;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_TOTAL_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_URL_BYTES = 4096;

class SharedMomentValidationError extends Error {
    constructor(status, message, code = 'invalid_shared_moment') {
        super(message);
        this.name = 'SharedMomentValidationError';
        this.status = status;
        this.code = code;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
    if (!isPlainObject(value)) {
        throw new SharedMomentValidationError(400, `${label} 必须是对象`);
    }
    const unexpected = Object.keys(value).filter(key => !allowed.has(key));
    if (unexpected.length) {
        throw new SharedMomentValidationError(400, `${label} 包含未知字段：${unexpected.join(', ')}`);
    }
}

function assertBlockId(value, label = 'block id') {
    if (typeof value !== 'string' || !BLOCK_ID.test(value)) {
        throw new SharedMomentValidationError(400, `${label} 无效`);
    }
    return value;
}

function validateOptionalTimestamp(value, label) {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        throw new SharedMomentValidationError(400, `${label} 无效`);
    }
}

function coreBlock(block) {
    if (block.type === 'text') {
        return {
            id: block.id,
            type: 'text',
            author_id: block.author_id,
            text: block.text
        };
    }
    return {
        id: block.id,
        type: 'image',
        author_id: block.author_id,
        image_url: block.image_url
    };
}

function sameCore(left, right) {
    return JSON.stringify(coreBlock(left)) === JSON.stringify(coreBlock(right));
}

function parseIncomingBlocks(rawBlocks, normalizeImageUrl) {
    if (!Array.isArray(rawBlocks)) {
        throw new SharedMomentValidationError(400, 'blocks 必须是数组');
    }
    if (rawBlocks.length > MAX_BLOCKS) {
        throw new SharedMomentValidationError(400, `blocks 最多允许 ${MAX_BLOCKS} 项`);
    }

    const blocks = [];
    const ids = new Set();
    let totalTextBytes = 0;

    for (let index = 0; index < rawBlocks.length; index++) {
        const raw = rawBlocks[index];
        const label = `blocks[${index}]`;
        if (!isPlainObject(raw)) {
            throw new SharedMomentValidationError(400, `${label} 必须是对象`);
        }
        const type = raw.type;
        const allowed = ['text', 'image'].includes(type)
            ? new Set(['id', 'type', 'author_id', 'text', 'image_url', 'created_at', 'updated_at'])
            : null;
        if (!allowed) {
            throw new SharedMomentValidationError(400, `${label}.type 只允许 text 或 image`);
        }
        assertOnlyKeys(raw, allowed, label);

        const id = assertBlockId(raw.id, `${label}.id`);
        if (ids.has(id)) {
            throw new SharedMomentValidationError(400, `block id 重复：${id}`);
        }
        ids.add(id);
        if (!AUTHORS.has(raw.author_id)) {
            throw new SharedMomentValidationError(400, `${label}.author_id 无效`);
        }
        validateOptionalTimestamp(raw.created_at, `${label}.created_at`);
        validateOptionalTimestamp(raw.updated_at, `${label}.updated_at`);

        if (type === 'text') {
            if (raw.image_url !== undefined && raw.image_url !== '') {
                throw new SharedMomentValidationError(400, `${label}.image_url 只能用于 image 块`);
            }
            // A standalone newline or space is meaningful in a continuous
            // document, including at author boundaries.
            if (typeof raw.text !== 'string' || !raw.text.length) {
                throw new SharedMomentValidationError(400, `${label}.text 不能为空`);
            }
            const textBytes = Buffer.byteLength(raw.text);
            if (textBytes > MAX_TEXT_BYTES) {
                throw new SharedMomentValidationError(400, `${label}.text 过长`);
            }
            totalTextBytes += textBytes;
            if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
                throw new SharedMomentValidationError(400, '共记文字总长度过长');
            }
            blocks.push({ id, type, author_id: raw.author_id, text: raw.text });
            continue;
        }

        if (raw.text !== undefined && raw.text !== '') {
            throw new SharedMomentValidationError(400, `${label}.text 只能用于 text 块`);
        }
        if (typeof raw.image_url !== 'string' || !raw.image_url.trim()) {
            throw new SharedMomentValidationError(400, `${label}.image_url 不能为空`);
        }
        if (Buffer.byteLength(raw.image_url) > MAX_IMAGE_URL_BYTES) {
            throw new SharedMomentValidationError(400, `${label}.image_url 过长`);
        }
        const imageUrl = normalizeImageUrl(raw.image_url.trim());
        blocks.push({ id, type, author_id: raw.author_id, image_url: imageUrl });
    }
    return blocks;
}

function parseOneSplitDescriptor(raw, existingById, incomingById, actorId, label) {
    if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'fragments')) {
        return parseMultiSplitDescriptor(raw, existingById, incomingById, actorId, label);
    }
    const fields = new Set([
        'source_block_id',
        'left_text',
        'inserted_block_id',
        'right_block_id',
        'right_text'
    ]);
    assertOnlyKeys(raw, fields, label);
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(raw, field)) {
            throw new SharedMomentValidationError(400, `${label} 缺少 ${field}`);
        }
    }

    const sourceId = assertBlockId(raw.source_block_id, `${label}.source_block_id`);
    const insertedId = assertBlockId(raw.inserted_block_id, `${label}.inserted_block_id`);
    if (typeof raw.left_text !== 'string' || typeof raw.right_text !== 'string') {
        throw new SharedMomentValidationError(400, `${label} 的左右文字必须是字符串`);
    }
    const source = existingById.get(sourceId);
    if (!source || source.type !== 'text') {
        throw new SharedMomentValidationError(409, '要拆分的文字块已不存在，请刷新后重试', 'split_source_changed');
    }
    if (source.author_id === actorId) {
        throw new SharedMomentValidationError(400, '自己的文字块无需使用 split_foreign_text');
    }
    if (raw.left_text + raw.right_text !== source.text) {
        throw new SharedMomentValidationError(403, '拆分不得改写对方的文字', 'forbidden_block_change');
    }

    const inserted = incomingById.get(insertedId);
    if (!inserted || inserted.author_id !== actorId || inserted.type !== 'text') {
        throw new SharedMomentValidationError(400, '插入块必须是当前用户新增的文字块');
    }
    if (existingById.has(insertedId)) {
        throw new SharedMomentValidationError(400, '插入块必须使用新的 block id');
    }

    let rightId = null;
    if (raw.right_text) {
        rightId = assertBlockId(raw.right_block_id, `${label}.right_block_id`);
        if (rightId === sourceId || rightId === insertedId || existingById.has(rightId)) {
            throw new SharedMomentValidationError(400, '右侧文字块必须使用新的 block id');
        }
        const right = incomingById.get(rightId);
        if (!right || right.type !== 'text' || right.author_id !== source.author_id || right.text !== raw.right_text) {
            throw new SharedMomentValidationError(400, '右侧文字块与 split_foreign_text 不一致');
        }
    } else if (raw.right_block_id !== null && raw.right_block_id !== '') {
        throw new SharedMomentValidationError(400, 'right_text 为空时 right_block_id 必须为空');
    }

    const left = incomingById.get(sourceId);
    if (raw.left_text) {
        if (!left || left.type !== 'text' || left.author_id !== source.author_id || left.text !== raw.left_text) {
            throw new SharedMomentValidationError(400, '左侧文字块与 split_foreign_text 不一致');
        }
    } else if (left) {
        throw new SharedMomentValidationError(400, 'left_text 为空时原文字块必须省略');
    }

    return {
        source,
        sourceId,
        insertedId,
        rightId,
        leftText: raw.left_text,
        rightText: raw.right_text,
        sequenceIds: [
            ...(raw.left_text ? [sourceId] : []),
            insertedId,
            ...(rightId ? [rightId] : [])
        ],
        foreignBlocks: [
            ...(raw.left_text ? [incomingById.get(sourceId)] : []),
            ...(rightId ? [incomingById.get(rightId)] : [])
        ]
    };
}

function parseMultiSplitDescriptor(raw, existingById, incomingById, actorId, label) {
    assertOnlyKeys(raw, new Set(['source_block_id', 'fragments']), label);
    const sourceId = assertBlockId(raw.source_block_id, `${label}.source_block_id`);
    const source = existingById.get(sourceId);
    if (!source || source.type !== 'text') {
        throw new SharedMomentValidationError(409, '要拆分的文字块已不存在，请刷新后重试', 'split_source_changed');
    }
    if (source.author_id === actorId) {
        throw new SharedMomentValidationError(400, '自己的文字块无需使用 split_foreign_text');
    }
    if (!Array.isArray(raw.fragments) || raw.fragments.length < 2 || raw.fragments.length > MAX_BLOCKS) {
        throw new SharedMomentValidationError(400, `${label}.fragments 必须包含 2 到 ${MAX_BLOCKS} 个块 id`);
    }
    const sequenceIds = [];
    const foreignBlocks = [];
    const seen = new Set();
    let insertions = 0;
    for (let index = 0; index < raw.fragments.length; index++) {
        const id = assertBlockId(raw.fragments[index], `${label}.fragments[${index}]`);
        if (seen.has(id)) throw new SharedMomentValidationError(400, '拆分后的 block id 不能重复');
        seen.add(id);
        const block = incomingById.get(id);
        if (!block || block.type !== 'text') {
            throw new SharedMomentValidationError(400, '拆分片段必须是提交的文字块');
        }
        if (block.author_id === actorId) {
            if (existingById.has(id)) {
                throw new SharedMomentValidationError(400, '插入块必须使用新的 block id');
            }
            insertions++;
        } else {
            if (block.author_id !== source.author_id || (existingById.has(id) && id !== sourceId)) {
                throw new SharedMomentValidationError(403, '不能伪造或重排对方的内容', 'forbidden_block_change');
            }
            if (id === sourceId && foreignBlocks.length !== 0) {
                throw new SharedMomentValidationError(400, '原文字块只能作为第一个对方片段');
            }
            foreignBlocks.push(block);
        }
        sequenceIds.push(id);
    }
    if (!insertions || !foreignBlocks.length) {
        throw new SharedMomentValidationError(400, '拆分必须同时包含对方文字和当前用户的新插入');
    }
    if (foreignBlocks.map(block => block.text).join('') !== source.text) {
        throw new SharedMomentValidationError(403, '拆分不得改写对方的文字', 'forbidden_block_change');
    }
    return { source, sourceId, sequenceIds, foreignBlocks };
}

function parseSplitDescriptors(raw, existingById, incomingById, actorId) {
    if (raw === undefined || raw === null) return [];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0 || values.length > 50) {
        throw new SharedMomentValidationError(400, 'split_foreign_text 必须包含 1 到 50 个拆分描述符');
    }
    const splits = values.map((value, index) => parseOneSplitDescriptor(
        value,
        existingById,
        incomingById,
        actorId,
        Array.isArray(raw) ? `split_foreign_text[${index}]` : 'split_foreign_text'
    ));
    const claimedIds = new Set();
    for (const split of splits) {
        for (const id of new Set([split.sourceId, ...split.sequenceIds])) {
            if (claimedIds.has(id)) {
                throw new SharedMomentValidationError(400, '多个拆分描述符不能复用 block id');
            }
            claimedIds.add(id);
        }
    }
    return splits;
}

function validateAndBuildBlocks({ existingBlocks, rawBlocks, actorId, splitForeignText, now, normalizeImageUrl }) {
    if (!AUTHORS.has(actorId)) {
        throw new SharedMomentValidationError(403, '当前用户无权编辑共记日记');
    }
    const incoming = parseIncomingBlocks(rawBlocks, normalizeImageUrl);
    const incomingById = new Map(incoming.map(block => [block.id, block]));
    const existingById = new Map(existingBlocks.map(block => [block.id, block]));
    const splits = parseSplitDescriptors(splitForeignText, existingById, incomingById, actorId);
    const splitBySource = new Map(splits.map(split => [split.sourceId, split]));
    const splitByRight = new Map(splits.flatMap(split => split.foreignBlocks
        .filter(block => block.id !== split.sourceId)
        .map(block => [block.id, split])));

    for (const block of incoming) {
        const existing = existingById.get(block.id);
        if (existing) {
            if (existing.author_id !== block.author_id) {
                throw new SharedMomentValidationError(403, '不能更改文字或图片块的作者', 'forbidden_block_change');
            }
            if (existing.author_id === actorId && existing.type !== block.type) {
                throw new SharedMomentValidationError(400, '已有 block 不允许改变类型，请使用新的 block id');
            }
            if (existing.author_id !== actorId && !splitBySource.has(block.id) && !sameCore(existing, block)) {
                throw new SharedMomentValidationError(403, '不能修改对方的文字或图片', 'forbidden_block_change');
            }
            continue;
        }
        if (block.author_id !== actorId && !splitByRight.has(block.id)) {
            throw new SharedMomentValidationError(403, '不能以对方身份新增内容', 'forbidden_block_change');
        }
    }

    const expectedForeign = [];
    for (const block of existingBlocks) {
        if (block.author_id === actorId) continue;
        const split = splitBySource.get(block.id);
        if (!split) {
            expectedForeign.push(coreBlock(block));
            continue;
        }
        expectedForeign.push(...split.foreignBlocks.map(coreBlock));
    }
    const actualForeign = incoming.filter(block => block.author_id !== actorId).map(coreBlock);
    if (JSON.stringify(actualForeign) !== JSON.stringify(expectedForeign)) {
        throw new SharedMomentValidationError(403, '不能删除、重排或伪造对方的内容', 'forbidden_block_change');
    }

    for (const split of splits) {
        const expectedSequence = split.sequenceIds;
        const firstIndex = incoming.findIndex(block => block.id === expectedSequence[0]);
        const actualSequence = firstIndex < 0
            ? []
            : incoming.slice(firstIndex, firstIndex + expectedSequence.length).map(block => block.id);
        if (JSON.stringify(actualSequence) !== JSON.stringify(expectedSequence)) {
            throw new SharedMomentValidationError(400, '拆分后的左段、插入段和右段必须连续排列');
        }
    }

    return incoming.map(block => {
        const existing = existingById.get(block.id);
        if (existing) {
            return {
                ...block,
                created_at: existing.created_at,
                updated_at: sameCore(existing, block) ? existing.updated_at : now
            };
        }
        const rightSplit = splitByRight.get(block.id);
        if (rightSplit) {
            return {
                ...block,
                created_at: rightSplit.source.created_at,
                updated_at: now
            };
        }
        return { ...block, created_at: now, updated_at: now };
    });
}

function imageUrlsFromSharedMoments(documents) {
    const urls = [];
    for (const document of documents) {
        if (!Array.isArray(document?.blocks)) continue;
        for (const block of document.blocks) {
            if (block?.type === 'image' && typeof block.image_url === 'string' && block.image_url) {
                urls.push(block.image_url);
            }
        }
    }
    return urls;
}

module.exports = {
    SharedMomentValidationError,
    assertOnlyKeys,
    validateAndBuildBlocks,
    imageUrlsFromSharedMoments,
    coreBlock
};
