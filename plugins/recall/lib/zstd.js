/**
 * DSH's session logs as Recall reads them: a file of zstd frames, one
 * frame per write, each holding whole JSON lines. Node's decoder reads one
 * frame at a time, so the file is split into frames here first.
 *
 * Reading is incremental: Recall keeps the byte offset after the last
 * whole frame it read, and reads on from there when the file grows. A
 * frame still being written (cut short at the file's end) waits for the
 * next pass; bytes that are not a frame stop the read and say where.
 *
 * No DSH packages here, so it runs in plain unit tests.
 *
 * @module dsh-plugin-recall/zstd
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import * as zlib from 'node:zlib';

const FRAME_MAGIC = 0xfd2fb528;
/** Skippable frames: 0x184D2A50 to 0x184D2A5F. */
const SKIPPABLE = 0x184d2a50;

/** Whether this Node can decode zstd (Node 22.15 and newer). */
export const canDecode = () => typeof zlib.zstdDecompressSync === 'function';

/**
 * The frames that are whole in `buf`, from its start.
 * @param {Buffer} buf
 * @returns {{ frames: { start: number, end: number, skip: boolean }[], end: number, bad?: { at: number, why: string } }}
 *   `end`: the byte after the last whole frame; `bad`: where the bytes stopped being frames, and why.
 */
export function scanFrames(buf) {
    const frames = [];
    let at = 0;
    const out = (bad) => ({ frames, end: at, ...(bad ? { bad } : {}) });
    while (at + 4 <= buf.length) {
        const magic = buf.readUInt32LE(at);
        if ((magic & 0xfffffff0) === SKIPPABLE) {
            if (at + 8 > buf.length) return out();
            const end = at + 8 + buf.readUInt32LE(at + 4);
            if (end > buf.length) return out();
            frames.push({ start: at, end, skip: true });
            at = end;
            continue;
        }
        if (magic !== FRAME_MAGIC) return out({ at, why: 'not a zstd frame' });
        if (at + 5 > buf.length) return out();
        const fhd = buf[at + 4];
        if ((fhd >> 3) & 1) return out({ at, why: 'a frame header with its reserved bit set' });
        const single = (fhd >> 5) & 1;
        const fcsFlag = fhd >> 6;
        const fcs = fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag];
        let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + fcs;
        let last = false;
        while (!last) {
            if (p + 3 > buf.length) return out();
            const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
            last = (header & 1) === 1;
            const type = (header >> 1) & 3;
            if (type === 3) return out({ at, why: 'a block of a reserved type' });
            p += 3 + (type === 1 ? 1 : header >>> 3);
            if (p > buf.length) return out();
        }
        if ((fhd >> 2) & 1) p += 4;
        if (p > buf.length) return out();
        frames.push({ start: at, end: p, skip: false });
        at = p;
    }
    return out();
}

/** The text of one frame. */
export function decodeFrame(buf) {
    return zlib.zstdDecompressSync(buf).toString('utf8');
}

/**
 * Where the next frame starts at or after `from` (the magic number), for
 * reading on past bytes that are not a frame; undefined when none follows.
 */
function nextFrameAt(fd, from, size, window = 1 << 20, limit = 64 << 20) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    for (let at = from; at < size && at - from < limit; at += window - 3) {
        const buf = Buffer.alloc(Math.min(window, size - at));
        const got = readSync(fd, buf, 0, buf.length, at);
        const hit = buf.subarray(0, got).indexOf(magic);
        if (hit >= 0) return at + hit;
        if (got < buf.length) break;
    }
    return undefined;
}

/**
 * Read a log's whole frames from `offset` on, at most about `maxBytes` of
 * the file in one go (more when one frame alone is bigger, up to
 * `maxFrameBytes`).
 * @param {string} file
 * @param {number} offset - the byte after the last frame read before.
 * @param {{ maxBytes?: number, maxFrameBytes?: number }} [options]
 * @returns {{ size: number, ino: number, mtime: number, texts: string[], next: number, more: boolean, shrunk?: true, bad?: { at: number, why: string, resume?: number } }}
 *   `texts`: each whole frame's text, in order; `next`: the offset to read from next time; `more`: the file holds more
 *   whole bytes past `next` than this read took; `shrunk`: the file is shorter than `offset` (read it again whole);
 *   `bad`: bytes at `at` are not a frame Recall can read, and the next frame after them starts at `resume`.
 */
