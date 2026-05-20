/**
 * Tiny zero-dependency ZIP writer.
 *
 * Why not jszip:
 *   We only need uncompressed archive of small text files + downloaded blobs
 *   for the CPA package. Adding jszip (~95KB gzip) is overkill for this.
 *
 * Format:
 *   - All entries use STORE method (no compression). PDFs/images are already
 *     compressed and the package usually opens fine even on Windows.
 *   - Filenames are written as UTF-8; we set the Language Encoding (UTF-8) flag.
 *   - 32-bit (no zip64). Total archive size capped well under 4GB for our case.
 *
 * Reference: PKWARE APPNOTE.TXT, sections 4.3 and 4.4.
 */

interface ZipEntry {
  /** Path within the zip (forward slashes) */
  name: string;
  data: Uint8Array;
  crc32: number;
  /** Offset of local file header from start of archive */
  offset: number;
  /** Last-modified time, in DOS format */
  dosTime: number;
  dosDate: number;
}

// Precomputed CRC32 table
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear()) - 1980;
  const date = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function writeUint16LE(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}
function writeUint32LE(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

function buildLocalFileHeader(entry: ZipEntry, nameBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(buf.buffer);
  writeUint32LE(view, 0, SIG_LFH);
  writeUint16LE(view, 4, VERSION_NEEDED);
  writeUint16LE(view, 6, FLAG_UTF8);
  writeUint16LE(view, 8, METHOD_STORE);
  writeUint16LE(view, 10, entry.dosTime);
  writeUint16LE(view, 12, entry.dosDate);
  writeUint32LE(view, 14, entry.crc32);
  writeUint32LE(view, 18, entry.data.length); // compressed size (= uncompressed)
  writeUint32LE(view, 22, entry.data.length);
  writeUint16LE(view, 26, nameBytes.length);
  writeUint16LE(view, 28, 0);
  buf.set(nameBytes, 30);
  return buf;
}

function buildCentralDirectoryHeader(entry: ZipEntry, nameBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(46 + nameBytes.length);
  const view = new DataView(buf.buffer);
  writeUint32LE(view, 0, SIG_CDH);
  writeUint16LE(view, 4, VERSION_NEEDED); // version made by
  writeUint16LE(view, 6, VERSION_NEEDED); // version needed
  writeUint16LE(view, 8, FLAG_UTF8);
  writeUint16LE(view, 10, METHOD_STORE);
  writeUint16LE(view, 12, entry.dosTime);
  writeUint16LE(view, 14, entry.dosDate);
  writeUint32LE(view, 16, entry.crc32);
  writeUint32LE(view, 20, entry.data.length);
  writeUint32LE(view, 24, entry.data.length);
  writeUint16LE(view, 28, nameBytes.length);
  writeUint16LE(view, 30, 0); // extra
  writeUint16LE(view, 32, 0); // comment
  writeUint16LE(view, 34, 0); // disk start
  writeUint16LE(view, 36, 0); // internal attrs
  writeUint32LE(view, 38, 0); // external attrs
  writeUint32LE(view, 42, entry.offset);
  buf.set(nameBytes, 46);
  return buf;
}

function buildEOCD(numEntries: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const view = new DataView(buf.buffer);
  writeUint32LE(view, 0, SIG_EOCD);
  writeUint16LE(view, 4, 0);
  writeUint16LE(view, 6, 0);
  writeUint16LE(view, 8, numEntries);
  writeUint16LE(view, 10, numEntries);
  writeUint32LE(view, 12, cdSize);
  writeUint32LE(view, 16, cdOffset);
  writeUint16LE(view, 20, 0); // comment length
  return buf;
}

export interface ZipFile {
  name: string;
  /** Either a Uint8Array or a string (encoded as UTF-8). */
  data: Uint8Array | string;
}

/**
 * Build a ZIP archive Blob from the given file list.
 * All files are stored uncompressed.
 */
export function buildZip(files: ZipFile[]): Blob {
  const encoder = new TextEncoder();
  const now = new Date();
  const { date, time } = dosDateTime(now);

  // 1) Build entries + their local headers
  const localChunks: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
    const nameBytes = encoder.encode(f.name);
    const entry: ZipEntry = {
      name: f.name,
      data,
      crc32: crc32(data),
      offset,
      dosDate: date,
      dosTime: time,
    };
    const lfh = buildLocalFileHeader(entry, nameBytes);
    localChunks.push(lfh, data);
    offset += lfh.length + data.length;
    entries.push(entry);
  }

  // 2) Build central directory
  const cdOffset = offset;
  const cdChunks: Uint8Array[] = [];
  let cdSize = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const cdh = buildCentralDirectoryHeader(entry, nameBytes);
    cdChunks.push(cdh);
    cdSize += cdh.length;
  }

  // 3) End of central directory
  const eocd = buildEOCD(entries.length, cdSize, cdOffset);

  return new Blob(
    [...localChunks, ...cdChunks, eocd] as BlobPart[],
    { type: 'application/zip' }
  );
}

export function downloadZip(filename: string, files: ZipFile[]) {
  const blob = buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
