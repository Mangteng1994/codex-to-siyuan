/**
 * 构建思源集市发布包。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT_DIR, 'package.zip');

const ROOT_FILES = [
  'plugin.json',
  'index.js',
  'hook.js',
  'package.json',
  'README.md',
  'README_zh_CN.md',
  'LICENSE',
  'icon.png',
  'preview.png',
];

const ROOT_DIRS = ['src', 'i18n'];

/**
 * 递归收集目录文件。
 *
 * @param {string} dir 相对目录
 * @returns {string[]} 相对文件路径
 */
function collectFiles(dir) {
  const absDir = path.join(ROOT_DIR, dir);
  if (!fs.existsSync(absDir)) {
    return [];
  }

  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

/**
 * 创建 CRC32 查询表。
 *
 * @returns {number[]} 查询表
 */
function createCrcTable() {
  const table = [];
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let j = 0; j < 8; j += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = createCrcTable();

/**
 * 计算 CRC32。
 *
 * @param {Buffer} buffer 文件内容
 * @returns {number} CRC32 值
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 转为 ZIP 需要的 DOS 时间。
 *
 * @param {Date} date 文件时间
 * @returns {{time: number, date: number}} DOS 时间
 */
function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: dosTime, date: dosDate };
}

/**
 * 写入 ZIP 本地文件头。
 *
 * @param {object} entry 文件项
 * @returns {Buffer} 文件头
 */
function createLocalHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(entry.dosTime.time, 10);
  header.writeUInt16LE(entry.dosTime.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.source.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.name]);
}

/**
 * 写入 ZIP 中央目录头。
 *
 * @param {object} entry 文件项
 * @returns {Buffer} 目录头
 */
function createCentralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(entry.dosTime.time, 12);
  header.writeUInt16LE(entry.dosTime.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.source.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

/**
 * 写入 ZIP 结束目录。
 *
 * @param {number} count 文件数量
 * @param {number} centralSize 中央目录大小
 * @param {number} centralOffset 中央目录偏移
 * @returns {Buffer} 结束目录
 */
function createEndRecord(count, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/**
 * 生成 package.zip。
 */
function build() {
  const files = [
    ...ROOT_FILES.filter((file) => fs.existsSync(path.join(ROOT_DIR, file))),
    ...ROOT_DIRS.flatMap(collectFiles),
  ].sort();

  const localParts = [];
  const centralParts = [];
  const entries = [];
  let offset = 0;

  for (const relPath of files) {
    const absPath = path.join(ROOT_DIR, relPath);
    const source = fs.readFileSync(absPath);
    const compressed = zlib.deflateRawSync(source, { level: 9 });
    const stat = fs.statSync(absPath);
    const entry = {
      name: Buffer.from(relPath.replace(/\\/g, '/')),
      source,
      compressed,
      crc: crc32(source),
      dosTime: toDosDateTime(stat.mtime),
      offset,
    };

    const localHeader = createLocalHeader(entry);
    localParts.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
    entries.push(entry);
  }

  for (const entry of entries) {
    centralParts.push(createCentralHeader(entry));
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = createEndRecord(entries.length, centralDirectory.length, offset);
  fs.writeFileSync(OUTPUT_FILE, Buffer.concat([...localParts, centralDirectory, endRecord]));
  console.log(`Created package.zip with ${entries.length} files.`);
}

build();
