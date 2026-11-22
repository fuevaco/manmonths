import { crc32, deflateRawSync } from 'node:zlib';
export const manifest = { packageFormatVersion: 1, key: 'demo', name: 'Demo', type: 'skill', version: '1.0.0',
  description: 'Synthetic', contents: [{ id: 'hello', kind: 'skill', path: 'resources/hello' }] };
export function zip(entries = { 'lcpack.json': JSON.stringify(manifest), 'README.md': '# Demo', 'resources/hello/SKILL.md': '---\nname: hello\ndescription: Synthetic\n---\nHello' }, attrs = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const n = Buffer.from(name), data = Buffer.from(value), compressed = deflateRawSync(data), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, compressed);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(attrs[name] || 0, 38); c.writeUInt32LE(offset, 42); central.push(c, n); offset += h.length + n.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
