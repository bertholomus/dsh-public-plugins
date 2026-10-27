/**
 * Pictures for the tests, made here so the tests need no image files: a PNG of a vertical gradient between two
 * colours (with a soft band so the crossfade and frost have something to show).
 *
 * @module plugins/wallpaper/test/e2e/png
 */
import { deflateSync } from 'node:zlib';

const CRC = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};

/** A `width`×`height` PNG going from `top` to `bottom` ([r, g, b] each). */
export function gradientPng(width, height, top, bottom) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const t = y / Math.max(1, height - 1);
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const band = Math.sin((x / width) * Math.PI) * 18;
            for (let i = 0; i < 3; i++) raw[row + 1 + x * 3 + i] = Math.max(0, Math.min(255, Math.round(top[i] + (bottom[i] - top[i]) * t + band)));
        }
    }
    const head = Buffer.alloc(13);
    head.writeUInt32BE(width, 0);
    head.writeUInt32BE(height, 4);
    head[8] = 8; // bit depth
    head[9] = 2; // truecolour
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
