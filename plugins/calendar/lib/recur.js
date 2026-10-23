/**
 * Recurrence rules (RFC 5545 RRULE): parse, write, describe, and expand.
 *
 * Expansion follows the algorithm of python-dateutil's rrule, the reference
 * most calendar code is checked against: each period of the rule's
 * frequency (a year, a month, a week, a day…) gets its candidate days, the
 * BY… parts filter them through per-year masks, BYSETPOS picks positions,
 * and COUNT and UNTIL end the series. It works on wall-clock times (the
 * event's own zone, read as if it were UTC), so a 9:30 meeting stays at
 * 9:30 across daylight saving; the caller turns each one into an instant.
 * Dates that don't exist (February 30) are skipped, as the RFC says.
 *
 * @module dsh-plugin-calendar/recur
 */

const DAY = 86_400_000;
export const FREQS = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY'];
const [YEARLY, MONTHLY, WEEKLY, DAILY, HOURLY, MINUTELY, SECONDLY] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** A rule this module can't read. */
export class RuleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RuleError';
    }
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
/** Days since 1970-01-01. */
const ordOf = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
/** Monday 0 … Sunday 6. */
const weekdayOf = (ord) => (((ord + 3) % 7) + 7) % 7;
const fieldsOf = (ord) => {
    const d = new Date(ord * DAY);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
};
/** Python's divmod: the remainder takes the divisor's sign. */
const divmod = (a, b) => {
    const q = Math.floor(a / b);
    return [q, a - q * b];
};
const gcd = (a, b) => (b === 0 ? Math.abs(a) : gcd(b, a % b));
/** A list item by a Python index (negative from the end), or undefined. */
const at = (list, index) => (index < 0 ? list[list.length + index] : list[index]);

function intList(value, name, min, max, { nonzero = false } = {}) {
    const out = [];
    for (const part of value.split(',')) {
        const text = part.trim();
        if (!/^[+-]?\d+$/.test(text)) throw new RuleError(`${name} has "${text}", not a whole number`);
        const n = Number(text);
        if (n < min || n > max || (nonzero && n === 0)) throw new RuleError(`${name} has ${n}, outside ${min} to ${max}`);
        out.push(n);
    }
    return [...new Set(out)];
}

/**
 * A rule's parts from its RRULE value ('FREQ=WEEKLY;BYDAY=MO,WE').
 * @returns {{freq: number, interval: number, count?: number, until?: string, wkst: number,
 *   bySecond?: number[], byMinute?: number[], byHour?: number[], byDay?: {wd: number, n: number}[],
 *   byMonthDay?: number[], byYearDay?: number[], byWeekNo?: number[], byMonth?: number[], bySetPos?: number[]}}
 */
