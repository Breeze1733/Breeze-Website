'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USER_IDS = ['A', 'B'];

// Deployment tooling can generate this object without writing raw keys to disk.
async function createAuthConfig(keys) {
    if (!keys || USER_IDS.some(uid => typeof keys[uid] !== 'string' || !keys[uid] || Buffer.byteLength(keys[uid]) > 1024)) {
        throw new Error('Both user keys are required');
    }
    if (keys.A === keys.B) throw new Error('User keys must differ');
    const users = {};
    for (const uid of USER_IDS) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await scrypt(keys[uid], Buffer.from(salt, 'hex'), 64, SCRYPT_OPTIONS);
        users[uid] = { salt, hash: hash.toString('hex') };
    }
    return { version: 1, signing_key: crypto.randomBytes(32).toString('hex'), users };
}

function readAuthConfig(authFile) {
    try {
        const stat = fs.statSync(authFile);
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
            throw new Error('Invalid permissions');
        }
        const config = JSON.parse(fs.readFileSync(authFile, 'utf8'));
        if (config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.signing_key)) throw new Error('Invalid signing key');
        for (const uid of USER_IDS) {
            const user = config.users?.[uid];
            if (!user || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{128}$/.test(user.hash)) {
                throw new Error('Invalid password hash');
            }
        }
        return config;
    } catch {
        throw new Error('Authentication configuration is missing or invalid; provide a private 0600 auth.json');
    }
}

function passwordVersion(config, uid) {
    const user = config.users[uid];
    return crypto.createHmac('sha256', Buffer.from(config.signing_key, 'hex'))
        .update(`${uid}:${user.salt}:${user.hash}`).digest('base64url');
}

function sign(config, content) {
    return crypto.createHmac('sha256', Buffer.from(config.signing_key, 'hex')).update(content).digest();
}

function issueSession(config, uid) {
    const issued = Math.floor(Date.now() / 1000);
    const expires = issued + SESSION_SECONDS;
    const payload = Buffer.from(JSON.stringify({ uid, iat: issued, exp: expires, pv: passwordVersion(config, uid) })).toString('base64url');
    const content = `v1.${payload}`;
    return { token: `${content}.${sign(config, content).toString('base64url')}`, expires_at: new Date(expires * 1000).toISOString() };
}

function verifySession(config, token) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.toString('base64url') !== parts[2] || !crypto.timingSafeEqual(signature, sign(config, `${parts[0]}.${parts[1]}`))) return null;
    try {
        const bytes = Buffer.from(parts[1], 'base64url');
        if (bytes.toString('base64url') !== parts[1]) return null;
        const session = JSON.parse(bytes.toString('utf8'));
        if (!session || Array.isArray(session) || Object.keys(session).sort().join(',') !== 'exp,iat,pv,uid') return null;
        const now = Math.floor(Date.now() / 1000);
        if (!USER_IDS.includes(session.uid) || !Number.isSafeInteger(session.iat) || !Number.isSafeInteger(session.exp) ||
            session.iat < 0 || session.iat > now + 30 || session.exp <= now || session.exp <= session.iat ||
            session.exp - session.iat !== SESSION_SECONDS || typeof session.pv !== 'string') return null;
        const actualVersion = Buffer.from(session.pv);
        const expectedVersion = Buffer.from(passwordVersion(config, session.uid));
        if (actualVersion.length !== expectedVersion.length || !crypto.timingSafeEqual(actualVersion, expectedVersion)) return null;
        return { user_id: session.uid };
    } catch {
        return null;
    }
}

function installAuth({ app, registerRoute, authFile }) {
    // Fail closed before startup can create or migrate application data.
    readAuthConfig(authFile);
    const attempts = new Map();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 12;
    let activeLogins = 0;

    registerRoute('post', '/auth/login', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const ip = req.ip;
        const now = Date.now();
        for (const [address, bucket] of attempts) {
            if (bucket.until <= now) attempts.delete(address);
        }
        let bucket = attempts.get(ip);
        if (!bucket) {
            if (attempts.size >= 10000) attempts.delete(attempts.keys().next().value);
            bucket = { count: 0, until: now + windowMs };
            attempts.set(ip, bucket);
        }
        if (bucket.count >= maxAttempts) {
            res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000)));
            return res.status(429).json({ ok: false, error: '尝试次数过多，请稍后重试' });
        }
        bucket.count++;
        const key = req.body?.key;
        if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) {
            return res.status(401).json({ ok: false, error: '密钥无效' });
        }
        if (activeLogins >= 8) return res.status(503).json({ ok: false, error: '登录繁忙，请稍后重试' });
        activeLogins++;
        try {
            const config = readAuthConfig(authFile);
            const matches = await Promise.all(USER_IDS.map(async uid => {
                const user = config.users[uid];
                const hash = await scrypt(key, Buffer.from(user.salt, 'hex'), 64, SCRYPT_OPTIONS);
                return crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
            }));
            const index = matches.findIndex(Boolean);
            if (index < 0) return res.status(401).json({ ok: false, error: '密钥无效' });
            attempts.delete(ip);
            const userId = USER_IDS[index];
            return res.json({ ok: true, data: { user_id: userId, ...issueSession(config, userId) } });
        } catch {
            return res.status(503).json({ ok: false, error: '登录暂不可用' });
        } finally {
            activeLogins--;
        }
    });

    // Match Express's case-insensitive route handling as well as the /api rewrite.
    app.use((req, res, next) => {
        if (!/^\/(?:users|moments|topics|notifications|upload|uploads)(?:\/|$)/i.test(req.path)) return next();
        res.vary('Authorization');
        res.set('Cache-Control', /^\/uploads(?:\/|$)/i.test(req.path) ? 'private, max-age=0, must-revalidate' : 'private, no-store');
        const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(req.headers.authorization || '');
        let session = null;
        try {
            if (match) session = verifySession(readAuthConfig(authFile), match[1]);
        } catch {
            return res.status(503).json({ ok: false, error: '身份验证暂不可用' });
        }
        if (!session) return res.status(401).json({ ok: false, error: '请重新登录' });
        req.auth = session;
        return next();
    });
}

module.exports = { createAuthConfig, installAuth };