export function readFrames(file, offset, { maxBytes = 4 << 20, maxFrameBytes = 64 << 20 } = {}) {
    const fd = openSync(file, 'r');
    try {
        const st = fstatSync(fd);
        const base = { size: st.size, ino: st.ino, mtime: st.mtimeMs };
        if (st.size < offset) return { ...base, texts: [], next: offset, more: false, shrunk: true };
        let want = Math.min(st.size - offset, maxBytes);
        for (;;) {
            const buf = Buffer.alloc(want);
            const got = want > 0 ? readSync(fd, buf, 0, want, offset) : 0;
            const view = buf.subarray(0, got);
            const scan = scanFrames(view);
            if (scan.frames.length === 0 && !scan.bad && got < st.size - offset && want < maxFrameBytes) {
                // One frame bigger than this read: read more of it.
                want = Math.min(st.size - offset, want * 4, maxFrameBytes);
                continue;
            }
            const texts = [];
            let end = scan.end;
            let bad = scan.bad ? { at: offset + scan.bad.at, why: scan.bad.why } : undefined;
            for (const frame of scan.frames) {
                if (frame.skip) continue;
                try {
                    texts.push(decodeFrame(view.subarray(frame.start, frame.end)));
                } catch (error) {
                    // A frame that does not decode (a write cut short by a crash): stop before it.
                    end = frame.start;
                    bad = { at: offset + frame.start, why: `a frame that does not decode (${String(error?.code ?? error?.message ?? error).slice(0, 60)})` };
                    break;
                }
            }
            const next = offset + end;
            if (bad) bad.resume = nextFrameAt(fd, bad.at + 1, st.size);
            if (!bad && scan.frames.length === 0 && got > 0 && got >= maxFrameBytes) {
                return { ...base, texts, next, more: false, bad: { at: offset, why: `a frame bigger than ${Math.round(maxFrameBytes / 1048576)} MB`, resume: nextFrameAt(fd, offset + 1, st.size) } };
            }
            // More: this read stopped short of the file's end (its size bound), not at a frame still being written.
            return { ...base, texts, next, more: !bad && scan.frames.length > 0 && offset + got < st.size, ...(bad ? { bad } : {}) };
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * Read a JSON-lines file's whole lines from `offset` on, at most about
 * `maxBytes` in one go: a line still being written waits for the next pass.
 * @returns {{ size: number, ino: number, mtime: number, text: string, next: number, more: boolean, shrunk?: true, skipped?: number }}
 *   `skipped`: bytes of one line longer than `maxLineBytes`, passed over.
 */
export function readLines(file, offset, { maxBytes = 4 << 20, maxLineBytes = 16 << 20 } = {}) {
    const fd = openSync(file, 'r');
    try {
        const st = fstatSync(fd);
        const base = { size: st.size, ino: st.ino, mtime: st.mtimeMs };
        if (st.size < offset) return { ...base, text: '', next: offset, more: false, shrunk: true };
        let want = Math.min(st.size - offset, maxBytes);
        for (;;) {
            const buf = Buffer.alloc(want);
            const got = want > 0 ? readSync(fd, buf, 0, want, offset) : 0;
            const cut = buf.lastIndexOf(0x0a, got - 1);
            if (cut < 0) {
                if (got < st.size - offset && want < maxLineBytes) {
                    want = Math.min(st.size - offset, want * 4, maxLineBytes);
                    continue;
                }
                // One line bigger than the most Recall reads, or a line not ended yet.
                const skip = got >= maxLineBytes;
                return { ...base, text: '', next: skip ? offset + got : offset, more: skip && offset + got < st.size, ...(skip ? { skipped: got } : {}) };
            }
            const next = offset + cut + 1;
            return { ...base, text: buf.subarray(0, cut + 1).toString('utf8'), next, more: next < st.size };
        }
    } finally {
        closeSync(fd);
    }
}