export function parseRule(text) {
    const rule = { freq: undefined, interval: 1, wkst: 0 };
    const raw = String(text ?? '').trim().replace(/^RRULE:/i, '');
    if (raw === '') throw new RuleError('the rule is empty');
    for (const part of raw.split(';')) {
        if (part.trim() === '') continue;
        const eq = part.indexOf('=');
        if (eq < 0) throw new RuleError(`"${part}" has no value`);
        const key = part.slice(0, eq).trim().toUpperCase();
        const value = part.slice(eq + 1).trim();
        switch (key) {
            case 'FREQ': {
                const f = FREQS.indexOf(value.toUpperCase());
                if (f < 0) throw new RuleError(`FREQ "${value}" isn't one of ${FREQS.join(', ')}`);
                rule.freq = f;
                break;
            }
            case 'INTERVAL':
                [rule.interval] = intList(value, 'INTERVAL', 1, 100000);
                break;
            case 'COUNT':
                [rule.count] = intList(value, 'COUNT', 0, 1e9);
                break;
            case 'UNTIL':
                if (!/^\d{8}(T\d{6}Z?)?$/i.test(value)) throw new RuleError(`UNTIL "${value}" isn't a date or a date-time`);
                rule.until = value.toUpperCase();
                break;
            case 'WKST': {
                const w = WEEKDAYS.indexOf(value.toUpperCase());
                if (w < 0) throw new RuleError(`WKST "${value}" isn't a weekday`);
                rule.wkst = w;
                break;
            }
            case 'BYSECOND': rule.bySecond = intList(value, key, 0, 60); break;
            case 'BYMINUTE': rule.byMinute = intList(value, key, 0, 59); break;
            case 'BYHOUR': rule.byHour = intList(value, key, 0, 23); break;
            case 'BYMONTHDAY': rule.byMonthDay = intList(value, key, -31, 31, { nonzero: true }); break;
            case 'BYYEARDAY': rule.byYearDay = intList(value, key, -366, 366, { nonzero: true }); break;
            case 'BYWEEKNO': rule.byWeekNo = intList(value, key, -53, 53, { nonzero: true }); break;
            case 'BYMONTH': rule.byMonth = intList(value, key, 1, 12); break;
            case 'BYSETPOS': rule.bySetPos = intList(value, key, -366, 366, { nonzero: true }); break;
            case 'BYDAY': {
                rule.byDay = [];
                for (const part2 of value.split(',')) {
                    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(part2.trim());
                    if (m === null) throw new RuleError(`BYDAY has "${part2}"`);
                    const n = m[1] === undefined ? 0 : Number(m[1]);
                    if (Math.abs(n) > 53) throw new RuleError(`BYDAY has ${n}, outside -53 to 53`);
                    rule.byDay.push({ wd: WEEKDAYS.indexOf(m[2].toUpperCase()), n });
                }
                break;
            }
            default:
                // An extension part (X-NAME) or one RFC 7529 adds (RSCALE, SKIP): read what we know, keep going.
                break;
        }
    }
    if (rule.freq === undefined) throw new RuleError('the rule has no FREQ');
    if (rule.count !== undefined && rule.until !== undefined) delete rule.until;
    return rule;
}

