'use strict';

// No network, model, image decoding, or third-party dependencies.
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const BOUNDARY = 6 * 3600000;
const AUTHORS = ['A', 'B'];
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

function validDate(value) {
    if (typeof value !== 'string' || !/^(19[7-9]\d|20\d{2}|2100)-\d{2}-\d{2}$/.test(value)) return false;
    const ms = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
const dateAt = (ms, effective = false) => new Date(ms + OFFSET - (effective ? BOUNDARY : 0)).toISOString().slice(0, 10);
const shiftDate = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const round = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const sum = a => a.reduce((s, v) => s + v, 0);
const mean = a => a.length ? round(sum(a) / a.length) : null;
const percent = (n, d) => d ? round(n / d * 100) : null;

function timestamp(value) {
    if (typeof value !== 'string') return null;
    const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/);
    if (!m || !validDate(m[1]) || +m[2] > 23 || +m[3] > 59 || +(m[4] || 0) > 59) return null;
    if (m[6] && m[6] !== 'Z' && (+m[6].slice(1, 3) > 23 || +m[6].slice(4) > 59)) return null;
    const valueMs = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}${m[5] || ''}${m[6] || '+08:00'}`);
    return Number.isFinite(valueMs) ? valueMs : null;
}

function quantile(values, q) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * q;
    const i = Math.floor(pos);
    return round(sorted[i] + (sorted[Math.ceil(pos)] - sorted[i]) * (pos - i));
}

function streak(dates, asOf) {
    let longest = 0, run = 0, previous = null;
    for (const date of dates) {
        run = previous && daysBetween(previous, date) === 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
        previous = date;
    }
    // An unfinished effective day may continue yesterday's streak.
    const current = previous && daysBetween(previous, asOf) <= 1 ? run : 0;
    return { current, longest };
}

function pearson(pairs) {
    if (pairs.length < 14) return { value: null, samples: pairs.length, reason: 'insufficient_samples' };
    const xMean = sum(pairs.map(p => p[0])) / pairs.length;
    const yMean = sum(pairs.map(p => p[1])) / pairs.length;
    let xy = 0, xx = 0, yy = 0;
    for (const [x, y] of pairs) { xy += (x - xMean) * (y - yMean); xx += (x - xMean) ** 2; yy += (y - yMean) ** 2; }
    if (!xx || !yy) return { value: null, samples: pairs.length, reason: 'zero_variance' };
    return { value: round(Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)))), samples: pairs.length, reason: null };
}

function normalize(records, now, asOf) {
    if (!Array.isArray(records)) throw new Error('INVALID_MOMENTS_FORMAT');
    const quality = { inputRecords: records.length, keptRecords: 0, invalidRecords: 0, futureRecords: 0,
        duplicateRecords: 0, missingMoodRecords: 0, invalidMoodRecords: 0, invalidCreatedAtRecords: 0, malformedCommentsRecords: 0 };
    const selected = new Map();
    for (const r of records) {
        if (!r || typeof r !== 'object' || !AUTHORS.includes(r.author_id) || !validDate(r.date_str)) { quality.invalidRecords++; continue; }
        if (r.date_str > asOf) { quality.futureRecords++; continue; }
        const rank = timestamp(r.updated_at) ?? timestamp(r.created_at) ?? -Infinity;
        const key = r.date_str + ':' + r.author_id;
        if (selected.has(key)) {
            quality.duplicateRecords++;
            if (selected.get(key).rank > rank) continue;
        }
        selected.set(key, { rank, record: r });
    }
    // Only numeric features and validated dates leave this normalization step.
    const features = [];
    for (const { record: r } of selected.values()) {
        let mood = null;
        if (r.mood === null || r.mood === undefined || r.mood === '') quality.missingMoodRecords++;
        else if ((typeof r.mood === 'number' || typeof r.mood === 'string') && Number.isInteger(Number(r.mood)) && +r.mood >= 1 && +r.mood <= 10) mood = +r.mood;
        else quality.invalidMoodRecords++;
        let created = timestamp(r.created_at);
        if (created === null || created > now) { quality.invalidCreatedAtRecords++; created = null; }
        let comments = r.comments ?? [];
        if (typeof comments === 'string') { try { comments = JSON.parse(comments); } catch { comments = null; } }
        if (!Array.isArray(comments)) { quality.malformedCommentsRecords++; comments = []; }
        comments = comments.filter(c => typeof c === 'string' ? c.trim().length > 0 : c && typeof c === 'object' && typeof c.content === 'string' && c.content.trim().length > 0);
        const partner = comments.filter(c => c && typeof c === 'object' && AUTHORS.includes(c.author_id) && c.author_id !== r.author_id);
        const delays = partner.map(c => timestamp(c.created_at)).filter(t => created !== null && t !== null && t >= created && t <= now).map(t => (t - created) / 60000);
        const imageList = Array.isArray(r.image_urls) ? r.image_urls : [r.self_image_url, r.partner_image_url];
        const characters = typeof r.feeling === 'string' ? Array.from(segmenter.segment(r.feeling)).reduce((n, x) => n + (/\S/u.test(x.segment) ? 1 : 0), 0) : 0;
        features.push({ date: r.date_str, author: r.author_id, characters, mood,
            photos: imageList.filter(v => typeof v === 'string' && v.trim()).length,
            comments: comments.length, partnerComments: partner.length,
            responseMinutes: delays.length ? Math.min(...delays) : null,
            created, hour: created === null ? null : new Date(created + OFFSET).getUTCHours(),
            backfilled: created !== null && dateAt(created, true) > r.date_str });
    }
    features.sort((a, b) => a.date.localeCompare(b.date) || a.author.localeCompare(b.author));
    quality.keptRecords = features.length;
    return { features, quality };
}

function personStats(rows, calendarDays, end) {
    const moods = rows.filter(r => r.mood !== null).map(r => r.mood);
    const moodMean = moods.length ? sum(moods) / moods.length : null;
    const replyRows = rows.filter(r => r.responseMinutes !== null);
    const hours = Array(24).fill(0), weekdays = Array(7).fill(0), moodHistogram = Array(10).fill(0), lengthHistogram = Array(4).fill(0);
    for (const r of rows) {
        if (r.hour !== null) hours[r.hour]++;
        weekdays[(new Date(r.date + 'T00:00:00Z').getUTCDay() + 6) % 7]++;
        if (r.mood !== null) moodHistogram[r.mood - 1]++;
        lengthHistogram[r.characters < 200 ? 0 : r.characters < 500 ? 1 : r.characters < 1000 ? 2 : 3]++;
    }
    const repliedEntries = rows.filter(r => r.partnerComments > 0).length;
    return { entries: rows.length, characters: sum(rows.map(r => r.characters)), photos: sum(rows.map(r => r.photos)),
        comments: sum(rows.map(r => r.comments)), partnerComments: sum(rows.map(r => r.partnerComments)),
        coverage: percent(rows.length, calendarDays), meanCharacters: mean(rows.map(r => r.characters)),
        medianCharacters: quantile(rows.map(r => r.characters), .5), p90Characters: quantile(rows.map(r => r.characters), .9),
        moodMean: round(moodMean), moodSamples: moods.length, moodMedian: quantile(moods, .5),
        moodStdDev: moods.length ? round(Math.sqrt(sum(moods.map(m => (m - moodMean) ** 2)) / moods.length)) : null,
        repliedEntries, replyRate: percent(repliedEntries, rows.length), responseMedianMinutes: quantile(replyRows.map(r => r.responseMinutes), .5),
        responseSamples: replyRows.length, backfilledEntries: rows.filter(r => r.backfilled).length,
        streak: streak(rows.map(r => r.date), end), hours, weekdays, moodHistogram, lengthHistogram };
}

function buildReport(features, start, end) {
    const rows = features.filter(r => r.date >= start && r.date <= end);
    const calendarDays = daysBetween(start, end) + 1;
    const people = Object.fromEntries(AUTHORS.map(a => [a, personStats(rows.filter(r => r.author === a), calendarDays, end)]));
    const map = new Map();
    for (const r of rows) { if (!map.has(r.date)) map.set(r.date, {}); map.get(r.date)[r.author] = r; }
    const series = [], pairs = [], gaps = [], postingGaps = [], bothDates = [];
    const rolling = { A: [], B: [] };
    for (let date = start; date <= end; date = shiftDate(date, 1)) {
        const day = map.get(date) || {};
        const point = { date };
        for (const a of AUTHORS) {
            const r = day[a];
            point[a] = { entries: r ? 1 : 0, characters: r?.characters || 0, photos: r?.photos || 0, comments: r?.comments || 0, mood: r?.mood ?? null };
            rolling[a].push(point[a]);
            if (rolling[a].length > 7) rolling[a].shift();
            const validMoods = rolling[a].filter(v => v.mood !== null).map(v => v.mood);
            point[a].moodRolling7 = validMoods.length >= 3 ? mean(validMoods) : null;
            point[a].moodRollingSamples = validMoods.length;
            point[a].charactersRolling7 = rolling[a].length === 7 ? mean(rolling[a].map(v => v.characters)) : null;
        }
        if (day.A && day.B) {
            bothDates.push(date);
            if (day.A.mood !== null && day.B.mood !== null) { pairs.push([day.A.mood, day.B.mood]); gaps.push(Math.abs(day.A.mood - day.B.mood)); }
            if (day.A.created !== null && day.B.created !== null) postingGaps.push(Math.abs(day.A.created - day.B.created) / 60000);
        }
        series.push(point);
    }
    const moods = rows.filter(r => r.mood !== null).map(r => r.mood);
    const summary = { entries: rows.length, activeDays: map.size, bothDays: bothDates.length,
        coverage: percent(map.size, calendarDays), bothCoverage: percent(bothDates.length, calendarDays),
        characters: people.A.characters + people.B.characters, photos: people.A.photos + people.B.photos,
        comments: people.A.comments + people.B.comments, moodMean: mean(moods), moodSamples: moods.length,
        streak: streak([...map.keys()], end), bothStreak: streak(bothDates, end) };
    const months = new Map();
    for (const p of series) {
        const key = p.date.slice(0, 7);
        if (!months.has(key)) months.set(key, { month: key, days: 0, activeDays: 0, bothDays: 0, entriesA: 0, entriesB: 0, characters: 0, photos: 0, moods: [] });
        const m = months.get(key); m.days++; m.activeDays += +(!!p.A.entries || !!p.B.entries); m.bothDays += +(!!p.A.entries && !!p.B.entries);
        m.entriesA += p.A.entries; m.entriesB += p.B.entries; m.characters += p.A.characters + p.B.characters; m.photos += p.A.photos + p.B.photos;
        for (const a of AUTHORS) if (p[a].mood !== null) m.moods.push(p[a].mood);
    }
    return { period: { start, end, calendarDays }, summary, people,
        shared: { pairedMoodDays: pairs.length, closeMoodDays: gaps.filter(g => g <= 1).length,
            closeMoodRate: percent(gaps.filter(g => g <= 1).length, pairs.length), meanMoodGap: mean(gaps),
            correlation: pearson(pairs), postingGapMedianMinutes: quantile(postingGaps, .5), postingGapSamples: postingGaps.length },
        series, months: [...months.values()].map(({ moods: monthMoods, ...m }) => ({ ...m, coverage: percent(m.activeDays, m.days), moodMean: mean(monthMoods), moodSamples: monthMoods.length })) };
}

function analyzeMoments(records, options = {}) {
    const now = options.now === undefined ? Date.now() : new Date(options.now).getTime();
    if (!Number.isFinite(now)) throw new Error('INVALID_ANALYSIS_TIME');
    const asOf = dateAt(now, true);
    if (!validDate(asOf)) throw new Error('UNSUPPORTED_ANALYSIS_DATE');
    const { features, quality } = normalize(records, now, asOf);
    const firstDate = features[0]?.date || asOf;
    const starts = { all: firstDate, last30: shiftDate(asOf, -29), last90: shiftDate(asOf, -89), year: asOf.slice(0, 4) + '-01-01' };
    const reports = {};
    for (const [key, requestedStart] of Object.entries(starts)) {
        const start = firstDate > requestedStart ? firstDate : requestedStart;
        const report = buildReport(features, start, asOf);
        report.period.requestedStart = requestedStart;
        const previousStart = shiftDate(start, -report.period.calendarDays), previousEnd = shiftDate(start, -1);
        report.comparison = null;
        if (key !== 'all' && features.length && previousStart >= firstDate) {
            const previous = buildReport(features, previousStart, previousEnd).summary;
            report.comparison = { start: previousStart, end: previousEnd, entries: previous.entries, characters: previous.characters,
                entriesChange: previous.entries ? round((report.summary.entries - previous.entries) / previous.entries * 100) : null,
                charactersChange: previous.characters ? round((report.summary.characters - previous.characters) / previous.characters * 100) : null };
        }
        reports[key] = report;
    }
    return { schemaVersion: 1, meta: { generatedAt: new Date(now).toISOString(), asOfDate: asOf, timezone: 'Asia/Shanghai',
        dayBoundaryHour: 6, firstDate: features.length ? firstDate : null, quality }, reports };
}

module.exports = { analyzeMoments, validDate, timestamp, quantile, pearson, shiftDate };