/** A rule's parts written back as an RRULE value, in the usual order. */
export function ruleText(rule) {
    const parts = [`FREQ=${FREQS[rule.freq]}`];
    if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
    if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
    else if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`);
    const list = (key, values) => { if (values?.length) parts.push(`${key}=${values.join(',')}`); };
    list('BYMONTH', rule.byMonth);
    list('BYWEEKNO', rule.byWeekNo);
    list('BYYEARDAY', rule.byYearDay);
    list('BYMONTHDAY', rule.byMonthDay);
    list('BYDAY', rule.byDay?.map(({ wd, n }) => `${n ? n : ''}${WEEKDAYS[wd]}`));
    list('BYHOUR', rule.byHour);
    list('BYMINUTE', rule.byMinute);
    list('BYSECOND', rule.bySecond);
    list('BYSETPOS', rule.bySetPos);
    if (rule.wkst !== 0) parts.push(`WKST=${WEEKDAYS[rule.wkst]}`);
    return parts.join(';');
}

// ── Expansion ──────────────────────────────────────────────────────────

/** What a year looks like to the filters: month, day of month and weekday of each day (plus 7 of next year). */
function yearMasks(year) {
    const yearlen = isLeap(year) ? 366 : 365;
    const nextyearlen = isLeap(year + 1) ? 366 : 365;
    const mrange = [0];
    for (let m = 1; m <= 12; m++) mrange.push(mrange[m - 1] + daysIn(year, m));
    const size = yearlen + 7;
    const mmask = new Int8Array(size);
    const mdaymask = new Int8Array(size);
    const nmdaymask = new Int8Array(size);
    for (let m = 1; m <= 12; m++) {
        const dim = daysIn(year, m);
        for (let d = 1; d <= dim; d++) {
            const i = mrange[m - 1] + d - 1;
            mmask[i] = m;
            mdaymask[i] = d;
            nmdaymask[i] = d - dim - 1;
        }
    }
    for (let k = 0; k < 7; k++) {
        mmask[yearlen + k] = 1;
        mdaymask[yearlen + k] = k + 1;
        nmdaymask[yearlen + k] = k - 31;
    }
    const yearordinal = ordOf(year, 1, 1);
    const yearweekday = weekdayOf(yearordinal);
    const wdaymask = new Int8Array(size);
    for (let i = 0; i < size; i++) wdaymask[i] = (yearweekday + i) % 7;
    return { year, yearlen, nextyearlen, mrange, mmask, mdaymask, nmdaymask, wdaymask, yearordinal, yearweekday };
}

/** Which days of the year are in the weeks BYWEEKNO names (weeks start on WKST; week 1 has 4 days or more of the year). */
function weekNoMask(info, byweekno, wkst) {
    const { year, yearlen, yearweekday, wdaymask } = info;
    const mask = new Uint8Array(yearlen + 7);
    let no1wkst = (7 - yearweekday + wkst) % 7;
    const firstwkst = no1wkst;
    let wyearlen;
    if (no1wkst >= 4) {
        no1wkst = 0;
        wyearlen = yearlen + ((yearweekday - wkst) % 7 + 7) % 7;
    } else {
        wyearlen = yearlen - no1wkst;
    }
    const [div, mod] = divmod(wyearlen, 7);
    const numweeks = div + Math.floor(mod / 4);
    const markWeek = (start) => {
        let i = start;
        for (let j = 0; j < 7; j++) {
            mask[i] = 1;
            i += 1;
            if (wdaymask[i] === wkst) break;
        }
    };
    for (let n of byweekno) {
        if (n < 0) n += numweeks + 1;
        if (!(n > 0 && n <= numweeks)) continue;
        let i;
        if (n > 1) {
            i = no1wkst + (n - 1) * 7;
            if (no1wkst !== firstwkst) i -= 7 - firstwkst;
        } else {
            i = no1wkst;
        }
        markWeek(i);
    }
    if (byweekno.includes(1)) {
        // Week 1 of next year may start in this one.
        let i = no1wkst + numweeks * 7;
        if (no1wkst !== firstwkst) i -= 7 - firstwkst;
        if (i < yearlen) markWeek(i);
    }
    if (no1wkst) {
        // Days before week 1 belong to the last week of last year.
        let lnumweeks;
        if (!byweekno.includes(-1)) {
            const lyearweekday = weekdayOf(ordOf(year - 1, 1, 1));
            let lno1wkst = (7 - lyearweekday + wkst) % 7;
            const lyearlen = isLeap(year - 1) ? 366 : 365;
            if (lno1wkst >= 4) {
                lno1wkst = 0;
                lnumweeks = 52 + Math.floor(((lyearlen + ((lyearweekday - wkst) % 7 + 7) % 7) % 7) / 4);
            } else {
                lnumweeks = 52 + Math.floor(((yearlen - no1wkst) % 7) / 4);
            }
        } else {
            lnumweeks = -1;
        }
        if (byweekno.includes(lnumweeks)) for (let i = 0; i < no1wkst; i++) mask[i] = 1;
    }
    return mask;
}

/** Which days are the "nth weekday" BYDAY names, in each month (MONTHLY, or YEARLY with BYMONTH) or the year. */
function nthWeekdayMask(info, freq, month, bymonth, bynweekday) {
    const ranges = [];
    if (freq === YEARLY) {
        if (bymonth) for (const m of bymonth) ranges.push([info.mrange[m - 1], info.mrange[m]]);
        else ranges.push([0, info.yearlen]);
    } else if (freq === MONTHLY) {
        ranges.push([info.mrange[month - 1], info.mrange[month]]);
    }
    if (ranges.length === 0) return null;
    const mask = new Uint8Array(info.yearlen);
    for (const [first, end] of ranges) {
        const last = end - 1;
        for (const [wday, n] of bynweekday) {
            let i;
            if (n < 0) {
                i = last + (n + 1) * 7;
                i -= ((info.wdaymask[i] - wday) % 7 + 7) % 7;
            } else {
                i = first + (n - 1) * 7;
                i += ((7 - info.wdaymask[i] + wday) % 7 + 7) % 7;
            }
            if (first <= i && i <= last) mask[i] = 1;
        }
    }
    return mask;
}

/**
 * The starts of a rule's occurrences, as wall-clock ms (the wall clock read
 * as UTC), in order, from DTSTART on.
 * @param rule - from parseRule.
 * @param {number} startWall - DTSTART as wall-clock ms.
 * @param {object} [opts]
 * @param {number} [opts.until] - UNTIL as wall-clock ms in DTSTART's zone; occurrences after it don't happen.
 * @param {number} [opts.stop] - stop once a period starts after this wall-clock ms (the end of what's wanted).
 * @param {number} [opts.skipTo] - occurrences before this may be skipped (only for rules without COUNT).
 * @returns {Generator<number>}
 */
export function* expandWall(rule, startWall, opts = {}) {
    const { until, stop = Infinity, skipTo } = opts;
    if (rule.count === 0) return;
    const freq = rule.freq;
    const interval = rule.interval || 1;
    const wkst = rule.wkst ?? 0;
    const s = new Date(startWall);
    let year = s.getUTCFullYear();
    let month = s.getUTCMonth() + 1;
    let day = s.getUTCDate();
    let hour = s.getUTCHours();
    let minute = s.getUTCMinutes();
    let second = s.getUTCSeconds();
    let weekday = weekdayOf(ordOf(year, month, day));

    let bymonth = rule.byMonth?.length ? [...rule.byMonth] : null;
    const byweekno = rule.byWeekNo?.length ? rule.byWeekNo : null;
    const byyearday = rule.byYearDay?.length ? rule.byYearDay : null;
    let bymonthdayAll = rule.byMonthDay?.length ? rule.byMonthDay : null;
    let byday = rule.byDay?.length ? rule.byDay : null;
    const bysetpos = rule.bySetPos?.length ? rule.bySetPos : null;
    // What the rule leaves out comes from DTSTART.
    if (!byweekno && !byyearday && !bymonthdayAll && !byday) {
        if (freq === YEARLY) {
            if (!bymonth) bymonth = [month];
            bymonthdayAll = [day];
        } else if (freq === MONTHLY) {
            bymonthdayAll = [day];
        } else if (freq === WEEKLY) {
            byday = [{ wd: weekday, n: 0 }];
        }
    }
    const bymonthday = bymonthdayAll ? bymonthdayAll.filter((x) => x > 0) : [];
    const bynmonthday = bymonthdayAll ? bymonthdayAll.filter((x) => x < 0) : [];
    let byweekday = null;
    let bynweekday = null;
    if (byday) {
        const plain = new Set();
        const nth = [];
        for (const { wd, n } of byday) {
            if (!n || freq > MONTHLY) plain.add(wd);
            else nth.push([wd, n]);
        }
        if (plain.size > 0) byweekday = plain;
        if (nth.length > 0) bynweekday = nth;
    }
    const byset = (start, values, base) => {
        // HOURLY with BYHOUR (and the like): only the values the interval can reach from DTSTART.
        const g = gcd(interval, base);
        const out = values.filter((num) => g === 1 || divmod(num - start, g)[1] === 0);
        if (out.length === 0) throw new RuleError('the interval never reaches the hours, minutes or seconds the rule names');
        return out.sort((a, b) => a - b);
    };
    let byhour;
    if (rule.byHour?.length) byhour = freq === HOURLY ? byset(hour, rule.byHour, 24) : [...rule.byHour].sort((a, b) => a - b);
    else byhour = freq < HOURLY ? [hour] : null;
    let byminute;
    if (rule.byMinute?.length) byminute = freq === MINUTELY ? byset(minute, rule.byMinute, 60) : [...rule.byMinute].sort((a, b) => a - b);
    else byminute = freq < MINUTELY ? [minute] : null;
    let bysecond;
    if (rule.bySecond?.length) bysecond = freq === SECONDLY ? byset(second, rule.bySecond, 60) : [...rule.bySecond].sort((a, b) => a - b);
    else bysecond = freq < SECONDLY ? [second] : null;
    const timesOf = (hours, minutes, seconds) => {
        const out = [];
        for (const h of hours) for (const m of minutes) for (const sec of seconds) out.push(h * 3600 + m * 60 + Math.min(sec, 59));
        return [...new Set(out)].sort((a, b) => a - b);
    };
    const gettimeset = (h, m, sec) => {
        if (freq === HOURLY) return timesOf([h], byminute, bysecond);
        if (freq === MINUTELY) return timesOf([h], [m], bysecond);
        return timesOf([h], [m], [sec]);
    };

    let info = null;
    let nwdaymask = null;
    let lastMonth = 0;
    const rebuild = (y, m) => {
        const newYear = info === null || info.year !== y;
        if (newYear) {
            info = yearMasks(y);
            info.wnomask = byweekno ? weekNoMask(info, byweekno, wkst) : null;
        }
        if (bynweekday && (newYear || m !== lastMonth || nwdaymask === null)) nwdaymask = nthWeekdayMask(info, freq, m, bymonth, bynweekday);
        lastMonth = m;
    };

    // Skip whole periods before what's wanted: only without COUNT, whose occurrences don't depend on the ones before.
    if (rule.count === undefined && Number.isFinite(skipTo) && skipTo > startWall) {
        const target = new Date(skipTo);
        const ty = target.getUTCFullYear();
        const tm = target.getUTCMonth() + 1;
        const tord = ordOf(ty, tm, target.getUTCDate());
        const ord = ordOf(year, month, day);
        if (freq === YEARLY) {
            const k = Math.floor((ty - year) / interval) - 1;
            if (k > 0) year += k * interval;
        } else if (freq === MONTHLY) {
            const k = Math.floor(((ty * 12 + tm) - (year * 12 + month)) / interval) - 1;
            if (k > 0) {
                const total = year * 12 + (month - 1) + k * interval;
                year = Math.floor(total / 12);
                month = (total % 12) + 1;
            }
        } else if (freq === WEEKLY) {
            const weekStart = ord - ((weekday - wkst + 7) % 7);
            const k = Math.floor((tord - weekStart) / (7 * interval)) - 1;
            if (k >= 1) {
                [year, month, day] = fieldsOf(weekStart + k * 7 * interval);
                weekday = wkst;
            }
        } else if (freq === DAILY) {
            const k = Math.floor((tord - ord) / interval) - 1;
            if (k >= 1) [year, month, day] = fieldsOf(ord + k * interval);
        } else if ((freq === HOURLY && 24 % interval === 0) || (freq === MINUTELY && 1440 % interval === 0)) {
            const k = tord - ord - 1;
            if (k >= 1) [year, month, day] = fieldsOf(ord + k);
        }
    }

    rebuild(year, month);
    let timeset;
    if (freq < HOURLY) {
        timeset = timesOf(byhour, byminute, bysecond);
    } else if ((freq >= HOURLY && byhour && !byhour.includes(hour))
        || (freq >= MINUTELY && byminute && !byminute.includes(minute))
        || (freq >= SECONDLY && bysecond && !bysecond.includes(second))) {
        timeset = [];
    } else {
        timeset = gettimeset(hour, minute, second);
    }

    let count = rule.count;
    for (let periods = 0; periods < 500_000; periods++) {
        if (year > 9999) return;
        // The period's days: the year, the month, the week from this day to the next WKST, or the day.
        let start;
        let end;
        if (freq === YEARLY) {
            start = 0;
            end = info.yearlen;
        } else if (freq === MONTHLY) {
            start = info.mrange[month - 1];
            end = info.mrange[month];
        } else if (freq === WEEKLY) {
            start = ordOf(year, month, day) - info.yearordinal;
            let i = start;
            for (let j = 0; j < 7; j++) {
                i += 1;
                if (info.wdaymask[i] === wkst) break;
            }
            end = i;
        } else {
            start = ordOf(year, month, day) - info.yearordinal;
            end = start + 1;
        }
        if ((info.yearordinal + start) * DAY > stop) return;

        const days = [];
        let filtered = false;
        for (let i = start; i < end; i++) {
            const out = (bymonth && !bymonth.includes(info.mmask[i]))
                || (byweekno && !info.wnomask[i])
                || (byweekday && !byweekday.has(info.wdaymask[i]))
                || (nwdaymask && !nwdaymask[i])
                || ((bymonthday.length > 0 || bynmonthday.length > 0) && !bymonthday.includes(info.mdaymask[i]) && !bynmonthday.includes(info.nmdaymask[i]))
                || (byyearday && ((i < info.yearlen && !byyearday.includes(i + 1) && !byyearday.includes(-info.yearlen + i))
                    || (i >= info.yearlen && !byyearday.includes(i + 1 - info.yearlen) && !byyearday.includes(-info.nextyearlen + i - info.yearlen))));
            if (out) filtered = true;
            else days.push(i);
        }

        const emit = [];
        if (bysetpos && timeset.length > 0) {
            const seen = new Set();
            for (const pos of bysetpos) {
                const [daypos, timepos] = pos < 0 ? divmod(pos, timeset.length) : divmod(pos - 1, timeset.length);
                const i = at(days, daypos);
                const time = timeset[timepos];
                if (i === undefined || time === undefined) continue;
                const res = (info.yearordinal + i) * DAY + time * 1000;
                if (!seen.has(res)) {
                    seen.add(res);
                    emit.push(res);
                }
            }
            emit.sort((a, b) => a - b);
        } else {
            for (const i of days) for (const time of timeset) emit.push((info.yearordinal + i) * DAY + time * 1000);
        }
        for (const res of emit) {
            if (until !== undefined && res > until) return;
            if (res >= startWall) {
                if (count !== undefined) {
                    count -= 1;
                    if (count < 0) return;
                }
                yield res;
            }
        }

        // The next period.
        let fixday = false;
        if (freq === YEARLY) {
            year += interval;
            rebuild(year, month);
        } else if (freq === MONTHLY) {
            month += interval;
            if (month > 12) {
                const [div, mod] = divmod(month, 12);
                month = mod;
                year += div;
                if (month === 0) {
                    month = 12;
                    year -= 1;
                }
            }
            rebuild(year, month);
        } else if (freq === WEEKLY) {
            if (wkst > weekday) day += -(weekday + 1 + (6 - wkst)) + interval * 7;
            else day += -(weekday - wkst) + interval * 7;
            weekday = wkst;
            fixday = true;
        } else if (freq === DAILY) {
            day += interval;
            fixday = true;
        } else if (freq === HOURLY) {
            if (filtered) hour += Math.floor((23 - hour) / interval) * interval;
            let ndays;
            if (byhour) [ndays, hour] = modDistance(hour, byhour, 24, interval);
            else [ndays, hour] = divmod(hour + interval, 24);
            if (ndays === null) return;
            if (ndays) {
                day += ndays;
                fixday = true;
            }
            timeset = gettimeset(hour, minute, second);
        } else if (freq === MINUTELY) {
            if (filtered) minute += Math.floor((1439 - (hour * 60 + minute)) / interval) * interval;
            let valid = false;
            const rep = 1440 / gcd(interval, 1440);
            for (let j = 0; j < rep; j++) {
                let nhours;
                if (byminute) [nhours, minute] = modDistance(minute, byminute, 60, interval);
                else [nhours, minute] = divmod(minute + interval, 60);
                if (nhours === null) return;
                let div;
                [div, hour] = divmod(hour + nhours, 24);
                if (div) {
                    day += div;
                    fixday = true;
                    filtered = false;
                }
                if (!byhour || byhour.includes(hour)) {
                    valid = true;
                    break;
                }
            }
            if (!valid) return;
            timeset = gettimeset(hour, minute, second);
        } else if (freq === SECONDLY) {
            if (filtered) second += Math.floor((86399 - (hour * 3600 + minute * 60 + second)) / interval) * interval;
            let valid = false;
            const rep = 86400 / gcd(interval, 86400);
            for (let j = 0; j < rep; j++) {
                let nminutes;
                if (bysecond) [nminutes, second] = modDistance(second, bysecond, 60, interval);
                else [nminutes, second] = divmod(second + interval, 60);
                if (nminutes === null) return;
                let div;
                [div, minute] = divmod(minute + nminutes, 60);
                if (div) {
                    hour += div;
                    [div, hour] = divmod(hour, 24);
                    if (div) {
                        day += div;
                        fixday = true;
                    }
                }
                if ((!byhour || byhour.includes(hour)) && (!byminute || byminute.includes(minute)) && (!bysecond || bysecond.includes(second))) {
                    valid = true;
                    break;
                }
            }
            if (!valid) return;
            timeset = gettimeset(hour, minute, second);
        }
        if (fixday && day > 28) {
            let dim = daysIn(year, month);
            if (day > dim) {
                while (day > dim) {
                    day -= dim;
                    month += 1;
                    if (month === 13) {
                        month = 1;
                        year += 1;
                        if (year > 9999) return;
                    }
                    dim = daysIn(year, month);
                }
                rebuild(year, month);
            }
        }
    }
}

/** How far to the next value of a BY… list, stepping by the interval: [carry into the next unit, value], or [null, null]. */
function modDistance(value, byxxx, base, interval) {
    let accumulator = 0;
    let v = value;
    for (let i = 1; i <= base; i++) {
        let div;
        [div, v] = divmod(v + interval, base);
        accumulator += div;
        if (byxxx.includes(v)) return [accumulator, v];
    }
    return [null, null];
}

// ── In words ───────────────────────────────────────────────────────────

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (n) => {
    if (n === -1) return 'last';
    if (n === -2) return 'second to last';
    if (n < 0) return `${ordinal(-n)} from last`;
    const words = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' };
    if (words[n]) return words[n];
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
    return `${n}${suffix}`;
};
const listWords = (words) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * A rule in plain English: "Every week on Monday and Wednesday", "Every 2
 * months on the last Friday", "Every day, 10 times". UNTIL is said by the
 * caller, who knows the zone ("until Oct 31"): pass its words as `untilText`.
 */
export function describeRule(ruleOrText, untilText) {
    let rule;
    try {
        rule = typeof ruleOrText === 'string' ? parseRule(ruleOrText) : ruleOrText;
    } catch {
        return 'Repeats';
    }
    const unit = ['year', 'month', 'week', 'day', 'hour', 'minute', 'second'][rule.freq];
    let text = rule.interval > 1 ? `Every ${rule.interval} ${unit}s` : `Every ${unit}`;
    const weekdays = rule.byDay?.filter((d) => !d.n).map((d) => d.wd).sort((a, b) => a - b) ?? [];
    const nth = rule.byDay?.filter((d) => d.n) ?? [];
    if (rule.freq === WEEKLY || (rule.freq === DAILY && weekdays.length > 0)) {
        if (weekdays.length === 5 && weekdays.every((wd, i) => wd === i)) text = rule.interval > 1 ? `${text} on weekdays` : 'Every weekday';
        else if (weekdays.length === 7) text = rule.interval > 1 ? text : 'Every day';
        else if (weekdays.length > 0) text += ` on ${listWords(weekdays.map((wd) => DAY_NAMES[wd]))}`;
    }
    if (rule.freq === MONTHLY || rule.freq === YEARLY) {
        const months = rule.byMonth?.length ? ` of ${listWords(rule.byMonth.map((m) => MONTH_NAMES[m - 1]))}` : '';
        if (nth.length > 0) {
            text += ` on the ${listWords(nth.map((d) => `${ordinal(d.n)} ${DAY_NAMES[d.wd]}`))}${months}`;
        } else if (weekdays.length > 0 && rule.bySetPos?.length) {
            const days = weekdays.length === 5 && weekdays.every((wd, i) => wd === i) ? 'weekday' : listWords(weekdays.map((wd) => DAY_NAMES[wd]));
            text += ` on the ${listWords(rule.bySetPos.map(ordinal))} ${days}${months}`;
        } else if (rule.byMonthDay?.length) {
            const days = rule.byMonthDay.map((d) => (d === -1 ? 'last day' : d < 0 ? `${ordinal(d)} day` : ordinal(d)));
            text += ` on the ${listWords(days)}${months}`;
        } else if (months) {
            text += ` in ${listWords(rule.byMonth.map((m) => MONTH_NAMES[m - 1]))}`;
        }
    }
    if (rule.count !== undefined) text += rule.count === 1 ? ', once' : `, ${rule.count} times`;
    else if (untilText) text += `, until ${untilText}`;
    return text;
}
