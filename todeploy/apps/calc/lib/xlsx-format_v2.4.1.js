//#region \0@oxc-project+runtime@0.138.0/helpers/esm/typeof.js
function _typeof(o) {
	"@babel/helpers - typeof";
	return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o) {
		return typeof o;
	} : function(o) {
		return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
	}, _typeof(o);
}

//#endregion
//#region \0@oxc-project+runtime@0.138.0/helpers/esm/toPrimitive.js
function toPrimitive(t, r) {
	if ("object" != _typeof(t) || !t) return t;
	var e = t[Symbol.toPrimitive];
	if (void 0 !== e) {
		var i = e.call(t, r || "default");
		if ("object" != _typeof(i)) return i;
		throw new TypeError("@@toPrimitive must return a primitive value.");
	}
	return ("string" === r ? String : Number)(t);
}

//#endregion
//#region \0@oxc-project+runtime@0.138.0/helpers/esm/toPropertyKey.js
function toPropertyKey(t) {
	var i = toPrimitive(t, "string");
	return "symbol" == _typeof(i) ? i : i + "";
}

//#endregion
//#region \0@oxc-project+runtime@0.138.0/helpers/esm/defineProperty.js
function _defineProperty(e, r, t) {
	return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
		value: t,
		enumerable: !0,
		configurable: !0,
		writable: !0
	}) : e[r] = t, e;
}

//#endregion
//#region src/errors.ts
/** Error subclass thrown by xlsx-format for deterministic failure handling. */
var XlsxError = class extends Error {
	constructor(code, message, options) {
		super(message, options);
		_defineProperty(this, "code", void 0);
		this.name = "XlsxError";
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
};

//#endregion
//#region src/zip/crc32.ts
/**
* Pre-computed CRC32 lookup table using the standard polynomial 0xEDB88320
* (ISO 3309 / ITU-T V.42, bit-reversed form of 0x04C11DB7).
*
* Each entry TABLE[i] is the CRC32 of the single byte i, computed by
* shifting through all 8 bits and XOR-ing with the polynomial when the LSB is set.
*/
const TABLE = /* @__PURE__ */ new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) c = c & 1 ? c >>> 1 ^ 3988292384 : c >>> 1;
	TABLE[i] = c;
}
/**
* Compute the CRC32 checksum of a byte buffer.
*
* Uses the standard table-driven algorithm: start with all bits set (0xFFFFFFFF),
* fold each byte through the lookup table, and invert at the end.
*
* @param buf - Input bytes
* @returns Unsigned 32-bit CRC32 value
*/
function crc32(buf) {
	let crc = 4294967295;
	for (let i = 0; i < buf.length; i++) crc = crc >>> 8 ^ TABLE[(crc ^ buf[i]) & 255];
	return (crc ^ 4294967295) >>> 0;
}

//#endregion
//#region src/zip/streams.ts
/**
* Read all chunks from a {@link ReadableStream} and concatenate them into a single {@link Uint8Array}.
*
* Collects chunks incrementally, then copies them into a contiguous buffer.
*/
async function collectStream(readable, maxBytes = Infinity) {
	const reader = readable.getReader();
	const chunks = [];
	let totalLength = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		totalLength += value.length;
		if (totalLength > maxBytes) throw new XlsxError("LIMIT_EXCEEDED", `Invalid ZIP: decompressed data exceeds limit (${maxBytes} bytes)`);
	}
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}
/**
* Decompress raw DEFLATE data using the built-in {@link DecompressionStream} API.
*
* Uses "deflate-raw" format (no zlib header or gzip wrapper), which matches
* the compression used inside ZIP archives (method 8).
*
* @param data - Compressed bytes (raw deflate, no zlib/gzip wrapper)
* @param maxBytes - Maximum allowed decompressed size
* @returns Decompressed bytes
*/
async function inflate(data, maxBytes = Infinity) {
	const ds = new DecompressionStream("deflate-raw");
	const writer = ds.writable.getWriter();
	const writePromise = writer.write(data).then(() => writer.close());
	try {
		const [result] = await Promise.all([collectStream(ds.readable, maxBytes), writePromise]);
		return result;
	} catch (err) {
		try {
			await writer.abort(err);
		} catch {}
		throw err;
	}
}
/**
* Compress data using raw DEFLATE via the built-in {@link CompressionStream} API.
*
* Uses "deflate-raw" format (no zlib header or gzip wrapper), which matches
* the compression expected inside ZIP archives (method 8).
*
* @param data - Uncompressed bytes
* @returns Compressed bytes (raw deflate, no zlib/gzip wrapper)
*/
async function deflate(data) {
	const cs = new CompressionStream("deflate-raw");
	const writer = cs.writable.getWriter();
	const writePromise = writer.write(data).then(() => writer.close());
	try {
		const [result] = await Promise.all([collectStream(cs.readable), writePromise]);
		return result;
	} catch (err) {
		try {
			await writer.abort(err);
		} catch {}
		throw err;
	}
}

//#endregion
//#region src/zip/index.ts
const encoder$1 = new TextEncoder();
const decoder$1 = new TextDecoder();
const DEFAULT_MAX_ZIP_ENTRIES = 1e4;
const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** Local file header signature: "PK\x03\x04" */
const SIG_LOCAL = 67324752;
/** Central directory file header signature: "PK\x01\x02" */
const SIG_CENTRAL = 33639248;
/** End of Central Directory record signature: "PK\x05\x06" */
const SIG_EOCD = 101010256;
const ZIP64_U16 = 65535;
const ZIP64_U32 = 4294967295;
function optionLimit(value, fallback, name) {
	if (value == null) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new XlsxError("INVALID_ARGUMENT", `Invalid ZIP option: ${name} must be a non-negative finite number`);
	return value;
}
function assertRange(data, off, len, what) {
	if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 0 || off > data.length - len) throw new XlsxError("MALFORMED", `Invalid ZIP: ${what} out of bounds`);
}
function readU16At(buf, off, what) {
	assertRange(buf, off, 2, what);
	return readU16(buf, off);
}
function readU32At(buf, off, what) {
	assertRange(buf, off, 4, what);
	return readU32(buf, off);
}
function rejectZip64() {
	throw new XlsxError("UNSUPPORTED", "Unsupported ZIP: Zip64 archives are not supported");
}
function assertCrc(name, data, expected) {
	if (crc32(data) !== expected) throw new XlsxError("CRC_MISMATCH", `Invalid ZIP: CRC mismatch for ${name}`);
}
/** Read an unsigned 16-bit little-endian integer from a buffer */
function readU16(buf, off) {
	return buf[off] | buf[off + 1] << 8;
}
/** Read an unsigned 32-bit little-endian integer from a buffer */
function readU32(buf, off) {
	return (buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 | buf[off + 3] << 24) >>> 0;
}
/** Write an unsigned 16-bit little-endian integer to a buffer */
function writeU16(buf, off, val) {
	buf[off] = val & 255;
	buf[off + 1] = val >> 8 & 255;
}
/** Write an unsigned 32-bit little-endian integer to a buffer */
function writeU32(buf, off, val) {
	buf[off] = val & 255;
	buf[off + 1] = val >> 8 & 255;
	buf[off + 2] = val >> 16 & 255;
	buf[off + 3] = val >> 24 & 255;
}
/**
* Parse a ZIP archive from raw bytes.
*
* Locates the End of Central Directory (EOCD) record by scanning backward,
* then reads the central directory to find all file entries. Deflated entries
* are decompressed one at a time to keep peak memory bounded by entry limits.
*
* @param data - Raw ZIP file bytes
* @returns Parsed archive with decompressed file contents
* @throws XlsxError if the ZIP structure is invalid or uses an unsupported compression method
*/
async function zipRead(data, opts) {
	const maxZipEntries = optionLimit(opts?.maxZipEntries, DEFAULT_MAX_ZIP_ENTRIES, "maxZipEntries");
	const maxTotalUncompressedBytes = optionLimit(opts?.maxTotalUncompressedBytes, DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES, "maxTotalUncompressedBytes");
	const maxEntryUncompressedBytes = optionLimit(opts?.maxEntryUncompressedBytes, DEFAULT_MAX_ENTRY_UNCOMPRESSED_BYTES, "maxEntryUncompressedBytes");
	let eocdOffset = -1;
	for (let i = data.length - 22; i >= 0 && i >= data.length - 65557; i--) if (readU32(data, i) === SIG_EOCD) {
		const commentLen = readU16(data, i + 20);
		if (i + 22 + commentLen === data.length) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset === -1) throw new XlsxError("MALFORMED", "Invalid ZIP: EOCD not found");
	assertRange(data, eocdOffset, 22, "EOCD");
	const eocdCommentLen = readU16At(data, eocdOffset + 20, "EOCD comment length");
	assertRange(data, eocdOffset, 22 + eocdCommentLen, "EOCD comment");
	const diskNumber = readU16At(data, eocdOffset + 4, "EOCD disk number");
	const cdDiskNumber = readU16At(data, eocdOffset + 6, "EOCD central directory disk number");
	const cdEntriesOnDisk = readU16At(data, eocdOffset + 8, "EOCD disk entry count");
	const cdEntries = readU16At(data, eocdOffset + 10, "EOCD entry count");
	const cdSize = readU32At(data, eocdOffset + 12, "EOCD central directory size");
	const cdOffset = readU32At(data, eocdOffset + 16, "EOCD central directory offset");
	if (cdEntriesOnDisk === ZIP64_U16 || cdEntries === ZIP64_U16 || cdSize === ZIP64_U32 || cdOffset === ZIP64_U32) rejectZip64();
	if (diskNumber !== 0 || cdDiskNumber !== 0 || cdEntriesOnDisk !== cdEntries) throw new XlsxError("UNSUPPORTED", "Unsupported ZIP: multi-disk archives are not supported");
	if (cdEntries > maxZipEntries) throw new XlsxError("LIMIT_EXCEEDED", `Invalid ZIP: entry count ${cdEntries} exceeds limit ${maxZipEntries}`);
	assertRange(data, cdOffset, cdSize, "central directory");
	if (cdOffset + cdSize > eocdOffset) throw new XlsxError("MALFORMED", "Invalid ZIP: central directory overlaps EOCD");
	const entries = [];
	let pos = cdOffset;
	const cdEnd = cdOffset + cdSize;
	for (let i = 0; i < cdEntries; i++) {
		assertRange(data, pos, 46, "central directory entry");
		if (pos + 46 > cdEnd) throw new XlsxError("MALFORMED", "Invalid ZIP: central directory entry exceeds declared size");
		if (readU32At(data, pos, "central directory signature") !== SIG_CENTRAL) throw new XlsxError("MALFORMED", "Invalid ZIP: bad central directory entry");
		const method = readU16At(data, pos + 10, "central directory compression method");
		const crcVal = readU32At(data, pos + 16, "central directory CRC");
		const compSize = readU32At(data, pos + 20, "central directory compressed size");
		const uncompSize = readU32At(data, pos + 24, "central directory uncompressed size");
		const nameLen = readU16At(data, pos + 28, "central directory file name length");
		const extraLen = readU16At(data, pos + 30, "central directory extra length");
		const commentLen = readU16At(data, pos + 32, "central directory comment length");
		const diskStart = readU16At(data, pos + 34, "central directory disk start");
		const localOffset = readU32At(data, pos + 42, "central directory local header offset");
		if (compSize === ZIP64_U32 || uncompSize === ZIP64_U32 || localOffset === ZIP64_U32 || diskStart === ZIP64_U16) rejectZip64();
		if (diskStart !== 0) throw new XlsxError("UNSUPPORTED", "Unsupported ZIP: multi-disk archives are not supported");
		const entryEnd = pos + 46 + nameLen + extraLen + commentLen;
		if (entryEnd > cdEnd) throw new XlsxError("MALFORMED", "Invalid ZIP: central directory entry exceeds declared size");
		const nameBytes = data.subarray(pos + 46, pos + 46 + nameLen);
		const name = decoder$1.decode(nameBytes);
		entries.push({
			method,
			crc: crcVal,
			compSize,
			uncompSize,
			name,
			localOffset
		});
		pos = entryEnd;
	}
	const files = Object.create(null);
	const seenNames = /* @__PURE__ */ new Set();
	const inflateJobs = [];
	let totalUncompressedBytes = 0;
	for (const entry of entries) {
		const name = entry.name;
		if (name.endsWith("/")) continue;
		if (seenNames.has(name)) throw new XlsxError("DUPLICATE", `Invalid ZIP: duplicate entry ${name}`);
		seenNames.add(name);
		const loc = entry.localOffset;
		assertRange(data, loc, 30, `local file header for ${entry.name}`);
		if (readU32At(data, loc, "local file header signature") !== SIG_LOCAL) throw new XlsxError("MALFORMED", "Invalid ZIP: bad local file header");
		const localMethod = readU16At(data, loc + 8, "local file header compression method");
		const localNameLen = readU16At(data, loc + 26, "local file header file name length");
		const localExtraLen = readU16At(data, loc + 28, "local file header extra length");
		const dataStart = loc + 30 + localNameLen + localExtraLen;
		assertRange(data, dataStart, entry.compSize, `file data for ${entry.name}`);
		const dataEnd = dataStart + entry.compSize;
		if (localMethod !== entry.method) throw new XlsxError("MALFORMED", `Invalid ZIP: local header method mismatch for ${entry.name}`);
		if (decoder$1.decode(data.subarray(loc + 30, loc + 30 + localNameLen)) !== name) throw new XlsxError("MALFORMED", `Invalid ZIP: local header file name mismatch for ${name}`);
		if (entry.uncompSize > maxEntryUncompressedBytes) throw new XlsxError("LIMIT_EXCEEDED", `Invalid ZIP: entry ${name} uncompressed size ${entry.uncompSize} exceeds limit ${maxEntryUncompressedBytes}`);
		totalUncompressedBytes += entry.uncompSize;
		if (totalUncompressedBytes > maxTotalUncompressedBytes) throw new XlsxError("LIMIT_EXCEEDED", `Invalid ZIP: total uncompressed size ${totalUncompressedBytes} exceeds limit ${maxTotalUncompressedBytes}`);
		if (entry.method === 0) {
			if (entry.compSize !== entry.uncompSize) throw new XlsxError("MALFORMED", `Invalid ZIP: stored entry ${name} has mismatched compressed and uncompressed sizes`);
			const fileData = data.subarray(dataStart, dataEnd);
			assertCrc(name, fileData, entry.crc);
			files[name] = fileData;
		} else if (entry.method === 8) inflateJobs.push({
			name,
			compressed: data.subarray(dataStart, dataEnd),
			expectedSize: entry.uncompSize,
			crc: entry.crc
		});
		else throw new XlsxError("UNSUPPORTED", `Unsupported ZIP compression method: ${entry.method}`);
	}
	for (const job of inflateJobs) {
		const result = await inflate(job.compressed, job.expectedSize);
		if (result.length !== job.expectedSize) throw new XlsxError("MALFORMED", `Invalid ZIP: entry ${job.name} inflated to ${result.length} bytes, expected ${job.expectedSize}`);
		assertCrc(job.name, result, job.crc);
		files[job.name] = result;
	}
	return { files };
}
/**
* Serialize a {@link ZipArchive} to raw ZIP file bytes.
*
* Writes local file headers, central directory, and EOCD record.
* When {@link compress} is `true`, entries are deflated in parallel using {@link CompressionStream}.
*
* @param archive - Archive to serialize
* @param compress - Whether to deflate file entries (default: stored uncompressed)
* @returns Raw ZIP file bytes
*/
async function zipWrite(archive, compress) {
	const rawEntries = Object.keys(archive.files).map((name) => ({
		name,
		nameBytes: encoder$1.encode(name),
		data: archive.files[name],
		crc: crc32(archive.files[name])
	}));
	let compressedDatas;
	let methods;
	if (compress) {
		compressedDatas = await Promise.all(rawEntries.map(async (e) => deflate(e.data)));
		methods = rawEntries.map(() => 8);
	} else {
		compressedDatas = rawEntries.map((e) => e.data);
		methods = rawEntries.map(() => 0);
	}
	let totalSize = 0;
	for (let i = 0; i < rawEntries.length; i++) {
		totalSize += 30 + rawEntries[i].nameBytes.length + compressedDatas[i].length;
		totalSize += 46 + rawEntries[i].nameBytes.length;
	}
	totalSize += 22;
	const buf = new Uint8Array(totalSize);
	let offset = 0;
	const centralEntries = [];
	for (let i = 0; i < rawEntries.length; i++) {
		const entry = rawEntries[i];
		const compData = compressedDatas[i];
		centralEntries.push({
			offset,
			index: i
		});
		writeU32(buf, offset, SIG_LOCAL);
		writeU16(buf, offset + 4, 20);
		writeU16(buf, offset + 6, 0);
		writeU16(buf, offset + 8, methods[i]);
		writeU16(buf, offset + 10, 0);
		writeU16(buf, offset + 12, 0);
		writeU32(buf, offset + 14, entry.crc);
		writeU32(buf, offset + 18, compData.length);
		writeU32(buf, offset + 22, entry.data.length);
		writeU16(buf, offset + 26, entry.nameBytes.length);
		writeU16(buf, offset + 28, 0);
		buf.set(entry.nameBytes, offset + 30);
		buf.set(compData, offset + 30 + entry.nameBytes.length);
		offset += 30 + entry.nameBytes.length + compData.length;
	}
	const cdStart = offset;
	for (const ce of centralEntries) {
		const entry = rawEntries[ce.index];
		const compData = compressedDatas[ce.index];
		writeU32(buf, offset, SIG_CENTRAL);
		writeU16(buf, offset + 4, 20);
		writeU16(buf, offset + 6, 20);
		writeU16(buf, offset + 8, 0);
		writeU16(buf, offset + 10, methods[ce.index]);
		writeU16(buf, offset + 12, 0);
		writeU16(buf, offset + 14, 0);
		writeU32(buf, offset + 16, entry.crc);
		writeU32(buf, offset + 20, compData.length);
		writeU32(buf, offset + 24, entry.data.length);
		writeU16(buf, offset + 28, entry.nameBytes.length);
		writeU16(buf, offset + 30, 0);
		writeU16(buf, offset + 32, 0);
		writeU16(buf, offset + 34, 0);
		writeU16(buf, offset + 36, 0);
		writeU32(buf, offset + 38, 0);
		writeU32(buf, offset + 42, ce.offset);
		buf.set(entry.nameBytes, offset + 46);
		offset += 46 + entry.nameBytes.length;
	}
	const cdSize = offset - cdStart;
	writeU32(buf, offset, SIG_EOCD);
	writeU16(buf, offset + 4, 0);
	writeU16(buf, offset + 6, 0);
	writeU16(buf, offset + 8, rawEntries.length);
	writeU16(buf, offset + 10, rawEntries.length);
	writeU32(buf, offset + 12, cdSize);
	writeU32(buf, offset + 16, cdStart);
	writeU16(buf, offset + 20, 0);
	return buf;
}
/**
* Read a file from a ZIP archive as a UTF-8 string.
*
* Falls back to trying with/without a leading slash if the exact path is not found.
*
* @param archive - ZIP archive to read from
* @param path - File path within the archive
* @returns Decoded string, or `null` if the file is not found
*/
function zipReadString(archive, path) {
	let data = archive.files[path];
	if (!data) {
		const normalized = path.startsWith("/") ? path.slice(1) : "/" + path;
		data = archive.files[normalized];
	}
	if (!data) return null;
	return decoder$1.decode(data);
}
/**
* Add a UTF-8 string as a file entry in the archive.
*
* @param archive - Target archive
* @param path - File path within the archive
* @param content - String content to encode as UTF-8
*/
function zipAddString(archive, path, content) {
	archive.files[path] = encoder$1.encode(content);
}
/** Create a new empty ZIP archive with no file entries. */
function zipCreate() {
	return { files: {} };
}
/**
* Check if a file exists in the archive.
*
* Tries an exact match first, then with/without a leading slash,
* and finally a case-insensitive search as a last resort.
*
* @param archive - ZIP archive to search
* @param path - File path to look for
* @returns `true` if the file exists
*/
function zipHas(archive, path) {
	if (archive.files[path]) return true;
	const normalized = path.startsWith("/") ? path.slice(1) : "/" + path;
	if (archive.files[normalized]) return true;
	const lpath = path.toLowerCase();
	for (const k of Object.keys(archive.files)) if (k.toLowerCase() === lpath) return true;
	return false;
}

//#endregion
//#region src/xml/limits.ts
const DEFAULT_MAX_XML_PART_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_XML_TAGS = 5e6;
const DEFAULT_MAX_XML_NESTING_DEPTH = 256;
const DEFAULT_MAX_XML_TAG_LENGTH = 1024 * 1024;
const DEFAULT_MAX_XML_ATTRIBUTES_PER_TAG = 1e4;
const DEFAULT_MAX_SHARED_STRING_ITEMS = 1e6;
const DEFAULT_MAX_WORKSHEET_ROWS = 1048576;
const DEFAULT_MAX_WORKSHEET_CELLS = 1e7;
function xmlOptionLimit(value, fallback, name) {
	if (value == null) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new XlsxError("INVALID_ARGUMENT", `Invalid XML option: ${name} must be a non-negative finite number`);
	return value;
}
function assertXmlCountWithinLimit(kind, count, limit) {
	if (count > limit) throw new XlsxError("LIMIT_EXCEEDED", `Invalid XML: ${kind} count ${count} exceeds limit ${limit}`);
}
function assertXmlPartLimits(partName, data, opts) {
	const maxXmlPartBytes = xmlOptionLimit(opts?.maxXmlPartBytes, DEFAULT_MAX_XML_PART_BYTES, "maxXmlPartBytes");
	if (data.length > maxXmlPartBytes) throw new XlsxError("LIMIT_EXCEEDED", `Invalid XML: ${partName} size ${data.length} exceeds limit ${maxXmlPartBytes}`);
	const maxXmlTags = xmlOptionLimit(opts?.maxXmlTags, DEFAULT_MAX_XML_TAGS, "maxXmlTags");
	const maxXmlNestingDepth = xmlOptionLimit(opts?.maxXmlNestingDepth, 256, "maxXmlNestingDepth");
	const maxXmlTagLength = xmlOptionLimit(opts?.maxXmlTagLength, DEFAULT_MAX_XML_TAG_LENGTH, "maxXmlTagLength");
	let tagCount = 0;
	let depth = 0;
	let offset = -1;
	while ((offset = data.indexOf("<", offset + 1)) !== -1) {
		assertXmlCountWithinLimit(`${partName} tag`, ++tagCount, maxXmlTags);
		const closeOffset = data.indexOf(">", offset + 1);
		const tagLength = closeOffset === -1 ? data.length - offset : closeOffset - offset + 1;
		if (tagLength > maxXmlTagLength) throw new XlsxError("LIMIT_EXCEEDED", `Invalid XML: ${partName} tag length ${tagLength} exceeds limit ${maxXmlTagLength}`);
		if (closeOffset === -1) break;
		let tagStart = offset + 1;
		while (tagStart < closeOffset && data.charCodeAt(tagStart) <= 32) ++tagStart;
		const first = data.charCodeAt(tagStart);
		const isClosingTag = first === 47;
		const isProcessingOrDeclaration = first === 33 || first === 63;
		const isSelfClosing = data.charCodeAt(closeOffset - 1) === 47;
		if (isClosingTag) depth = Math.max(0, depth - 1);
		else if (!isProcessingOrDeclaration && !isSelfClosing && ++depth > maxXmlNestingDepth) throw new XlsxError("LIMIT_EXCEEDED", `Invalid XML: ${partName} nesting depth ${depth} exceeds limit ${maxXmlNestingDepth}`);
		offset = closeOffset;
	}
}

//#endregion
//#region src/xml/parser.ts
const attregexg = /\s([^"\s?>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^'">\s]+))/g;
const tagregex1 = /<[/?]?[\w:-]+(?:\s+[^"\s?<>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[/?]?>/g;
const tagregex2 = /<[^<>]*>/g;
/** Standard XML declaration header with UTF-8 encoding and Windows line ending */
const XML_HEADER = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
/**
* The regex used to tokenize XML tags throughout the codebase.
* Uses the strict pattern if it can match the XML header, otherwise falls back to the lenient one.
*/
const XML_TAG_REGEX = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n".match(tagregex1) ? tagregex1 : tagregex2;
const nsregex2 = /<(\/?)\w+:/;
/**
* Parse XML attributes from a raw tag string into a key-value record.
* Handles namespace prefixes by stripping them (e.g., "r:id" becomes "id").
* Stores the tag name itself under key `0` unless skip_root is true.
* @param tag - the raw XML tag string (e.g., `<Relationship Id="rId1" Target="..."/>`)
* @param skip_root - if true, do not store the tag name under key `0`
* @param skip_LC - if true, do not store lowercase copies of attribute names
* @param opts - XML parsing limits
* @returns a record mapping attribute names to their values
*/
function parseXmlTag(tag, skip_root, skip_LC, opts) {
	const attrs = {};
	let scanPos = 0;
	let charCode = 0;
	for (; scanPos !== tag.length; ++scanPos) if ((charCode = tag.charCodeAt(scanPos)) === 32 || charCode === 10 || charCode === 13) break;
	if (!skip_root) attrs[0] = tag.slice(0, scanPos);
	if (scanPos === tag.length) return attrs;
	const maxXmlAttributesPerTag = xmlOptionLimit(opts?.maxXmlAttributesPerTag, DEFAULT_MAX_XML_ATTRIBUTES_PER_TAG, "maxXmlAttributesPerTag");
	attregexg.lastIndex = 0;
	let attrMatch;
	let attrCount = 0;
	while (attrMatch = attregexg.exec(tag)) {
		assertXmlCountWithinLimit("XML attribute", ++attrCount, maxXmlAttributesPerTag);
		const attrStr = attrMatch[0].slice(1);
		let eqPos = 0;
		for (eqPos = 0; eqPos < attrStr.length; ++eqPos) if (attrStr.charCodeAt(eqPos) === 61) break;
		let attrName = attrStr.slice(0, eqPos).trim();
		while (attrStr.charCodeAt(eqPos + 1) === 32) ++eqPos;
		const quoteOffset = (scanPos = attrStr.charCodeAt(eqPos + 1)) === 34 || scanPos === 39 ? 1 : 0;
		const attrValue = attrStr.slice(eqPos + 1 + quoteOffset, attrStr.length - quoteOffset);
		let colonPos = 0;
		for (colonPos = 0; colonPos < attrName.length; ++colonPos) if (attrName.charCodeAt(colonPos) === 58) break;
		if (colonPos === attrName.length) {
			if (attrName.indexOf("_") > 0) attrName = attrName.slice(0, attrName.indexOf("_"));
			attrs[attrName] = attrValue;
			if (!skip_LC) attrs[attrName.toLowerCase()] = attrValue;
		} else {
			const localName = (colonPos === 5 && attrName.slice(0, 5) === "xmlns" ? "xmlns" : "") + attrName.slice(colonPos + 1);
			if (attrs[localName] && attrName.slice(colonPos - 3, colonPos) === "ext") continue;
			attrs[localName] = attrValue;
			if (!skip_LC) attrs[localName.toLowerCase()] = attrValue;
		}
	}
	return attrs;
}
/**
* Strip namespace prefixes from XML tag names (e.g., `<a:foo>` becomes `<foo>`).
* @param x - XML string with possible namespace prefixes
* @returns the XML string with namespace prefixes removed from tag names
*/
function stripNamespace(x) {
	return x.replace(nsregex2, "<$1");
}
/**
* Parse xsd:boolean-compatible values to a native boolean.
* Accepts 1, true, "1", "true" as truthy; 0, false, "0", "false" as falsy.
* @param value - the value to interpret as boolean
* @returns true or false
*/
function parseXmlBoolean(value) {
	switch (value) {
		case 1:
		case true:
		case "1":
		case "true": return true;
		case 0:
		case false:
		case "0":
		case "false": return false;
	}
	return false;
}

//#endregion
//#region src/xml/escape.ts
/** Lookup table mapping XML named entities to their decoded characters */
const encodings = {
	"&quot;": "\"",
	"&apos;": "'",
	"&gt;": ">",
	"&lt;": "<",
	"&amp;": "&"
};
/** Reverse lookup: special characters to their XML entity representations */
const XML_ESCAPE_MAP = {
	"\"": "&quot;",
	"'": "&apos;",
	">": "&gt;",
	"<": "&lt;",
	"&": "&amp;"
};
const encregex = /&(?:quot|apos|gt|lt|amp|#x?([\da-f]+));/gi;
const coderegex = /_x([\da-fA-F]{4})_/g;
const decregex = /[&<>'"]/g;
const charegex = /[\u0000-\u0008\u000b-\u001f\uFFFE\uFFFF]/g;
/**
* Recursively unescape XML entities, handling CDATA sections.
* @param text - raw XML text potentially containing entities and CDATA blocks
* @returns the fully unescaped string
*/
function rawUnescapeXml(text) {
	const str = text;
	const i = str.indexOf("<![CDATA[");
	if (i === -1) return str.replace(encregex, ($$, $1) => {
		return encodings[$$] || String.fromCharCode(parseInt($1, $$.indexOf("x") > -1 ? 16 : 10)) || $$;
	}).replace(coderegex, (_m, c) => {
		return String.fromCharCode(parseInt(c, 16));
	});
	const cdataEndIdx = str.indexOf("]]>");
	return rawUnescapeXml(str.slice(0, i)) + str.slice(i + 9, cdataEndIdx) + rawUnescapeXml(str.slice(cdataEndIdx + 3));
}
/**
* Unescape XML entities in a string. Optionally normalize line endings for XLSX.
* @param text - XML-encoded text to unescape
* @param xlsx - when true, normalize \r\n line endings to \n
* @returns the unescaped string
*/
function unescapeXml(text, xlsx) {
	const out = rawUnescapeXml(text);
	return xlsx ? out.replace(/\r\n/g, "\n") : out;
}
/**
* Escape a string for safe inclusion as XML text content.
* Replaces &, <, >, ', " with named entities, and encodes illegal
* control characters using OOXML _xHHHH_ notation.
* @param text - plain text to escape
* @returns XML-safe string
*/
function escapeXml(text) {
	return text.replace(decregex, (char) => XML_ESCAPE_MAP[char]).replace(charegex, (char) => "_x" + ("000" + char.charCodeAt(0).toString(16)).slice(-4) + "_");
}
const htmlcharegex = /[\u0000-\u001f]/g;
/**
* Escape a string for HTML output.
* Replaces XML-special characters with entities, converts newlines to <br/>,
* and encodes remaining control characters as hex character references.
* @param text - plain text to escape for HTML
* @returns HTML-safe string
*/
function escapeHtml(text) {
	return text.replace(decregex, (char) => XML_ESCAPE_MAP[char]).replace(/\n/g, "<br/>").replace(htmlcharegex, (char) => "&#x" + ("000" + char.charCodeAt(0).toString(16)).slice(-4) + ";");
}
/** Pre-compiled entity patterns paired with their replacement characters for HTML decoding */
const entities = [
	["nbsp", " "],
	["middot", "·"],
	["quot", "\""],
	["apos", "'"],
	["gt", ">"],
	["lt", "<"],
	["amp", "&"]
].map(([name, ch]) => [new RegExp("&" + name + ";", "gi"), ch]);

//#endregion
//#region src/xml/writer.ts
const wtregex = /(^\s|\s$|\n)/;
/**
* Write a simple XML tag wrapping text content.
* Automatically adds xml:space="preserve" when the content has
* leading/trailing whitespace or embedded newlines.
* @param tagName - the XML element name
* @param content - the text content to wrap
* @returns an XML string like `<tag>content</tag>`
*/
function writeXmlTag(tagName, content) {
	return "<" + tagName + (content.match(wtregex) ? " xml:space=\"preserve\"" : "") + ">" + content + "</" + tagName + ">";
}
/**
* Format a key-value record as XML attribute pairs.
* @param attributes - attribute name/value pairs
* @returns a string of ` key="value"` segments (with leading spaces)
*/
function formatXmlAttributes$1(attributes) {
	return Object.keys(attributes).map((key) => " " + key + "=\"" + attributes[key] + "\"").join("");
}
/**
* Write an XML element with optional attributes and optional content.
* When content is null/undefined, emits a self-closing tag (`<tag .../>`).
* When content is provided, adds xml:space="preserve" if needed.
* @param tagName - the XML element name
* @param content - text content, or null for self-closing tag
* @param attributes - optional attribute key-value pairs
* @returns the complete XML element string
*/
function writeXmlElement(tagName, content, attributes) {
	return "<" + tagName + (attributes != null ? formatXmlAttributes$1(attributes) : "") + (content != null ? (content.match(wtregex) ? " xml:space=\"preserve\"" : "") + ">" + content + "</" + tagName : "/") + ">";
}
/**
* Write a W3C datetime string (ISO 8601 without fractional seconds) from a Date object.
* Used for dcterms:created/modified and vt:filetime elements.
* @param date - the Date to serialize
* @param throwOnError - when true, rethrow invalid Date errors instead of returning ""
* @returns an ISO datetime string like "2024-01-15T10:30:00Z", or "" on error
*/
function writeW3cDatetime(date, throwOnError) {
	try {
		return date.toISOString().replace(/\.\d*/, "");
	} catch (error) {
		if (throwOnError) throw error;
	}
	return "";
}
/**
* Write an OPC variant-type (vt:) XML element for a given JavaScript value.
* Dispatches on the runtime type to choose the appropriate vt: element:
* - string  -> vt:lpwstr
* - number  -> vt:i4 (integer) or vt:r8 (float)
* - boolean -> vt:bool
* - Date    -> vt:filetime
* @param value - the value to serialize
* @param xlsx - when true, escape double-quotes as _x0022_ (OOXML convention)
* @returns an XML string containing the appropriate vt: element
* @throws XlsxError if value is an unsupported type
*/
function writeVariantType(value, xlsx) {
	switch (typeof value) {
		case "string": {
			let output = writeXmlElement("vt:lpwstr", escapeXml(value));
			if (xlsx) output = output.replace(/&quot;/g, "_x0022_");
			return output;
		}
		case "number": return writeXmlElement((value | 0) === value ? "vt:i4" : "vt:r8", escapeXml(String(value)));
		case "boolean": return writeXmlElement("vt:bool", value ? "true" : "false");
	}
	if (value instanceof Date) return writeXmlElement("vt:filetime", writeW3cDatetime(value));
	throw new XlsxError("INVALID_ARGUMENT", "Unable to serialize " + String(value));
}

//#endregion
//#region src/xml/namespaces.ts
/**
* Standard XML namespace URIs used in OPC (Open Packaging Conventions) and OOXML documents.
* Keys are short identifiers used throughout the codebase; values are the full namespace URIs.
*/
const XMLNS = {
	CORE_PROPS: "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
	CUST_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
	EXT_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
	CT: "http://schemas.openxmlformats.org/package/2006/content-types",
	RELS: "http://schemas.openxmlformats.org/package/2006/relationships",
	TCMNT: "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments",
	dc: "http://purl.org/dc/elements/1.1/",
	dcterms: "http://purl.org/dc/terms/",
	dcmitype: "http://purl.org/dc/dcmitype/",
	mx: "http://schemas.microsoft.com/office/mac/excel/2008/main",
	r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	sjs: "http://schemas.openxmlformats.org/package/2006/sheetjs/core-properties",
	vt: "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
	xsi: "http://www.w3.org/2001/XMLSchema-instance",
	xsd: "http://www.w3.org/2001/XMLSchema"
};
/**
* Recognized namespace URIs for the SpreadsheetML main namespace.
* Multiple URIs exist because OOXML has both ECMA-376 and transitional/strict variants,
* plus Microsoft-specific extensions.
*/
const XMLNS_main = [
	"http://schemas.openxmlformats.org/spreadsheetml/2006/main",
	"http://purl.oclc.org/ooxml/spreadsheetml/main",
	"http://schemas.microsoft.com/office/excel/2006/main",
	"http://schemas.microsoft.com/office/excel/2006/2"
];
/**
* OPC relationship type URIs.
* Each key is a short identifier; each value is the full relationship type URI
* used in .rels files to link package parts together.
*/
const RELS = {
	WB: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
	SHEET: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
	CHARTSHEET: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet",
	HLINK: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
	VML: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing",
	CMNT: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
	CORE_PROPS: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
	EXT_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
	CUST_PROPS: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
	SST: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
	STY: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
	THEME: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
	CHART: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
	CCHAIN: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain",
	TCMNT: "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment",
	PEOPLE: "http://schemas.microsoft.com/office/2017/10/relationships/person",
	DRAWING: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
	META: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata",
	XLINK: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink"
};

//#endregion
//#region src/opc/content-types.ts
const nsregex = /<(\w+):/;
/**
* Map from OOXML content-type MIME strings to internal category names.
* Used during parsing to classify each Override entry into the correct bucket.
*/
const CONTENT_TYPE_MAP = {
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": "workbooks",
	"application/vnd.ms-excel.sheet.macroEnabled.main+xml": "workbooks",
	"application/vnd.ms-excel.sheet.binary.macroEnabled.main": "workbooks",
	"application/vnd.ms-excel.addin.macroEnabled.main+xml": "workbooks",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": "workbooks",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": "sheets",
	"application/vnd.ms-excel.worksheet": "sheets",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": "charts",
	"application/vnd.ms-excel.chartsheet": "charts",
	"application/vnd.ms-excel.macrosheet+xml": "macros",
	"application/vnd.ms-excel.macrosheet": "macros",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": "dialogs",
	"application/vnd.ms-excel.dialogsheet": "dialogs",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml": "strs",
	"application/vnd.ms-excel.sharedStrings": "strs",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": "styles",
	"application/vnd.ms-excel.styles": "styles",
	"application/vnd.openxmlformats-package.core-properties+xml": "coreprops",
	"application/vnd.openxmlformats-officedocument.custom-properties+xml": "custprops",
	"application/vnd.openxmlformats-officedocument.extended-properties+xml": "extprops",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": "comments",
	"application/vnd.ms-excel.comments": "comments",
	"application/vnd.ms-excel.threadedcomments+xml": "threadedcomments",
	"application/vnd.ms-excel.person+xml": "people",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml": "metadata",
	"application/vnd.ms-excel.sheetMetadata": "metadata",
	"application/vnd.ms-excel.calcChain": "calcchains",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml": "calcchains",
	"application/vnd.openxmlformats-officedocument.theme+xml": "themes",
	"application/vnd.ms-office.vbaProject": "vba",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml": "links",
	"application/vnd.ms-excel.externalLink": "links",
	"application/vnd.openxmlformats-officedocument.drawing+xml": "drawings",
	"application/vnd.openxmlformats-package.relationships+xml": "rels"
};
/**
* Reverse lookup: maps internal category names to the preferred content-type strings
* for writing, keyed by book type (e.g., "xlsx", "xlsm").
*/
const CT_LIST = {
	workbooks: {
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
		xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
	},
	strs: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml" },
	comments: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml" },
	sheets: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" },
	charts: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml" },
	dialogs: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml" },
	macros: { xlsx: "application/vnd.ms-excel.macrosheet+xml" },
	metadata: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml" },
	styles: { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" }
};
/**
* Create an empty ContentTypes object with all category arrays initialized.
* @returns a fresh ContentTypes with empty arrays for every category
*/
function createContentTypes() {
	return {
		workbooks: [],
		sheets: [],
		charts: [],
		dialogs: [],
		macros: [],
		rels: [],
		strs: [],
		comments: [],
		threadedcomments: [],
		links: [],
		coreprops: [],
		extprops: [],
		custprops: [],
		themes: [],
		styles: [],
		calcchains: [],
		vba: [],
		drawings: [],
		metadata: [],
		people: [],
		xmlns: ""
	};
}
/**
* Parse the [Content_Types].xml file from an OPC package.
* Processes `<Default>` entries (file extension -> content type) and
* `<Override>` entries (part path -> content type), classifying each
* override into the appropriate category array.
* @param data - raw XML string of the [Content_Types].xml file (may be null/undefined)
* @returns a populated ContentTypes object
* @throws XlsxError if the root namespace is not the expected OPC content-types namespace
*/
function parseContentTypes(data, opts) {
	const ct = createContentTypes();
	if (!data) return ct;
	const ctext = {};
	const matches = data.match(XML_TAG_REGEX) || [];
	for (const x of matches) {
		const y = parseXmlTag(x, void 0, void 0, opts);
		switch (y[0].replace(nsregex, "<")) {
			case "<?xml": break;
			case "<Types":
				ct.xmlns = y["xmlns" + (y[0].match(/<(\w+):/) || ["", ""])[1]];
				break;
			case "<Default":
				ctext[y.Extension.toLowerCase()] = y.ContentType;
				break;
			case "<Override":
				if (CONTENT_TYPE_MAP[y.ContentType] && ct[CONTENT_TYPE_MAP[y.ContentType]] !== void 0) ct[CONTENT_TYPE_MAP[y.ContentType]].push(y.PartName);
				break;
		}
	}
	if (ct.xmlns !== XMLNS.CT) throw new XlsxError("UNSUPPORTED", "Unknown Namespace: " + ct.xmlns);
	ct.calcchain = ct.calcchains.length > 0 ? ct.calcchains[0] : "";
	ct.sst = ct.strs.length > 0 ? ct.strs[0] : "";
	ct.style = ct.styles.length > 0 ? ct.styles[0] : "";
	ct.defaults = ctext;
	return ct;
}
/**
* Build a reverse map from category name to an array of content-type strings.
* @param obj - the forward map (content-type -> category)
* @returns a record mapping each category to all its content-type strings
*/
function invertToArrayMap(obj) {
	const o = {};
	for (const [k, v] of Object.entries(obj)) {
		if (!o[v]) o[v] = [];
		o[v].push(k);
	}
	return o;
}
/**
* Serialize a ContentTypes object to [Content_Types].xml format.
* Emits `<Default>` entries for file extensions and `<Override>` entries
* for each registered part, choosing the correct content-type string
* based on the target book type.
* @param ct - the ContentTypes object to serialize
* @param opts - options containing the target bookType (e.g., "xlsx", "xlsm")
* @returns the complete XML string for [Content_Types].xml
*/
function writeContentTypes(ct, opts) {
	const type2ct = invertToArrayMap(CONTENT_TYPE_MAP);
	const o = [];
	o.push(XML_HEADER);
	o.push(writeXmlElement("Types", null, {
		xmlns: XMLNS.CT,
		"xmlns:xsd": XMLNS.xsd,
		"xmlns:xsi": XMLNS.xsi
	}));
	for (const [ext, contentType] of [
		["xml", "application/xml"],
		["bin", "application/vnd.ms-excel.sheet.binary.macroEnabled.main"],
		["vml", "application/vnd.openxmlformats-officedocument.vmlDrawing"],
		["data", "application/vnd.openxmlformats-officedocument.model+data"],
		["bmp", "image/bmp"],
		["png", "image/png"],
		["gif", "image/gif"],
		["emf", "image/x-emf"],
		["wmf", "image/x-wmf"],
		["jpg", "image/jpeg"],
		["jpeg", "image/jpeg"],
		["tif", "image/tiff"],
		["tiff", "image/tiff"],
		["pdf", "application/pdf"],
		["rels", "application/vnd.openxmlformats-package.relationships+xml"]
	]) o.push(writeXmlElement("Default", null, {
		Extension: ext,
		ContentType: contentType
	}));
	const f1 = (w) => {
		if (ct[w] && ct[w].length > 0) {
			const v = ct[w][0];
			o.push(writeXmlElement("Override", null, {
				PartName: (v[0] === "/" ? "" : "/") + v,
				ContentType: CT_LIST[w]?.[opts.bookType || "xlsx"] || CT_LIST[w]?.xlsx
			}));
		}
	};
	const f2 = (w) => {
		for (const v of ct[w] || []) o.push(writeXmlElement("Override", null, {
			PartName: (v[0] === "/" ? "" : "/") + v,
			ContentType: CT_LIST[w]?.[opts.bookType || "xlsx"] || CT_LIST[w]?.xlsx
		}));
	};
	const f3 = (t) => {
		for (const v of ct[t] || []) o.push(writeXmlElement("Override", null, {
			PartName: (v[0] === "/" ? "" : "/") + v,
			ContentType: type2ct[t]?.[0]
		}));
	};
	f1("workbooks");
	f2("sheets");
	f2("charts");
	f3("themes");
	f1("strs");
	f1("styles");
	f3("coreprops");
	f3("extprops");
	f3("custprops");
	f3("vba");
	f3("comments");
	f3("threadedcomments");
	f3("drawings");
	f2("metadata");
	f3("people");
	if (o.length > 2) {
		o.push("</Types>");
		o[1] = o[1].replace("/>", ">");
	}
	return o.join("");
}

//#endregion
//#region src/opc/relationships.ts
/**
* Resolve a relative target path against a base file path.
* Handles ".." segments to navigate up the directory tree.
* Absolute paths (starting with "/") are returned as-is.
* @param target - the relative or absolute target path
* @param basePath - the path of the file that contains the relationship
* @returns the resolved absolute path
*/
function resolve_path$1(target, basePath) {
	if (target.charAt(0) === "/") return target;
	const parts = (basePath.slice(0, basePath.lastIndexOf("/") + 1) + target).split("/");
	const resolved = [];
	for (const p of parts) if (p === "..") resolved.pop();
	else if (p !== ".") resolved.push(p);
	return resolved.join("/");
}
/**
* Get the conventional .rels file path for a given OPC part.
* For example, "xl/workbook.xml" becomes "xl/_rels/workbook.xml.rels".
* @param file - the OPC part path
* @returns the corresponding .rels file path
*/
function getRelsPath(file) {
	const n = file.lastIndexOf("/");
	return file.slice(0, n + 1) + "_rels/" + file.slice(n + 1) + ".rels";
}
/**
* Parse a .rels XML file into a Relationships object.
* Each Relationship element is stored both by its resolved target path
* and by its rId in the "!id" lookup table.
* @param data - raw XML string of the .rels file (may be null/undefined)
* @param currentFilePath - the path of the file that owns this .rels (used for path resolution)
* @returns the parsed Relationships object
*/
function parseRelationships(data, currentFilePath, opts) {
	const rels = { "!id": {} };
	if (!data) return rels;
	if (currentFilePath.charAt(0) !== "/") currentFilePath = "/" + currentFilePath;
	const matches = data.match(XML_TAG_REGEX) || [];
	for (const x of matches) {
		const y = parseXmlTag(x, void 0, void 0, opts);
		if (y[0] === "<Relationship") {
			const rel = {
				Type: y.Type,
				Target: unescapeXml(y.Target),
				Id: y.Id
			};
			if (y.TargetMode) rel.TargetMode = y.TargetMode;
			const canonictarget = y.TargetMode === "External" ? y.Target : resolve_path$1(y.Target, currentFilePath);
			rels[canonictarget] = rel;
			rels["!id"][y.Id] = rel;
		}
	}
	return rels;
}
/**
* Serialize a Relationships object back to .rels XML format.
* @param rels - the Relationships object to serialize
* @returns the complete XML string for the .rels file
*/
function writeRelationships(rels) {
	const o = [XML_HEADER, writeXmlElement("Relationships", null, { xmlns: XMLNS.RELS })];
	for (const rid of Object.keys(rels["!id"])) o.push(writeXmlElement("Relationship", null, rels["!id"][rid]));
	if (o.length > 2) {
		o.push("</Relationships>");
		o[1] = o[1].replace("/>", ">");
	}
	return o.join("");
}
/**
* Add a new relationship entry to a Relationships object.
* If rId is negative, automatically finds the next available rId.
* Hyperlink-type relationships default to TargetMode="External".
* @param rels - the Relationships object to modify
* @param rId - the numeric relationship ID to use, or negative to auto-assign
* @param f - the target path for the relationship
* @param type - the relationship type URI
* @param targetmode - optional TargetMode ("External" for hyperlinks, etc.)
* @returns the numeric rId that was assigned
* @throws XlsxError if the specified rId is already in use
*/
function addRelationship(rels, rId, f, type, targetmode) {
	if (!rels["!id"]) rels["!id"] = {};
	if (!rels["!idx"]) rels["!idx"] = 1;
	if (rId < 0) for (rId = rels["!idx"]; rels["!id"]["rId" + rId]; ++rId);
	rels["!idx"] = rId + 1;
	const relobj = {
		Id: "rId" + rId,
		Type: type,
		Target: f
	};
	if (targetmode) relobj.TargetMode = targetmode;
	else if ([RELS.HLINK].indexOf(type) > -1) relobj.TargetMode = "External";
	if (rels["!id"][relobj.Id]) throw new XlsxError("DUPLICATE", "Cannot rewrite rId " + rId);
	rels["!id"][relobj.Id] = relobj;
	rels[("/" + relobj.Target).replace("//", "/")] = relobj;
	return rId;
}

//#endregion
//#region src/opc/core-properties.ts
/**
* Mapping of OPC core property XML tag names to their FullProperties keys.
* Each entry is [xmlTagName, propertyKey, optionalType].
* When the optional type is "date", the parsed value is converted to a Date object.
*/
const CORE_PROPS = [
	["cp:category", "Category"],
	["cp:contentStatus", "ContentStatus"],
	["cp:keywords", "Keywords"],
	["cp:lastModifiedBy", "LastAuthor"],
	["cp:lastPrinted", "LastPrinted"],
	["cp:revision", "Revision"],
	["cp:version", "Version"],
	["dc:creator", "Author"],
	["dc:description", "Comments"],
	["dc:identifier", "Identifier"],
	["dc:language", "Language"],
	["dc:subject", "Subject"],
	["dc:title", "Title"],
	[
		"dcterms:created",
		"CreatedDate",
		"date"
	],
	[
		"dcterms:modified",
		"ModifiedDate",
		"date"
	]
];
/**
* Extract text content between an XML open/close tag pair using simple string search.
* Does not handle nested tags of the same name -- sufficient for flat OPC property elements.
* @param data - the XML string to search
* @param tag - the fully-qualified tag name (e.g., "dc:title")
* @returns the text content between the tags, or null if not found
*/
function xml_extract(data, tag) {
	const open = "<" + tag;
	const close = "</" + tag + ">";
	const openTagIdx = data.indexOf(open);
	if (openTagIdx === -1) return null;
	const closeAngleIdx = data.indexOf(">", openTagIdx);
	if (closeAngleIdx === -1) return null;
	const closeTagIdx = data.indexOf(close, closeAngleIdx);
	if (closeTagIdx === -1) return null;
	return data.slice(closeAngleIdx + 1, closeTagIdx);
}
/**
* Parse OPC core properties XML (dc:title, dc:creator, dcterms:created, etc.)
* into a partial FullProperties object.
* @param data - raw XML string of the core properties part
* @returns parsed property values
*/
function parseCoreProperties(data) {
	const p = {};
	for (const propDef of CORE_PROPS) {
		const content = xml_extract(data, propDef[0]);
		if (content != null && content.length > 0) p[propDef[1]] = unescapeXml(content);
		if (propDef[2] === "date" && p[propDef[1]]) p[propDef[1]] = new Date(p[propDef[1]]);
	}
	return p;
}
/**
* Write a single property field to the output lines array, avoiding duplicates.
* @param tagName - the XML tag name (e.g., "dc:title")
* @param value - the text value to write (null/undefined/empty are skipped)
* @param attributes - optional attributes for the element (e.g., xsi:type for dates)
* @param lines - output array to append the XML element to
* @param written - tracks already-written tags to prevent duplicate entries
*/
function writePropertyField(tagName, value, attributes, lines, written) {
	if (written[tagName] != null || value == null || value === "") return;
	written[tagName] = value;
	value = escapeXml(value);
	lines.push(attributes ? writeXmlElement(tagName, value, attributes) : writeXmlTag(tagName, value));
}
/**
* Serialize OPC core properties to XML.
* Produces the cp:coreProperties element with Dublin Core metadata fields.
* @param cp - the properties to serialize (may be undefined)
* @param opts - optional settings: WTF enables strict date errors, Props provides overrides
* @returns the complete XML string for the core properties part
*/
function writeCoreProperties(cp, opts) {
	const lines = [XML_HEADER, writeXmlElement("cp:coreProperties", null, {
		"xmlns:cp": XMLNS.CORE_PROPS,
		"xmlns:dc": XMLNS.dc,
		"xmlns:dcterms": XMLNS.dcterms,
		"xmlns:dcmitype": XMLNS.dcmitype,
		"xmlns:xsi": XMLNS.xsi
	})];
	const written = {};
	if (!cp && !opts?.Props) return lines.join("");
	if (cp) {
		if (cp.CreatedDate != null) writePropertyField("dcterms:created", typeof cp.CreatedDate === "string" ? cp.CreatedDate : writeW3cDatetime(cp.CreatedDate, opts?.WTF), { "xsi:type": "dcterms:W3CDTF" }, lines, written);
		if (cp.ModifiedDate != null) writePropertyField("dcterms:modified", typeof cp.ModifiedDate === "string" ? cp.ModifiedDate : writeW3cDatetime(cp.ModifiedDate, opts?.WTF), { "xsi:type": "dcterms:W3CDTF" }, lines, written);
	}
	for (const propDef of CORE_PROPS) {
		let propValue = opts?.Props?.[propDef[1]] != null ? opts.Props[propDef[1]] : cp ? cp[propDef[1]] : null;
		if (propValue === true) propValue = "1";
		else if (propValue === false) propValue = "0";
		else if (typeof propValue === "number") propValue = String(propValue);
		if (propValue != null) writePropertyField(propDef[0], propValue, null, lines, written);
	}
	if (lines.length > 2) {
		lines.push("</cp:coreProperties>");
		lines[1] = lines[1].replace("/>", ">");
	}
	return lines.join("");
}

//#endregion
//#region src/opc/extended-properties.ts
/**
* Mapping of extended property XML element names to FullProperties keys and value types.
* Each entry is [xmlElementName, propertyKey, valueType].
*/
const EXT_PROPS = [
	[
		"Application",
		"Application",
		"string"
	],
	[
		"AppVersion",
		"AppVersion",
		"string"
	],
	[
		"Company",
		"Company",
		"string"
	],
	[
		"DocSecurity",
		"DocSecurity",
		"string"
	],
	[
		"Manager",
		"Manager",
		"string"
	],
	[
		"HyperlinksChanged",
		"HyperlinksChanged",
		"bool"
	],
	[
		"SharedDoc",
		"SharedDoc",
		"bool"
	],
	[
		"LinksUpToDate",
		"LinksUpToDate",
		"bool"
	],
	[
		"ScaleCrop",
		"ScaleCrop",
		"bool"
	]
];
/**
* Extract text content from an XML tag, allowing for optional namespace prefixes.
* Builds a regex that matches both `<tag>` and `<ns:tag>` forms.
* @param data - the XML string to search
* @param tag - the local element name (without namespace prefix)
* @returns the text content, or null if not found
*/
function xml_extract_ns(data, tag) {
	const re = new RegExp("<(?:\\w+:)?" + tag + "[\\s>]([\\s\\S]*?)<\\/(?:\\w+:)?" + tag + ">");
	const m = data.match(re);
	return m ? m[1] : null;
}
/**
* Parse OPC extended properties XML (Application, AppVersion, HeadingPairs, etc.)
* into a partial FullProperties object.
* @param data - raw XML string of the extended properties part
* @param props - optional existing properties object to merge into
* @returns the populated properties object
*/
function parseExtendedProperties(data, props) {
	if (!props) props = {};
	for (const propDef of EXT_PROPS) {
		const xml = xml_extract_ns(data, propDef[0]);
		switch (propDef[2]) {
			case "string":
				if (xml) props[propDef[1]] = unescapeXml(xml);
				break;
			case "bool":
				props[propDef[1]] = xml === "true";
				break;
		}
	}
	const hpMatch = data.match(/<HeadingPairs>([\s\S]*?)<\/HeadingPairs>/);
	const topMatch = data.match(/<TitlesOfParts>([\s\S]*?)<\/TitlesOfParts>/);
	if (hpMatch && topMatch) {
		const lpstrs = topMatch[1].match(/<vt:lpstr>([\s\S]*?)<\/vt:lpstr>/g);
		if (lpstrs) {
			const parts = lpstrs.map((lpstr) => {
				const match = lpstr.match(/<vt:lpstr>([\s\S]*?)<\/vt:lpstr>/);
				return match ? unescapeXml(match[1]) : "";
			});
			const i4match = hpMatch[1].match(/<vt:i4>(\d+)<\/vt:i4>/);
			if (i4match) {
				props.Worksheets = parseInt(i4match[1], 10);
				props.SheetNames = parts.slice(0, props.Worksheets);
			}
		}
	}
	return props;
}
/**
* Serialize OPC extended properties to XML.
* Produces the Properties element with application metadata and sheet information.
* @param cp - record of property values (may be undefined; defaults are applied)
* @returns the complete XML string for the extended properties part
*/
function writeExtendedProperties(cp) {
	const lines = [];
	const writeElement = writeXmlElement;
	if (!cp) cp = {};
	cp.Application = "xlsx-format";
	lines.push(XML_HEADER);
	lines.push(writeXmlElement("Properties", null, {
		xmlns: XMLNS.EXT_PROPS,
		"xmlns:vt": XMLNS.vt
	}));
	for (const propDef of EXT_PROPS) {
		if (cp[propDef[1]] === void 0) continue;
		let propValue;
		switch (propDef[2]) {
			case "string":
				propValue = escapeXml(String(cp[propDef[1]]));
				break;
			case "bool":
				propValue = cp[propDef[1]] ? "true" : "false";
				break;
		}
		if (propValue !== void 0) lines.push(writeElement(propDef[0], propValue));
	}
	lines.push(writeElement("HeadingPairs", writeElement("vt:vector", writeElement("vt:variant", "<vt:lpstr>Worksheets</vt:lpstr>") + writeElement("vt:variant", writeElement("vt:i4", String(cp.Worksheets))), {
		size: "2",
		baseType: "variant"
	})));
	lines.push(writeElement("TitlesOfParts", writeElement("vt:vector", cp.SheetNames.map((sheetName) => "<vt:lpstr>" + escapeXml(sheetName) + "</vt:lpstr>").join(""), {
		size: String(cp.Worksheets),
		baseType: "lpstr"
	})));
	if (lines.length > 2) {
		lines.push("</Properties>");
		lines[1] = lines[1].replace("/>", ">");
	}
	return lines.join("");
}

//#endregion
//#region src/opc/custom-properties.ts
const custregex = /<[^<>]+>[^<]*/g;
/**
* Parse OPC custom properties XML into a key-value record.
* Custom properties are user-defined metadata stored as typed vt: variant elements
* (strings, booleans, integers, floats, dates, etc.).
* @param data - raw XML string of the custom properties part
* @param opts - optional settings: WTF enables console warnings for unknown types
* @returns a record mapping property names to their parsed values
*/
function parseCustomProperties(data, opts) {
	const p = {};
	let name = "";
	const matches = data.match(custregex);
	if (matches) for (let i = 0; i < matches.length; ++i) {
		const tagStr = matches[i];
		const parsedTag = parseXmlTag(tagStr);
		switch (stripNamespace(parsedTag[0])) {
			case "<?xml": break;
			case "<Properties": break;
			case "<property":
				name = unescapeXml(parsedTag.name);
				break;
			case "</property>":
				name = "";
				break;
			default: if (tagStr.indexOf("<vt:") === 0) {
				const tokens = tagStr.split(">");
				const type = tokens[0].slice(4);
				const text = tokens[1];
				switch (type) {
					case "lpstr":
					case "bstr":
					case "lpwstr":
						p[name] = unescapeXml(text);
						break;
					case "bool":
						p[name] = parseXmlBoolean(text);
						break;
					case "i1":
					case "i2":
					case "i4":
					case "i8":
					case "int":
					case "uint":
						p[name] = parseInt(text, 10);
						break;
					case "r4":
					case "r8":
					case "decimal":
						p[name] = parseFloat(text);
						break;
					case "filetime":
					case "date":
						p[name] = new Date(text);
						break;
					case "cy":
					case "error":
						p[name] = unescapeXml(text);
						break;
					default:
						if (type.slice(-1) === "/") break;
						if (opts?.WTF && typeof console !== "undefined") console.warn("Unexpected", tagStr, type, tokens);
				}
			}
		}
	}
	return p;
}
/**
* Serialize custom properties to OPC custom properties XML.
* Each property is wrapped in a `<property>` element with a unique pid (property ID)
* and the well-known fmtid GUID for custom properties.
* @param cp - record of property name-value pairs (may be undefined)
* @returns the complete XML string for the custom properties part
*/
function writeCustomProperties(cp) {
	const lines = [XML_HEADER, writeXmlElement("Properties", null, {
		xmlns: XMLNS.CUST_PROPS,
		"xmlns:vt": XMLNS.vt
	})];
	if (!cp) return lines.join("");
	let pid = 1;
	for (const propName of Object.keys(cp)) {
		++pid;
		lines.push(writeXmlElement("property", writeVariantType(cp[propName], true), {
			fmtid: "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}",
			pid: String(pid),
			name: escapeXml(propName)
		}));
	}
	if (lines.length > 2) {
		lines.push("</Properties>");
		lines[1] = lines[1].replace("/>", ">");
	}
	return lines.join("");
}

//#endregion
//#region src/utils/buffer.ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
* Decode a UTF-8 binary string (where each character's charCode is a byte value)
* into a proper JavaScript string.
*
* This manually implements UTF-8 decoding for strings that store raw byte values
* as character codes (common in legacy binary formats).
*
* UTF-8 byte patterns:
*   - 0xxxxxxx (0-127): single-byte ASCII
*   - 110xxxxx 10xxxxxx (192-223): two-byte sequence
*   - 1110xxxx 10xxxxxx 10xxxxxx (224-239): three-byte sequence
*   - 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx (240-247): four-byte sequence (produces surrogate pair)
*
* @param orig - Binary string with byte values as char codes
* @returns Properly decoded JavaScript string
*/
function utf8read(orig) {
	// NAYIVE: identity. Every caller feeds this the output of zipReadString, which
	// already ran the bytes through a real TextDecoder, so the string is correct
	// UTF-16 before it gets here. Decoding it a SECOND time as if each JS character
	// were one UTF-8 byte destroys any non-ASCII text: "Día" (D, U+00ED, a) is read
	// as a three-byte sequence and collapses into the lone surrogate U+D860, which
	// is not valid UTF-16 at all. Handsontable then puts that in the DOM and the
	// browser tab dies. Every accented word in a Spanish spreadsheet hit this.
	//
	// The function survives from this library's SheetJS lineage, where XML parts
	// arrived as binary strings (one character per byte) and this step was correct.
	// Kept as a no-op rather than deleted so the ten call sites stay untouched.
	return orig;
}

/** The original byte-string decoder, unused — see utf8read above. */
function utf8readBytes(orig) {
	let out = "";
	let i = 0;
	let byte1 = 0;
	let byte2 = 0;
	let byte3 = 0;
	let byte4 = 0;
	let codePoint = 0;
	while (i < orig.length) {
		byte1 = orig.charCodeAt(i++);
		if (byte1 < 128) {
			out += String.fromCharCode(byte1);
			continue;
		}
		byte2 = orig.charCodeAt(i++);
		if (byte1 > 191 && byte1 < 224) {
			codePoint = (byte1 & 31) << 6 | byte2 & 63;
			out += String.fromCharCode(codePoint);
			continue;
		}
		byte3 = orig.charCodeAt(i++);
		if (byte1 < 240) {
			out += String.fromCharCode((byte1 & 15) << 12 | (byte2 & 63) << 6 | byte3 & 63);
			continue;
		}
		byte4 = orig.charCodeAt(i++);
		codePoint = ((byte1 & 7) << 18 | (byte2 & 63) << 12 | (byte3 & 63) << 6 | byte4 & 63) - 65536;
		out += String.fromCharCode(55296 + (codePoint >>> 10 & 1023));
		out += String.fromCharCode(56320 + (codePoint & 1023));
	}
	return out;
}

//#endregion
//#region src/xlsx/shared-strings.ts
/** Parse rich-text run properties (<rPr>) into a font descriptor object */
function parseRunProperties(rpr, opts) {
	const font = {};
	const matches = rpr.match(XML_TAG_REGEX);
	let pass = false;
	if (matches) for (let i = 0; i < matches.length; ++i) {
		const parsedTag = parseXmlTag(matches[i], void 0, void 0, opts);
		switch (parsedTag[0].replace(/<\w*:/g, "<")) {
			case "<condense":
			case "<extend": break;
			case "<shadow": if (!parsedTag.val) break;
			case "<shadow>":
			case "<shadow/>":
				font.shadow = 1;
				break;
			case "</shadow>": break;
			case "<rFont":
				font.name = parsedTag.val;
				break;
			case "<sz":
				font.sz = parsedTag.val;
				break;
			case "<strike": if (!parsedTag.val) break;
			case "<strike>":
			case "<strike/>":
				font.strike = 1;
				break;
			case "</strike>": break;
			case "<u":
				if (!parsedTag.val) break;
				switch (parsedTag.val) {
					case "double":
						font.uval = "double";
						break;
					case "singleAccounting":
						font.uval = "single-accounting";
						break;
					case "doubleAccounting":
						font.uval = "double-accounting";
						break;
				}
			case "<u>":
			case "<u/>":
				font.u = 1;
				break;
			case "</u>": break;
			case "<b": if (parsedTag.val === "0") break;
			case "<b>":
			case "<b/>":
				font.b = 1;
				break;
			case "</b>": break;
			case "<i": if (parsedTag.val === "0") break;
			case "<i>":
			case "<i/>":
				font.i = 1;
				break;
			case "</i>": break;
			case "<color":
				if (parsedTag.rgb) font.color = parsedTag.rgb.slice(2, 8);
				break;
			case "<color>":
			case "<color/>":
			case "</color>": break;
			case "<family":
				font.family = parsedTag.val;
				break;
			case "<vertAlign":
				font.valign = parsedTag.val;
				break;
			case "<scheme": break;
			case "<extLst":
			case "<extLst>":
			case "</extLst>": break;
			case "<ext":
				pass = true;
				break;
			case "</ext>":
				pass = false;
				break;
			// NAYIVE: an unknown run property is IGNORED, not fatal. CT_RPrElt has
			// members this switch never listed — <charset>, <outline>, <shadow>,
			// <condense>, <extend> — and LibreOffice writes <charset>. Throwing here
			// aborted the whole shared-string table (its caller swallows the error
			// and keeps an empty one), so every piece of text in the workbook came
			// back as "" and got saved back as blank. Losing one italic flag is a
			// far smaller thing than losing every word in the file.
			default: break;
		}
	}
	return font;
}
/** Regex to match opening <r> tags (rich-text run boundaries) */
const rregex = /<(?:\w+:)?r>/g;
/** Regex to match closing </r> tags */
const rend = /<\/(?:\w+:)?r>/;
/**
* Find the first occurrence of a namespace-agnostic XML tag and return its
* full outer content and inner content as a tuple.
*/
function str_match_xml_ns_local(str, tag) {
	const re = new RegExp("<(?:\\w+:)?" + tag + "\\b[^<>]*>", "g");
	const reEnd = new RegExp("<\\/(?:\\w+:)?" + tag + ">", "g");
	const openMatch = re.exec(str);
	if (!openMatch) return null;
	const startIdx = openMatch.index;
	const contentStart = re.lastIndex;
	reEnd.lastIndex = re.lastIndex;
	const closeMatch = reEnd.exec(str);
	if (!closeMatch) return null;
	const endIdx = closeMatch.index;
	const contentEnd = reEnd.lastIndex;
	return [str.slice(startIdx, contentEnd), str.slice(contentStart, endIdx)];
}
/**
* Remove all occurrences of a namespace-agnostic XML element (including content)
* from the string. Used to strip <rPh> (phonetic run) elements.
*/
function str_remove_xml_ns_g_local(str, tag) {
	const re = new RegExp("<(?:\\w+:)?" + tag + "\\b[^<>]*>", "g");
	const reEnd = new RegExp("<\\/(?:\\w+:)?" + tag + ">", "g");
	const out = [];
	let lastEnd = 0;
	let openMatch;
	while (openMatch = re.exec(str)) {
		out.push(str.slice(lastEnd, openMatch.index));
		reEnd.lastIndex = re.lastIndex;
		if (!reEnd.exec(str)) break;
		lastEnd = reEnd.lastIndex;
		re.lastIndex = reEnd.lastIndex;
	}
	out.push(str.slice(lastEnd));
	return out.join("");
}
/** Parse a single rich-text run (<r>) element, extracting text and optional style */
function parseRichTextRun(r, opts) {
	const textMatch = str_match_xml_ns_local(r, "t");
	if (!textMatch) return {
		t: "s",
		v: ""
	};
	const runObj = {
		t: "s",
		v: unescapeXml(textMatch[1])
	};
	const rpr = str_match_xml_ns_local(r, "rPr");
	if (rpr) runObj.s = parseRunProperties(rpr[1], opts);
	return runObj;
}
/** Split rich-text XML into individual runs and parse each one */
function parseRichTextRuns(rs, opts) {
	return rs.replace(rregex, "").split(rend).map((r) => parseRichTextRun(r, opts)).filter((r) => r.v);
}
/** Convert an array of parsed rich-text runs into an HTML string */
function richTextToHtml(rs) {
	const nlregex = /(\r\n|\n)/g;
	return rs.map((r) => {
		if (!r.v) return "";
		const intro = [];
		const outro = [];
		if (r.s) {
			const font = r.s;
			const style = [];
			if (font.u) style.push("text-decoration: underline;");
			if (font.uval) style.push("text-underline-style:" + font.uval + ";");
			if (font.sz) style.push("font-size:" + font.sz + "pt;");
			if (font.outline) style.push("text-effect: outline;");
			if (font.shadow) style.push("text-shadow: auto;");
			intro.push("<span style=\"" + style.join("") + "\">");
			if (font.b) {
				intro.push("<b>");
				outro.push("</b>");
			}
			if (font.i) {
				intro.push("<i>");
				outro.push("</i>");
			}
			if (font.strike) {
				intro.push("<s>");
				outro.push("</s>");
			}
			let align = font.valign || "";
			if (align === "superscript" || align === "super") align = "sup";
			else if (align === "subscript") align = "sub";
			if (align !== "") {
				intro.push("<" + align + ">");
				outro.push("</" + align + ">");
			}
			outro.push("</span>");
		}
		return intro.join("") + r.v.replace(nlregex, "<br/>") + outro.join("");
	}).join("");
}
/** Regex to extract text from <t> elements */
const sitregex = /<(?:\w+:)?t\b[^<>]*>([^<]*)<\/(?:\w+:)?t>/g;
/** Regex to detect if a string item contains rich-text runs (<r>) */
const sirregex = /<(?:\w+:)?r\b[^<>]*>/;
/**
* Parse a single string item (<si>) from the shared string table.
* Handles both plain text (<t>) and rich text (<r>) formats.
*/
function parseStringItem(x, opts) {
	const html = opts ? opts.cellHTML !== false : true;
	const result = {};
	if (!x) return { t: "" };
	if (x.match(/^\s*<(?:\w+:)?t[^>]*>/)) {
		result.t = unescapeXml(utf8read(x.slice(x.indexOf(">") + 1).split(/<\/(?:\w+:)?t>/)[0] || ""), true);
		result.r = utf8read(x);
		if (html) result.h = escapeHtml(result.t);
	} else if (x.match(sirregex)) {
		result.r = utf8read(x);
		const stripped = str_remove_xml_ns_g_local(x, "rPh");
		sitregex.lastIndex = 0;
		result.t = unescapeXml(utf8read((stripped.match(sitregex) || []).join("").replace(XML_TAG_REGEX, "")), true);
		if (html) result.h = richTextToHtml(parseRichTextRuns(result.r, opts));
	}
	return result;
}
/** Regex to match opening <si> or <sstItem> tags */
const sstr1 = /<(?:\w+:)?(?:si|sstItem)>/g;
/** Regex to match closing </si> or </sstItem> tags */
const sstr2 = /<\/(?:\w+:)?(?:si|sstItem)>/;
/**
* Parse the Shared String Table (SST) XML into an array of string entries.
*
* The SST is a deduplicated table of all string values used across the workbook.
* Each cell with type "s" references an index into this table.
*
* @param data - Raw XML string of sharedStrings.xml
* @param opts - Options controlling HTML generation (cellHTML)
* @returns Array of parsed string entries with Count and Unique metadata
*/
function parseSstXml(data, opts) {
	const strings = [];
	if (!data) return strings;
	assertXmlPartLimits("sharedStrings.xml", data, opts);
	const sst = str_match_xml_ns_local(data, "sst");
	if (sst) {
		const stringItems = sst[1].replace(sstr1, "").split(sstr2);
		const maxSharedStringItems = xmlOptionLimit(opts?.maxSharedStringItems, DEFAULT_MAX_SHARED_STRING_ITEMS, "maxSharedStringItems");
		assertXmlCountWithinLimit("shared string item", stringItems.length, maxSharedStringItems);
		for (let i = 0; i < stringItems.length; ++i) {
			// NAYIVE: per item, so one entry this parser cannot read costs that one
			// string instead of the entire table. The indexes must keep lining up
			// with the <v> values in the sheets, so a failure still takes a slot.
			let parsedItem;
			try { parsedItem = parseStringItem(stringItems[i].trim(), opts); }
			catch (e) { parsedItem = { t: "" }; }
			if (parsedItem != null) strings[strings.length] = parsedItem;
		}
		const tag = parseXmlTag(sst[0].slice(0, sst[0].indexOf(">")), void 0, void 0, opts);
		strings.Count = tag.count;
		strings.Unique = tag.uniquecount;
	}
	return strings;
}
/** Matches strings with leading/trailing whitespace or internal whitespace chars that need xml:space="preserve" */
const straywsregex = /^\s|\s$|[\t\n\r]/;
/**
* Write the Shared String Table (SST) as XML.
*
* @param sst - Array of string entries to serialize
* @param opts - Options; bookSST must be true to produce output
* @returns Complete sharedStrings.xml string, or empty string if bookSST is false
*/
function writeSstXml(sst, opts) {
	if (!opts.bookSST) return "";
	const lines = [XML_HEADER];
	lines.push(writeXmlElement("sst", null, {
		xmlns: XMLNS_main[0],
		count: String(sst.Count),
		uniqueCount: String(sst.Unique)
	}));
	for (let i = 0; i !== sst.length; ++i) {
		if (sst[i] == null) continue;
		const entry = sst[i];
		let sitag = "<si>";
		if (entry.r) sitag += entry.r;
		else {
			sitag += "<t";
			if (!entry.t) entry.t = "";
			if (typeof entry.t !== "string") entry.t = String(entry.t);
			if (entry.t.match(straywsregex)) sitag += " xml:space=\"preserve\"";
			sitag += ">" + escapeXml(entry.t) + "</t>";
		}
		sitag += "</si>";
		lines.push(sitag);
	}
	if (lines.length > 2) {
		lines.push("</sst>");
		lines[1] = lines[1].replace("/>", ">");
	}
	return lines.join("");
}

//#endregion
//#region src/ssf/table.ts
/**
* Initialize the built-in Excel number format table.
*
* Populates the standard format IDs (0-49 plus 56) defined in ECMA-376.
* Format IDs 5-8 and 23-36 are locale-dependent and intentionally omitted
* from the base table (they are mapped via {@link DEFAULT_FORMAT_MAP}).
*
* @param t - Optional existing table to populate; a new object is created if omitted
* @returns The populated format table
*/
function initFormatTable(t) {
	if (!t) t = {};
	t[0] = "General";
	t[1] = "0";
	t[2] = "0.00";
	t[3] = "#,##0";
	t[4] = "#,##0.00";
	t[9] = "0%";
	t[10] = "0.00%";
	t[11] = "0.00E+00";
	t[12] = "# ?/?";
	t[13] = "# ??/??";
	t[14] = "m/d/yy";
	t[15] = "d-mmm-yy";
	t[16] = "d-mmm";
	t[17] = "mmm-yy";
	t[18] = "h:mm AM/PM";
	t[19] = "h:mm:ss AM/PM";
	t[20] = "h:mm";
	t[21] = "h:mm:ss";
	t[22] = "m/d/yy h:mm";
	t[37] = "#,##0 ;(#,##0)";
	t[38] = "#,##0 ;[Red](#,##0)";
	t[39] = "#,##0.00;(#,##0.00)";
	t[40] = "#,##0.00;[Red](#,##0.00)";
	t[45] = "mm:ss";
	t[46] = "[h]:mm:ss";
	t[47] = "mmss.0";
	t[48] = "##0.0E+0";
	t[49] = "@";
	t[56] = "\"上午/下午 \"hh\"時\"mm\"分\"ss\"秒 \"";
	return t;
}
/** Default number format table, initialized with standard Excel formats */
let formatTable = initFormatTable();
/**
* Mapping from locale-dependent format IDs to their base-table equivalents.
*
* When a format ID is not found in the main table, this map provides a fallback
* by redirecting to a standard format ID. For example, format 27 (a locale-specific
* date format) falls back to format 14 ("m/d/yy").
*
* Defaults were determined by systematically testing in Excel 2019.
*/
const DEFAULT_FORMAT_MAP = {
	5: 37,
	6: 38,
	7: 39,
	8: 40,
	23: 0,
	24: 0,
	25: 0,
	26: 0,
	27: 14,
	28: 14,
	29: 14,
	30: 14,
	31: 14,
	50: 14,
	51: 14,
	52: 14,
	53: 14,
	54: 14,
	55: 14,
	56: 14,
	57: 14,
	58: 14,
	59: 1,
	60: 2,
	61: 3,
	62: 4,
	67: 9,
	68: 10,
	69: 12,
	70: 13,
	71: 14,
	72: 14,
	73: 15,
	74: 16,
	75: 17,
	76: 20,
	77: 21,
	78: 22,
	79: 45,
	80: 46,
	81: 47,
	82: 0
};
/**
* Accounting format strings for IDs that have no direct equivalent in the base table.
*
* These use literal "$" currency symbols and special alignment characters
* (_  for padding, \( and \) for literal parentheses).
*/
const DEFAULT_FORMAT_STRINGS = {
	5: "\"$\"#,##0_);\\(\"$\"#,##0\\)",
	63: "\"$\"#,##0_);\\(\"$\"#,##0\\)",
	6: "\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",
	64: "\"$\"#,##0_);[Red]\\(\"$\"#,##0\\)",
	7: "\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",
	65: "\"$\"#,##0.00_);\\(\"$\"#,##0.00\\)",
	8: "\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",
	66: "\"$\"#,##0.00_);[Red]\\(\"$\"#,##0.00\\)",
	41: "_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)",
	42: "_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",
	43: "_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)",
	44: "_(\"$\"* #,##0.00_);_(\"$\"* \\(#,##0.00\\);_(\"$\"* \"-\"??_);_(@_)"
};
/**
* Register a custom number format string in the format table.
*
* If no index is provided, searches for an existing match or the first empty slot
* in the valid range (0-0x0187). If no slot is found, uses 0x0187 as a last resort.
*
* @param fmt - The format string to register (e.g. "#,##0.00")
* @param idx - Optional explicit format index to assign
* @returns The format index where the string was registered
*/
function loadFormat(fmt, idx) {
	if (typeof idx !== "number") {
		idx = Number(idx) || -1;
		for (let i = 0; i < 392; ++i) {
			if (formatTable[i] === void 0) {
				if (idx < 0) idx = i;
				continue;
			}
			if (formatTable[i] === fmt) {
				idx = i;
				break;
			}
		}
		if (idx < 0) idx = 391;
	}
	formatTable[idx] = fmt;
	return idx;
}
/**
* Bulk-load a table of number format strings, overwriting existing entries.
* @param tbl - Map of format index to format string
*/
function loadFormatTable(tbl) {
	for (let i = 0; i < 392; ++i) if (tbl[i] !== void 0) loadFormat(tbl[i], i);
}
/**
* Reset the format table back to the built-in Excel defaults.
*
* Called before read/write operations to ensure a clean state.
*/
function resetFormatTable() {
	formatTable = initFormatTable();
}

//#endregion
//#region src/xlsx/styles.ts
const DEFAULT_FONT = {
	name: "Calibri",
	size: 11
};
const DEFAULT_FILL = {};
const GRAY125_FILL = { patternType: "solid" };
const DEFAULT_BORDER = {};
function styleKey(value) {
	if (value == null) return "";
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(styleKey).join(",") + "]";
	const record = value;
	return "{" + Object.keys(record).sort().filter((key) => record[key] !== void 0).map((key) => JSON.stringify(key) + ":" + styleKey(record[key])).join(",") + "}";
}
function normalizeColor(color, opts) {
	const raw = color?.argb || color?.rgb;
	if (!raw) return;
	const normalized = raw.replace(/^#/, "").toUpperCase();
	let rgb = "";
	if (/^[0-9A-F]{6}$/.test(normalized)) rgb = "FF" + normalized;
	else if (/^[0-9A-F]{8}$/.test(normalized)) rgb = normalized;
	else {
		if (opts?.WTF) throw new XlsxError("UNSUPPORTED", "Unsupported style color: " + raw);
		return;
	}
	return { rgb };
}
function normalizeFont(font, opts) {
	if (!font) return;
	const out = {};
	if (font.name) out.name = font.name;
	if (typeof font.size === "number") out.size = font.size;
	if (font.bold) out.bold = true;
	if (font.italic) out.italic = true;
	if (font.underline) out.underline = true;
	const color = normalizeColor(font.color, opts);
	if (color) out.color = color;
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeFill(fill, opts) {
	if (!fill) return;
	if (fill.patternType && fill.patternType !== "solid") {
		if (opts?.WTF) throw new XlsxError("UNSUPPORTED", "Unsupported fill pattern: " + fill.patternType);
		return;
	}
	const color = normalizeColor(fill.fgColor, opts);
	if (!color) return;
	return {
		patternType: "solid",
		fgColor: color
	};
}
function normalizeBorder(border, opts) {
	if (!border) return;
	const out = {};
	for (const side of [
		"top",
		"right",
		"bottom",
		"left"
	]) {
		const input = border[side];
		if (!input) continue;
		if (input.style !== "thin" && input.style !== "medium") {
			if (opts?.WTF) throw new XlsxError("UNSUPPORTED", "Unsupported border style: " + input.style);
			continue;
		}
		const color = normalizeColor(input.color, opts);
		out[side] = color ? {
			style: input.style,
			color
		} : { style: input.style };
	}
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeAlignment(alignment, opts) {
	if (!alignment) return;
	const out = {};
	if (alignment.horizontal === "left" || alignment.horizontal === "center" || alignment.horizontal === "right") out.horizontal = alignment.horizontal;
	else if (alignment.horizontal && opts?.WTF) throw new XlsxError("UNSUPPORTED", "Unsupported horizontal alignment: " + alignment.horizontal);
	if (alignment.vertical === "top" || alignment.vertical === "middle" || alignment.vertical === "bottom") out.vertical = alignment.vertical;
	else if (alignment.vertical && opts?.WTF) throw new XlsxError("UNSUPPORTED", "Unsupported vertical alignment: " + alignment.vertical);
	if (alignment.wrapText) out.wrapText = true;
	return Object.keys(out).length > 0 ? out : void 0;
}
function normalizeCellStyle(cell, opts) {
	const style = cell.s;
	const out = {};
	if (style) {
		out.font = normalizeFont(style.font, opts);
		out.fill = normalizeFill(style.fill, opts);
		out.border = normalizeBorder(style.border, opts);
		out.alignment = normalizeAlignment(style.alignment, opts);
		if (style.numFmt != null) out.numFmt = style.numFmt;
	}
	if (out.numFmt == null && cell.z != null) out.numFmt = cell.z;
	return Object.keys(out).some((key) => out[key] !== void 0) ? out : void 0;
}
function getOrAdd(items, seen, value) {
	const key = styleKey(value);
	const existing = seen.get(key);
	if (existing != null) return existing;
	const id = items.length;
	items.push(value);
	seen.set(key, id);
	return id;
}
function getBuiltinNumFmtId(format) {
	for (const key of Object.keys(formatTable)) if (formatTable[+key] === format) return +key;
}
function getNumFmtId(numFmt, customNumFmts, numFmts) {
	if (numFmt == null) return 0;
	if (typeof numFmt === "number") return numFmt;
	const builtin = getBuiltinNumFmtId(numFmt);
	if (builtin != null) return builtin;
	const existing = customNumFmts.get(numFmt);
	if (existing != null) return existing;
	let id = 164;
	while (numFmts.has(id) || formatTable[id]) id++;
	customNumFmts.set(numFmt, id);
	numFmts.set(id, numFmt);
	return id;
}
function eachWorksheetCell(ws, callback) {
	if (ws["!data"]) {
		for (const row of ws["!data"]) {
			if (!row) continue;
			for (const cell of row) if (cell) callback(cell);
		}
		return;
	}
	for (const key of Object.keys(ws)) {
		if (key.charAt(0) === "!") continue;
		const cell = ws[key];
		if (cell) callback(cell);
	}
}
function buildStyleRegistry(wb, opts) {
	const registry = {
		cellStyleIds: /* @__PURE__ */ new WeakMap(),
		numFmts: /* @__PURE__ */ new Map(),
		fonts: [DEFAULT_FONT],
		fills: [DEFAULT_FILL, GRAY125_FILL],
		borders: [DEFAULT_BORDER],
		cellXfs: [{
			numFmtId: 0,
			fontId: 0,
			fillId: 0,
			borderId: 0
		}],
		hasStyles: false
	};
	const fontIds = /* @__PURE__ */ new Map([[styleKey(DEFAULT_FONT), 0]]);
	const fillIds = /* @__PURE__ */ new Map([[styleKey(DEFAULT_FILL), 0], [styleKey(GRAY125_FILL), 1]]);
	const borderIds = /* @__PURE__ */ new Map([[styleKey(DEFAULT_BORDER), 0]]);
	const xfIds = /* @__PURE__ */ new Map([[styleKey(registry.cellXfs[0]), 0]]);
	const customNumFmts = /* @__PURE__ */ new Map();
	for (const sheetName of wb.SheetNames) {
		const ws = wb.Sheets[sheetName];
		if (!ws) continue;
		eachWorksheetCell(ws, (cell) => {
			const normalized = normalizeCellStyle(cell, opts);
			if (!normalized) return;
			const fontId = normalized.font ? getOrAdd(registry.fonts, fontIds, normalized.font) : 0;
			const fillId = normalized.fill ? getOrAdd(registry.fills, fillIds, normalized.fill) : 0;
			const borderId = normalized.border ? getOrAdd(registry.borders, borderIds, normalized.border) : 0;
			const numFmtId = getNumFmtId(normalized.numFmt, customNumFmts, registry.numFmts);
			const xf = {
				numFmtId,
				fontId,
				fillId,
				borderId
			};
			if (numFmtId !== 0) xf.applyNumberFormat = true;
			if (fontId !== 0) xf.applyFont = true;
			if (fillId !== 0) xf.applyFill = true;
			if (borderId !== 0) xf.applyBorder = true;
			if (normalized.alignment) {
				xf.alignment = normalized.alignment;
				xf.applyAlignment = true;
			}
			const styleId = getOrAdd(registry.cellXfs, xfIds, xf);
			registry.cellStyleIds.set(cell, styleId);
			if (styleId !== 0) registry.hasStyles = true;
		});
	}
	return registry;
}
function getCellStyleIndex(opts, cell) {
	return opts?.styleRegistry?.cellStyleIds?.get(cell);
}
/**
* Parse <numFmts> section, registering custom number formats into the styles object
* and the global SSF format table.
*/
function parseNumberFormats(t, styles, _opts) {
	const matches = t.match(XML_TAG_REGEX);
	if (!matches) return;
	for (let i = 0; i < matches.length; ++i) {
		const parsedTag = parseXmlTag(matches[i]);
		switch (stripTagNamespace(parsedTag[0])) {
			case "<numFmt": {
				const formatCode = unescapeXml(parsedTag.formatCode);
				const fmtId = parseInt(parsedTag.numFmtId, 10);
				styles.NumberFmt[fmtId] = formatCode;
				if (fmtId > 0) {
					if (fmtId > 392) {}
					loadFormat(formatCode, fmtId);
				}
				break;
			}
		}
	}
}
function parseColor(tag) {
	if (tag.rgb) return { rgb: String(tag.rgb).toUpperCase() };
}
function parseFonts(t, styles) {
	const fonts = t.match(/<(?:\w+:)?font\b[^>]*>[\s\S]*?<\/(?:\w+:)?font>|<(?:\w+:)?font\b[^>]*\/>/g);
	if (!fonts) return;
	for (const fontXml of fonts) {
		const font = {};
		const name = fontXml.match(/<(?:\w+:)?name\b[^>]*\/>/);
		if (name) {
			const tag = parseXmlTag(name[0]);
			if (tag.val) font.name = tag.val;
		}
		const size = fontXml.match(/<(?:\w+:)?sz\b[^>]*\/>/);
		if (size) {
			const tag = parseXmlTag(size[0]);
			if (tag.val) font.size = parseFloat(tag.val);
		}
		if (/<(?:\w+:)?b\b[^>]*\/>/.test(fontXml)) font.bold = true;
		if (/<(?:\w+:)?i\b[^>]*\/>/.test(fontXml)) font.italic = true;
		if (/<(?:\w+:)?u\b[^>]*\/>/.test(fontXml)) font.underline = true;
		const color = fontXml.match(/<(?:\w+:)?color\b[^>]*\/>/);
		if (color) {
			const parsed = parseColor(parseXmlTag(color[0]));
			if (parsed) font.color = parsed;
		}
		styles.Fonts.push(font);
	}
}
function parseFills(t, styles) {
	const fills = t.match(/<(?:\w+:)?fill\b[^>]*>[\s\S]*?<\/(?:\w+:)?fill>|<(?:\w+:)?fill\b[^>]*\/>/g);
	if (!fills) return;
	for (const fillXml of fills) {
		const pattern = fillXml.match(/<(?:\w+:)?patternFill\b[^>]*>/);
		const fill = {};
		if (pattern) {
			if (parseXmlTag(pattern[0]).patternType === "solid") {
				fill.patternType = "solid";
				const fg = fillXml.match(/<(?:\w+:)?fgColor\b[^>]*\/>/);
				if (fg) {
					const parsed = parseColor(parseXmlTag(fg[0]));
					if (parsed) fill.fgColor = parsed;
				}
			}
		}
		styles.Fills.push(fill);
	}
}
function parseBorderSide(borderXml, side) {
	const match = borderXml.match(new RegExp("<(?:\\w+:)?" + side + "\\b[^>]*(?:/>|>[\\s\\S]*?</(?:\\w+:)?" + side + ">)"));
	if (!match) return;
	const open = match[0].match(/<[^>]*>/);
	if (!open) return;
	const tag = parseXmlTag(open[0]);
	if (tag.style !== "thin" && tag.style !== "medium") return;
	const color = match[0].match(/<(?:\w+:)?color\b[^>]*\/>/);
	const parsedColor = color ? parseColor(parseXmlTag(color[0])) : void 0;
	return parsedColor ? {
		style: tag.style,
		color: parsedColor
	} : { style: tag.style };
}
function parseBorders(t, styles) {
	const borders = t.match(/<(?:\w+:)?border\b[^>]*>[\s\S]*?<\/(?:\w+:)?border>|<(?:\w+:)?border\b[^>]*\/>/g);
	if (!borders) return;
	for (const borderXml of borders) {
		const border = {};
		for (const side of [
			"top",
			"right",
			"bottom",
			"left"
		]) {
			const parsed = parseBorderSide(borderXml, side);
			if (parsed) border[side] = parsed;
		}
		styles.Borders.push(border);
	}
}
/**
* Parse <cellXfs> section, extracting cell format entries that map style indices
* to number format, font, fill, and border IDs.
*/
function parseCellFormats(t, styles) {
	const matches = t.match(XML_TAG_REGEX);
	if (!matches) return;
	let xf = null;
	for (let i = 0; i < matches.length; ++i) {
		const parsedTag = parseXmlTag(matches[i]);
		switch (stripTagNamespace(parsedTag[0])) {
			case "<xf":
				xf = {
					numFmtId: parseInt(parsedTag.numFmtId, 10) || 0,
					fontId: parseInt(parsedTag.fontId, 10) || 0,
					fillId: parseInt(parsedTag.fillId, 10) || 0,
					borderId: parseInt(parsedTag.borderId, 10) || 0,
					xfId: parseInt(parsedTag.xfId, 10) || 0
				};
				if (parsedTag.applyNumberFormat) xf.applyNumberFormat = parsedTag.applyNumberFormat === "1";
				if (parsedTag.applyFont) xf.applyFont = parsedTag.applyFont === "1";
				if (parsedTag.applyFill) xf.applyFill = parsedTag.applyFill === "1";
				if (parsedTag.applyBorder) xf.applyBorder = parsedTag.applyBorder === "1";
				if (parsedTag.applyAlignment) xf.applyAlignment = parsedTag.applyAlignment === "1";
				styles.CellXf.push(xf);
				break;
			case "<alignment":
				if (xf) {
					const alignment = {};
					if (parsedTag.horizontal === "left" || parsedTag.horizontal === "center" || parsedTag.horizontal === "right") alignment.horizontal = parsedTag.horizontal;
					if (parsedTag.vertical === "top" || parsedTag.vertical === "center" || parsedTag.vertical === "bottom") alignment.vertical = parsedTag.vertical === "center" ? "middle" : parsedTag.vertical;
					if (parsedTag.wrapText === "1") alignment.wrapText = true;
					if (Object.keys(alignment).length > 0) xf.alignment = alignment;
				}
				break;
		}
	}
}
function getStyleFromXf(styles, styleIndex) {
	const xf = styles.CellXf[styleIndex];
	if (!xf) return;
	const style = {};
	const font = styles.Fonts[xf.fontId || 0];
	if (font && Object.keys(font).length > 0) style.font = font;
	const fill = styles.Fills[xf.fillId || 0];
	if (fill && fill.patternType === "solid" && fill.fgColor) style.fill = fill;
	const border = styles.Borders[xf.borderId || 0];
	if (border && Object.keys(border).length > 0) style.border = border;
	if (xf.alignment) style.alignment = xf.alignment;
	if (xf.numFmtId) style.numFmt = styles.NumberFmt[xf.numFmtId] || formatTable[xf.numFmtId] || xf.numFmtId;
	return Object.keys(style).length > 0 ? style : void 0;
}
/** Strip XML namespace prefix from a tag name (e.g. "<x:numFmt" -> "<numFmt") */
function stripTagNamespace(tag) {
	return tag.replace(/<\w+:/, "<");
}
/**
* Parse a styles.xml file into a StylesData structure.
*
* Extracts custom number formats and cell format (xf) entries. Fonts, fills,
* and borders arrays are initialized but not fully parsed in this implementation.
*
* @param data - Raw XML string of the styles.xml file
* @param _themes - Parsed theme data (reserved for theme-based color resolution)
* @param opts - Parsing options
* @returns Parsed style data containing number formats and cell format entries
*/
function parseStylesXml(data, _themes, opts) {
	const styles = {
		NumberFmt: {},
		CellXf: [],
		Fonts: [],
		Fills: [],
		Borders: []
	};
	if (!data) return styles;
	const numFmts = data.match(/<(?:\w+:)?numFmts[^>]*>([\s\S]*?)<\/(?:\w+:)?numFmts>/);
	if (numFmts) parseNumberFormats(numFmts[1], styles, opts);
	const fonts = data.match(/<(?:\w+:)?fonts[^>]*>([\s\S]*?)<\/(?:\w+:)?fonts>/);
	if (fonts) parseFonts(fonts[1], styles);
	const fills = data.match(/<(?:\w+:)?fills[^>]*>([\s\S]*?)<\/(?:\w+:)?fills>/);
	if (fills) parseFills(fills[1], styles);
	const borders = data.match(/<(?:\w+:)?borders[^>]*>([\s\S]*?)<\/(?:\w+:)?borders>/);
	if (borders) parseBorders(borders[1], styles);
	const cellXfs = data.match(/<(?:\w+:)?cellXfs[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/);
	if (cellXfs) parseCellFormats(cellXfs[1], styles);
	return styles;
}
/**
* Write a minimal styles.xml with default formatting.
*
* Produces a stylesheet with one "General" number format, one Calibri font,
* two standard fills (none + gray125), one empty border, and two cell formats.
* This is the minimum required for a valid XLSX file.
*
* @param _wb - WorkBook (reserved for future style extraction)
* @param _opts - Write options
* @returns Complete styles.xml string
*/
function writeStylesXml(_wb, _opts) {
	const lines = [XML_HEADER];
	const registry = _opts?.styleRegistry;
	lines.push(writeXmlElement("styleSheet", null, {
		xmlns: XMLNS_main[0],
		"xmlns:vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
	}));
	const numFmts = registry?.numFmts || /* @__PURE__ */ new Map();
	if (numFmts.size > 0) lines.push("<numFmts count=\"" + numFmts.size + "\">" + Array.from(numFmts.entries()).sort((a, b) => a[0] - b[0]).map(([id, code]) => "<numFmt numFmtId=\"" + id + "\" formatCode=\"" + escapeXml(code) + "\"/>").join("") + "</numFmts>");
	const fonts = registry?.fonts || [DEFAULT_FONT];
	lines.push("<fonts count=\"" + fonts.length + "\">" + fonts.map(writeFont).join("") + "</fonts>");
	const fills = registry?.fills || [DEFAULT_FILL, GRAY125_FILL];
	lines.push("<fills count=\"" + fills.length + "\">" + fills.map(writeFill).join("") + "</fills>");
	const borders = registry?.borders || [DEFAULT_BORDER];
	lines.push("<borders count=\"" + borders.length + "\">" + borders.map(writeBorder).join("") + "</borders>");
	lines.push("<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>");
	const cellXfs = registry?.cellXfs || [{
		numFmtId: 0,
		fontId: 0,
		fillId: 0,
		borderId: 0
	}, {
		numFmtId: 0,
		fontId: 0,
		fillId: 0,
		borderId: 0
	}];
	lines.push("<cellXfs count=\"" + cellXfs.length + "\">" + cellXfs.map(writeCellXf).join("") + "</cellXfs>");
	lines.push("<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles>");
	lines.push("</styleSheet>");
	lines[1] = lines[1].replace("/>", ">");
	return lines.join("");
}
function writeFont(font) {
	const parts = [];
	parts.push("<sz val=\"" + (font.size || 11) + "\"/>");
	if (font.color?.rgb) parts.push("<color rgb=\"" + font.color.rgb + "\"/>");
	else parts.push("<color theme=\"1\"/>");
	parts.push("<name val=\"" + escapeXml(font.name || "Calibri") + "\"/>");
	parts.push("<family val=\"2\"/>");
	if (font.bold) parts.push("<b/>");
	if (font.italic) parts.push("<i/>");
	if (font.underline) parts.push("<u/>");
	return "<font>" + parts.join("") + "</font>";
}
function writeFill(fill) {
	if (fill.patternType === "solid" && fill.fgColor?.rgb) return "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"" + fill.fgColor.rgb + "\"/><bgColor indexed=\"64\"/></patternFill></fill>";
	if (fill.patternType === "solid") return "<fill><patternFill patternType=\"gray125\"/></fill>";
	return "<fill><patternFill patternType=\"none\"/></fill>";
}
function writeBorder(border) {
	return "<border>" + [
		"left",
		"right",
		"top",
		"bottom"
	].map((side) => writeBorderSide(side, border[side])).join("") + "<diagonal/></border>";
}
function writeBorderSide(side, border) {
	if (!border) return "<" + side + "/>";
	const color = border.color?.rgb ? "<color rgb=\"" + border.color.rgb + "\"/>" : "";
	return "<" + side + " style=\"" + border.style + "\">" + color + "</" + side + ">";
}
function writeCellXf(xf) {
	const attrs = {
		numFmtId: String(xf.numFmtId),
		fontId: String(xf.fontId),
		fillId: String(xf.fillId),
		borderId: String(xf.borderId),
		xfId: "0"
	};
	if (xf.applyNumberFormat) attrs.applyNumberFormat = "1";
	if (xf.applyFont) attrs.applyFont = "1";
	if (xf.applyFill) attrs.applyFill = "1";
	if (xf.applyBorder) attrs.applyBorder = "1";
	if (xf.applyAlignment) attrs.applyAlignment = "1";
	if (!xf.alignment) return writeXmlElement("xf", null, attrs);
	const alignmentAttrs = {};
	if (xf.alignment.horizontal) alignmentAttrs.horizontal = xf.alignment.horizontal;
	if (xf.alignment.vertical) alignmentAttrs.vertical = xf.alignment.vertical === "middle" ? "center" : xf.alignment.vertical;
	if (xf.alignment.wrapText) alignmentAttrs.wrapText = "1";
	return writeXmlElement("xf", writeXmlElement("alignment", null, alignmentAttrs), attrs);
}

//#endregion
//#region src/xlsx/theme.ts
/**
* Parse a theme XML file, extracting the color scheme.
*
* The color scheme defines the 12 standard theme colors used by Excel:
* dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink. Colors are extracted
* from either <a:sysClr> (system colors with lastClr) or <a:srgbClr> elements.
*
* @param data - Raw XML string of the theme file (e.g. theme1.xml)
* @returns Parsed theme data with color scheme array
*/
function parse_theme_xml(data) {
	const theme = { themeElements: { clrScheme: [] } };
	const colors = [];
	const clrMatch = data.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
	if (clrMatch) {
		const valRegex = /<a:(?:sysClr|srgbClr)[^>]*(?:val|lastClr)="([0-9A-Fa-f]{6})"/g;
		let m;
		while (m = valRegex.exec(clrMatch[1])) colors.push(m[1]);
	}
	theme.themeElements.clrScheme = colors;
	return theme;
}
/**
* Write a default XLSX theme XML based on the Office default theme.
*
* Includes the standard Office color scheme, Calibri/Calibri Light fonts,
* and minimal format/fill/line/effect style definitions.
*
* @returns Complete theme1.xml string
*/
function write_theme_xml() {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}

//#endregion
//#region src/xlsx/workbook.ts
/** Default values and types for workbook properties (workbookPr) */
const WBPropsDef = [
	[
		"allowRefreshQuery",
		false,
		"bool"
	],
	[
		"autoCompressPictures",
		true,
		"bool"
	],
	[
		"backupFile",
		false,
		"bool"
	],
	[
		"checkCompatibility",
		false,
		"bool"
	],
	["CodeName", ""],
	[
		"date1904",
		false,
		"bool"
	],
	[
		"defaultThemeVersion",
		0,
		"int"
	],
	[
		"filterPrivacy",
		false,
		"bool"
	],
	[
		"hidePivotFieldList",
		false,
		"bool"
	],
	[
		"promptedSolutions",
		false,
		"bool"
	],
	[
		"publishItems",
		false,
		"bool"
	],
	[
		"refreshAllConnections",
		false,
		"bool"
	],
	[
		"saveExternalLinkValues",
		true,
		"bool"
	],
	[
		"showBorderUnselectedTables",
		true,
		"bool"
	],
	[
		"showInkAnnotation",
		true,
		"bool"
	],
	["showObjects", "all"],
	[
		"showPivotChartFilter",
		false,
		"bool"
	],
	["updateLinks", "userSet"]
];
/** Default values and types for workbook view properties (workbookView) */
const WBViewDef = [
	[
		"activeTab",
		0,
		"int"
	],
	[
		"autoFilterDateGrouping",
		true,
		"bool"
	],
	[
		"firstSheet",
		0,
		"int"
	],
	[
		"minimized",
		false,
		"bool"
	],
	[
		"showHorizontalScroll",
		true,
		"bool"
	],
	[
		"showSheetTabs",
		true,
		"bool"
	],
	[
		"showVerticalScroll",
		true,
		"bool"
	],
	[
		"tabRatio",
		600,
		"int"
	],
	["visibility", "visible"]
];
/** Default values for sheet entries (currently empty, extensible) */
const SheetDef = [];
/** Default values and types for calculation properties (calcPr) */
const CalcPrDef = [
	["calcCompleted", "true"],
	["calcMode", "auto"],
	["calcOnSave", "true"],
	["concurrentCalc", "true"],
	["fullCalcOnLoad", "false"],
	["fullPrecision", "true"],
	["iterate", "false"],
	["iterateCount", "100"],
	["iterateDelta", "0.001"],
	["refMode", "A1"]
];
/**
* Apply default values to each entry in an array of objects.
* Coerces string values to bool/int based on the type hint in the defaults definition.
*/
function applyDefaultsToArray(target, defaults) {
	for (let j = 0; j < target.length; ++j) {
		const entry = target[j];
		for (let i = 0; i < defaults.length; ++i) {
			const defaultDef = defaults[i];
			if (entry[defaultDef[0]] == null) entry[defaultDef[0]] = defaultDef[1];
			else switch (defaultDef[2]) {
				case "bool":
					if (typeof entry[defaultDef[0]] === "string") entry[defaultDef[0]] = parseXmlBoolean(entry[defaultDef[0]]);
					break;
				case "int":
					if (typeof entry[defaultDef[0]] === "string") entry[defaultDef[0]] = parseInt(entry[defaultDef[0]], 10);
					break;
			}
		}
	}
}
/**
* Apply default values to a single object.
* Coerces string values to bool/int based on the type hint in the defaults definition.
*/
function applyDefaults(target, defaults) {
	for (let i = 0; i < defaults.length; ++i) {
		const defaultDef = defaults[i];
		if (target[defaultDef[0]] == null) target[defaultDef[0]] = defaultDef[1];
		else switch (defaultDef[2]) {
			case "bool":
				if (typeof target[defaultDef[0]] === "string") target[defaultDef[0]] = parseXmlBoolean(target[defaultDef[0]]);
				break;
			case "int":
				if (typeof target[defaultDef[0]] === "string") target[defaultDef[0]] = parseInt(target[defaultDef[0]], 10);
				break;
		}
	}
}
/**
* Apply default values to all sections of a parsed workbook file.
*
* @param wb - Parsed workbook file to fill with defaults
*/
function parse_wb_defaults(wb) {
	applyDefaults(wb.WBProps, WBPropsDef);
	applyDefaults(wb.CalcPr, CalcPrDef);
	applyDefaultsToArray(wb.WBView, WBViewDef);
	applyDefaultsToArray(wb.Sheets, SheetDef);
}
/** Characters forbidden in Excel sheet names */
const badchars = Array.from(":][*?/\\");
/**
* Validate a sheet name against Excel naming rules.
*
* @param n - Sheet name to validate
* @param safe - If true, return false on invalid names instead of throwing
* @returns true if valid
* @throws XlsxError describing the validation failure (unless safe=true)
*/
function validateSheetName(n, safe) {
	try {
		if (n === "") throw new XlsxError("INVALID_ARGUMENT", "Sheet name cannot be blank");
		if (n.length > 31) throw new XlsxError("INVALID_ARGUMENT", "Sheet name cannot exceed 31 chars");
		if (n.charCodeAt(0) === 39 || n.charCodeAt(n.length - 1) === 39) throw new XlsxError("INVALID_ARGUMENT", "Sheet name cannot start or end with apostrophe (')");
		if (n.toLowerCase() === "history") throw new XlsxError("INVALID_ARGUMENT", "Sheet name cannot be 'History'");
		for (const c of badchars) if (n.indexOf(c) !== -1) throw new XlsxError("INVALID_ARGUMENT", "Sheet name cannot contain : \\ / ? * [ ]");
	} catch (error) {
		if (safe) return false;
		throw error;
	}
	return true;
}
/**
* Validate all sheet names in a workbook for correctness and uniqueness.
*
* @param sheetNames - Array of sheet names to validate
* @param sheetEntries - Optional sheet entry metadata (reserved for future use)
* @throws XlsxError if any name is invalid or duplicated
*/
function validateWorkbookNames(sheetNames, _sheetEntries) {
	for (let i = 0; i < sheetNames.length; ++i) {
		validateSheetName(sheetNames[i]);
		for (let j = 0; j < i; ++j) if (sheetNames[i] === sheetNames[j]) throw new XlsxError("DUPLICATE", "Duplicate Sheet Name: " + sheetNames[i]);
	}
}
/**
* Validate that a WorkBook object has the required structure.
*
* @param wb - WorkBook to validate
* @throws XlsxError if the workbook is missing required fields or has invalid sheet names
*/
function validateWorkbook(wb) {
	if (!wb || !wb.SheetNames || !wb.Sheets) throw new XlsxError("INVALID_ARGUMENT", "Invalid Workbook");
	if (!wb.SheetNames.length) throw new XlsxError("INVALID_ARGUMENT", "Workbook is empty");
	const Sheets = wb.Workbook && wb.Workbook.Sheets || [];
	validateWorkbookNames(wb.SheetNames, Sheets);
}
/** Detects whether the workbook XML uses a namespace prefix (e.g. <x:workbook>) */
const wbnsregex = /<\w+:workbook/;
/**
* Parse a workbook.xml file into a WorkbookFile structure.
*
* Extracts file version, workbook properties, views, sheet list, defined names,
* and calculation properties from the XML.
*
* @param data - Raw XML string of workbook.xml
* @param opts - Parsing options
* @returns Parsed workbook file structure
* @throws XlsxError if data is empty or the namespace is unrecognized
*/
function parseWorkbookXml(data, _opts) {
	if (!data) throw new XlsxError("NOT_FOUND", "Could not find file");
	const workbook = {
		AppVersion: {},
		WBProps: {},
		WBView: [],
		Sheets: [],
		CalcPr: {},
		Names: [],
		xmlns: ""
	};
	let xmlns = "xmlns";
	let dname = {};
	let dnstart = 0;
	const ignoredTags = /* @__PURE__ */ new Set([
		"<?xml",
		"</workbook>",
		"<fileVersion/>",
		"</fileVersion>",
		"<fileSharing",
		"<fileSharing/>",
		"</workbookPr>",
		"<workbookProtection",
		"<workbookProtection/>",
		"<bookViews",
		"<bookViews>",
		"</bookViews>",
		"</workbookView>",
		"<sheets",
		"<sheets>",
		"</sheets>",
		"</sheet>",
		"<functionGroups",
		"<functionGroups/>",
		"<functionGroup",
		"<externalReferences",
		"</externalReferences>",
		"<externalReferences>",
		"<externalReference",
		"<definedNames/>",
		"<definedNames>",
		"<definedNames",
		"</definedNames>",
		"<definedName/>",
		"</calcPr>",
		"<oleSize",
		"<customWorkbookViews>",
		"</customWorkbookViews>",
		"<customWorkbookViews",
		"<customWorkbookView",
		"</customWorkbookView>",
		"<pivotCaches>",
		"</pivotCaches>",
		"<pivotCaches",
		"<pivotCache",
		"<smartTagPr",
		"<smartTagPr/>",
		"<smartTagTypes",
		"<smartTagTypes>",
		"</smartTagTypes>",
		"<smartTagType",
		"<webPublishing",
		"<webPublishing/>",
		"<fileRecoveryPr",
		"<fileRecoveryPr/>",
		"<webPublishObjects>",
		"<webPublishObjects",
		"</webPublishObjects>",
		"<webPublishObject",
		"<extLst",
		"<extLst>",
		"</extLst>",
		"<extLst/>",
		"<ext",
		"</ext>",
		"<ArchID",
		"<AlternateContent",
		"<AlternateContent>",
		"</AlternateContent>",
		"<revisionPtr"
	]);
	data.replace(XML_TAG_REGEX, function xml_wb(xmlTag, idx) {
		const parsedTag = parseXmlTag(xmlTag);
		const tag = stripNamespace(parsedTag[0]);
		if (ignoredTags.has(tag)) return xmlTag;
		switch (tag) {
			case "<workbook":
				if (xmlTag.match(wbnsregex)) xmlns = "xmlns" + xmlTag.match(/<(\w+):/)?.[1];
				workbook.xmlns = parsedTag[xmlns];
				break;
			case "<fileVersion":
				delete parsedTag[0];
				workbook.AppVersion = parsedTag;
				break;
			case "<workbookPr":
			case "<workbookPr/>":
				WBPropsDef.forEach((propDef) => {
					if (parsedTag[propDef[0]] == null) return;
					switch (propDef[2]) {
						case "bool":
							workbook.WBProps[propDef[0]] = parseXmlBoolean(parsedTag[propDef[0]]);
							break;
						case "int":
							workbook.WBProps[propDef[0]] = parseInt(parsedTag[propDef[0]], 10);
							break;
						default: workbook.WBProps[propDef[0]] = parsedTag[propDef[0]];
					}
				});
				if (parsedTag.codeName) workbook.WBProps.CodeName = utf8read(parsedTag.codeName);
				break;
			case "<workbookView":
			case "<workbookView/>":
				delete parsedTag[0];
				workbook.WBView.push(parsedTag);
				break;
			case "<sheet":
				switch (parsedTag.state) {
					case "hidden":
						parsedTag.Hidden = 1;
						break;
					case "veryHidden":
						parsedTag.Hidden = 2;
						break;
					default: parsedTag.Hidden = 0;
				}
				delete parsedTag.state;
				parsedTag.name = unescapeXml(utf8read(parsedTag.name));
				delete parsedTag[0];
				workbook.Sheets.push(parsedTag);
				break;
			case "<definedName":
				dname = {};
				dname.Name = utf8read(parsedTag.name);
				if (parsedTag.comment) dname.Comment = parsedTag.comment;
				if (parsedTag.localSheetId) dname.Sheet = +parsedTag.localSheetId;
				if (parseXmlBoolean(parsedTag.hidden || "0")) dname.Hidden = true;
				dnstart = idx + xmlTag.length;
				break;
			case "</definedName>":
				dname.Ref = unescapeXml(utf8read(data.slice(dnstart, idx)));
				workbook.Names.push(dname);
				break;
			case "<calcPr":
			case "<calcPr/>":
				delete parsedTag[0];
				workbook.CalcPr = parsedTag;
				break;
		}
		return xmlTag;
	});
	if (XMLNS_main.indexOf(workbook.xmlns) === -1) throw new XlsxError("UNSUPPORTED", "Unknown Namespace: " + workbook.xmlns);
	parse_wb_defaults(workbook);
	return workbook;
}
/**
* Write the workbook.xml containing the sheet list, defined names, and properties.
*
* @param wb - WorkBook to serialize
* @returns Complete workbook.xml string
*/
function writeWorkbookXml(wb) {
	const lines = [XML_HEADER];
	lines.push(writeXmlElement("workbook", null, {
		xmlns: XMLNS_main[0],
		"xmlns:r": XMLNS.r
	}));
	const write_names = !!(wb.Workbook && (wb.Workbook.Names || []).length > 0);
	const workbookPr = { codeName: "ThisWorkbook" };
	if (wb.Workbook && wb.Workbook.WBProps) {
		WBPropsDef.forEach((x) => {
			if (!wb.Workbook || !wb.Workbook.WBProps) return;
			const wbp = wb.Workbook.WBProps;
			if (wbp[x[0]] == null) return;
			if (wbp[x[0]] === x[1]) return;
			workbookPr[x[0]] = wbp[x[0]];
		});
		if (wb.Workbook.WBProps.CodeName) {
			workbookPr.codeName = wb.Workbook.WBProps.CodeName;
			delete workbookPr.CodeName;
		}
	}
	lines.push(writeXmlElement("workbookPr", null, workbookPr));
	const sheets = wb.Workbook && wb.Workbook.Sheets || [];
	if (sheets[0] && !!sheets[0].Hidden) {
		lines.push("<bookViews>");
		let i = 0;
		for (i = 0; i < wb.SheetNames.length; ++i) {
			if (!sheets[i]) break;
			if (!sheets[i].Hidden) break;
		}
		if (i === wb.SheetNames.length) i = 0;
		lines.push("<workbookView firstSheet=\"" + i + "\" activeTab=\"" + i + "\"/>");
		lines.push("</bookViews>");
	}
	lines.push("<sheets>");
	for (let i = 0; i < wb.SheetNames.length; ++i) {
		const sht = { name: escapeXml(wb.SheetNames[i].slice(0, 31)) };
		sht.sheetId = "" + (i + 1);
		sht["r:id"] = "rId" + (i + 1);
		if (sheets[i]) switch (sheets[i].Hidden) {
			case 1:
				sht.state = "hidden";
				break;
			case 2:
				sht.state = "veryHidden";
				break;
		}
		lines.push(writeXmlElement("sheet", null, sht));
	}
	lines.push("</sheets>");
	if (write_names) {
		lines.push("<definedNames>");
		if (wb.Workbook && wb.Workbook.Names) wb.Workbook.Names.forEach((n) => {
			const d = { name: n.Name };
			if (n.Comment) d.comment = n.Comment;
			if (n.Sheet != null) d.localSheetId = "" + n.Sheet;
			if (n.Hidden) d.hidden = "1";
			if (!n.Ref) return;
			lines.push(writeXmlElement("definedName", escapeXml(n.Ref), d));
		});
		lines.push("</definedNames>");
	}
	if (lines.length > 2) {
		lines.push("</workbook>");
		lines[1] = lines[1].replace("/>", ">");
	}
	return lines.join("");
}

//#endregion
//#region src/utils/cell.ts
/**
* Decode a row string (1-based) to a zero-based row index.
* @param rowstr - Row string, possibly with a "$" absolute marker (e.g. "5" or "$5")
* @returns Zero-based row index
*/
function decodeRow(rowstr) {
	return parseInt(removeRowAbsolute(rowstr), 10) - 1;
}
/**
* Encode a zero-based row index to a 1-based row string.
* @param row - Zero-based row index
* @returns 1-based row string (e.g. "1" for row index 0)
*/
function encodeRow(row) {
	return "" + (row + 1);
}
/**
* Remove the "$" absolute marker from the row portion of a cell reference.
* @param cstr - Cell reference string (e.g. "A$5")
* @returns Cell reference with relative row (e.g. "A5")
*/
function removeRowAbsolute(cstr) {
	return cstr.replace(/\$(\d+)$/, "$1");
}
/**
* Decode a column label (e.g. "A", "AA") to a zero-based column index.
*
* Treats column letters as a base-26 number where A=1, B=2, ..., Z=26.
*
* @param colstr - Column label string, possibly with "$" prefix
* @returns Zero-based column index (A=0, B=1, ..., Z=25, AA=26, ...)
*/
function decodeCol(colstr) {
	const c = removeColAbsolute(colstr);
	let d = 0;
	for (let i = 0; i < c.length; ++i) d = 26 * d + c.charCodeAt(i) - 64;
	return d - 1;
}
/**
* Encode a zero-based column index to an Excel column label (A, B, ..., Z, AA, AB, ...).
*
* Uses bijective base-26 numeration: col 0 = "A", col 25 = "Z", col 26 = "AA".
*
* @param col - Zero-based column index
* @returns Column label string
* @throws XlsxError if col is negative
*/
function encodeCol(col) {
	if (col < 0) throw new XlsxError("INVALID_ARGUMENT", "invalid column " + col);
	let result = "";
	for (++col; col; col = Math.floor((col - 1) / 26)) result = String.fromCharCode((col - 1) % 26 + 65) + result;
	return result;
}
/**
* Remove the "$" absolute marker from the column portion of a cell reference.
* @param cstr - Cell reference string (e.g. "$A5")
* @returns Cell reference with relative column (e.g. "A5")
*/
function removeColAbsolute(cstr) {
	return cstr.replace(/^\$([A-Z])/, "$1");
}
/**
* Decode an A1-style cell reference to a numeric {c, r} address (zero-based).
*
* Hand-optimized parser that processes characters by charCode for performance:
* digits (48-57) accumulate into the row, uppercase letters (65-90) into the column.
*
* @param cstr - Cell reference string (e.g. "A1", "AB12")
* @returns Zero-based cell address {c: column, r: row}
*/
function decodeCell(cstr) {
	let R = 0, C = 0;
	for (let i = 0; i < cstr.length; ++i) {
		const charCode = cstr.charCodeAt(i);
		if (charCode >= 48 && charCode <= 57) R = 10 * R + (charCode - 48);
		else if (charCode >= 65 && charCode <= 90) C = 26 * C + (charCode - 64);
	}
	return {
		c: C - 1,
		r: R - 1
	};
}
/**
* Encode a zero-based {c, r} cell address to an A1-style reference string.
* @param cell - Zero-based cell address
* @returns A1-style cell reference (e.g. "A1" for {c:0, r:0})
*/
function encodeCell(cell) {
	let col = cell.c + 1;
	let result = "";
	for (; col; col = (col - 1) / 26 | 0) result = String.fromCharCode((col - 1) % 26 + 65) + result;
	return result + (cell.r + 1);
}
/**
* Decode a range string (e.g. "A1:B2") to a Range object with start and end addresses.
*
* If no colon is present, the range is a single cell (start equals end).
*
* @param range - Range string in A1 notation
* @returns Range object with start (s) and end (e) addresses
*/
function decodeRange(range) {
	const idx = range.indexOf(":");
	if (idx === -1) return {
		s: decodeCell(range),
		e: decodeCell(range)
	};
	return {
		s: decodeCell(range.slice(0, idx)),
		e: decodeCell(range.slice(idx + 1))
	};
}
/**
* Encode a Range or pair of CellAddresses to an A1:B2 range string.
*
* Can be called as:
* - `encodeRange(range)` with a Range object
* - `encodeRange(start, end)` with two CellAddress objects
*
* If start and end are the same cell, returns a single cell reference (no colon).
*
* @param cs - A Range object, or the start CellAddress
* @param ce - Optional end CellAddress (when cs is a CellAddress)
* @returns Range string in A1 notation (e.g. "A1:B2" or "A1")
*/
function encodeRange(cs, ce) {
	if (ce === void 0 || typeof ce === "number") return encodeRange(cs.s, cs.e);
	const s = typeof cs === "string" ? cs : encodeCell(cs);
	const e = typeof ce === "string" ? ce : encodeCell(ce);
	return s === e ? s : s + ":" + e;
}
/**
* Performance-optimized range decoder that parses directly by charCode.
*
* Unlike {@link decodeRange}, this avoids creating intermediate strings/objects.
* Used on hot paths where many ranges must be parsed quickly.
*
* @param range - Range string in A1 notation (e.g. "A1:B2")
* @returns Range object with start (s) and end (e) addresses (zero-based)
*/
function safeDecodeRange(range) {
	const result = {
		s: {
			c: 0,
			r: 0
		},
		e: {
			c: 0,
			r: 0
		}
	};
	let idx = 0, i = 0, charCode = 0;
	const len = range.length;
	for (idx = 0; i < len; ++i) {
		if ((charCode = range.charCodeAt(i) - 64) < 1 || charCode > 26) break;
		idx = 26 * idx + charCode;
	}
	result.s.c = --idx;
	for (idx = 0; i < len; ++i) {
		if ((charCode = range.charCodeAt(i) - 48) < 0 || charCode > 9) break;
		idx = 10 * idx + charCode;
	}
	result.s.r = --idx;
	if (i === len || charCode !== 10) {
		result.e.c = result.s.c;
		result.e.r = result.s.r;
		return result;
	}
	++i;
	for (idx = 0; i !== len; ++i) {
		if ((charCode = range.charCodeAt(i) - 64) < 1 || charCode > 26) break;
		idx = 26 * idx + charCode;
	}
	result.e.c = --idx;
	for (idx = 0; i !== len; ++i) {
		if ((charCode = range.charCodeAt(i) - 48) < 0 || charCode > 9) break;
		idx = 10 * idx + charCode;
	}
	result.e.r = --idx;
	return result;
}
/** Retrieve a cell from a worksheet, handling both dense (array) and sparse (object) storage. */
function getCell(sheet, row, col) {
	const data = sheet["!data"];
	if (data != null) return data[row]?.[col];
	return sheet[encodeCol(col) + encodeRow(row)];
}
/** Store a cell in a worksheet, handling both dense and sparse storage. */
function setCell(sheet, row, col, cell) {
	const data = sheet["!data"];
	if (data != null) {
		if (!data[row]) data[row] = [];
		data[row][col] = cell;
		return cell;
	}
	sheet[encodeCell({
		r: row,
		c: col
	})] = cell;
	return cell;
}
/** Retrieve a cell or create a blank stub cell at the requested position. */
function getOrCreateCell(sheet, row, col) {
	return getCell(sheet, row, col) || setCell(sheet, row, col, { t: "z" });
}

//#endregion
//#region src/utils/date.ts
/**
* Convert a JavaScript Date to an Excel serial date number.
*
* Excel serial dates in the 1900 date system can be mapped to real JavaScript
* dates with the 1899-12-30 epoch. This preserves modern Excel serials such as
* 45292 -> 2024-01-01 while avoiding a representational value for Excel's
* fictitious 1900-02-29.
*
* @param v - JavaScript Date to convert
* @param date1904 - If true, use the 1904 date system (Mac Excel default), which shifts the epoch by 1462 days
* @returns Excel serial date number
*/
function dateToSerialNumber(v, date1904) {
	const epoch = v.getTime();
	if (date1904) return (epoch - Date.UTC(1904, 0, 1, 0, 0, 0)) / (1440 * 60 * 1e3);
	return (epoch - Date.UTC(1899, 11, 30, 0, 0, 0)) / (1440 * 60 * 1e3);
}
/**
* Convert an Excel serial date number to a JavaScript Date.
*
* Reverses the conversion done by {@link dateToSerialNumber}. The SSF display
* formatter represents Excel's fictitious serial 60 separately; this helper
* returns real JavaScript Dates for machine-readable conversion paths.
*
* @param v - Excel serial date number
* @param date1904 - If true, use the 1904 date system (adds 1462 days)
* @returns JavaScript Date corresponding to the serial number
*/
function serialNumberToDate(v, date1904) {
	if (date1904) return new Date(Date.UTC(1904, 0, 1, 0, 0, 0) + v * 24 * 60 * 60 * 1e3);
	return new Date(Date.UTC(1899, 11, 30, 0, 0, 0) + v * 24 * 60 * 60 * 1e3);
}
/**
* Shift a local Date to UTC by adding the timezone offset.
*
* Useful when a Date was constructed from local-time components but
* needs to be treated as a UTC timestamp.
*
* @param d - Date in local time
* @returns New Date shifted to represent the same wall-clock time in UTC
*/
function localToUtc(d) {
	const off = d.getTimezoneOffset();
	return new Date(d.getTime() + off * 60 * 1e3);
}
/**
* Shift a UTC Date to local time by subtracting the timezone offset.
*
* The inverse of {@link localToUtc}.
*
* @param d - Date in UTC
* @returns New Date shifted to represent the same wall-clock time in local time
*/
function utcToLocal(d) {
	const off = d.getTimezoneOffset();
	return /* @__PURE__ */ new Date(d.getTime() - off * 60 * 1e3);
}

//#endregion
//#region src/ssf/format.ts
/** Reverse a string character-by-character */
const reverseString = (x) => x.split("").reverse().join("");
/** Left-pad a value with zeros to a given width */
const padWithZeros = (value, width) => ("" + value).padStart(width, "0");
/** Left-pad a value with spaces to a given width */
const padWithSpaces = (value, width) => ("" + value).padStart(width, " ");
/** Right-pad a value with spaces to a given width */
const rightPadWithSpaces = (value, width) => ("" + value).padEnd(width, " ");
/** Left-pad a rounded value with zeros to a given width */
const padRoundedZeros = (value, width) => ("" + Math.round(value)).padStart(width, "0");
/**
* Check if a format string starts with "General" (case-insensitive) at position i.
*
* Uses charCode checks with `| 32` to do case-insensitive ASCII comparison:
* 103='g', 101='e', 110='n', 101='e', 114='r', 97='a', 108='l'
*/
function isGeneralFormat(s, i) {
	i = i || 0;
	return s.length >= 7 + i && (s.charCodeAt(i) | 32) === 103 && (s.charCodeAt(i + 1) | 32) === 101 && (s.charCodeAt(i + 2) | 32) === 110 && (s.charCodeAt(i + 3) | 32) === 101 && (s.charCodeAt(i + 4) | 32) === 114 && (s.charCodeAt(i + 5) | 32) === 97 && (s.charCodeAt(i + 6) | 32) === 108;
}
const days = Array.from({ length: 7 }, (_, i) => {
	const d = new Date(2017, 0, i + 1);
	return [new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d), new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(d)];
});
const months = Array.from({ length: 12 }, (_, i) => {
	const d = new Date(2e3, i, 1);
	const short = new Intl.DateTimeFormat("en-US", { month: "short" }).format(d);
	const long = new Intl.DateTimeFormat("en-US", { month: "long" }).format(d);
	return [
		short[0],
		short,
		long
	];
});
/**
* Normalize a floating-point number to match Excel's 15-significant-digit precision.
*
* Excel internally stores numbers as IEEE 754 doubles but displays only 15 significant digits.
* This function truncates or rounds the value to match that behavior.
*/
function normalizeExcelNumber(value) {
	const precStr = value.toPrecision(16);
	if (precStr.indexOf("e") > -1) {
		const mantissa = precStr.slice(0, precStr.indexOf("e"));
		return +(mantissa.indexOf(".") > -1 ? mantissa.slice(0, mantissa.slice(0, 2) === "0." ? 17 : 16) : mantissa.slice(0, 15) + "0".repeat(mantissa.length - 15)) + +("1" + precStr.slice(precStr.indexOf("e"))) - 1 || +precStr;
	}
	const normalizedStr = precStr.indexOf(".") > -1 ? precStr.slice(0, precStr.slice(0, 2) === "0." ? 17 : 16) : precStr.slice(0, 15) + "0".repeat(precStr.length - 15);
	return Number(normalizedStr);
}
/** Adjust date components for the Hijri (Islamic) calendar and compute day of week */
function SSF_fix_hijri(_date, o) {
	o[0] -= 581;
	const dow = _date.getDay();
	if (_date.getTime() < -22038912e5) return (dow + 6) % 7;
	return dow;
}
/**
* Parse an Excel serial date number into its date/time components.
*
* This is the core date decoder for the SSF engine. It handles:
* - The 1900 date system with the Lotus 1-2-3 leap year bug (serial 60 = Feb 29, 1900)
* - The 1904 date system (opts.date1904)
* - Hijri (Islamic) calendar mode
* - Sub-second precision rounding
*
* Valid serial range: 0 to 2958465 (Dec 31, 9999).
*
* @param value - Excel serial date number
* @param opts - Options object; opts.date1904 enables 1904 date system
* @param hijriMode - If true, convert to Hijri calendar dates
* @returns Parsed date components, or null if out of range
*/
function parseExcelDateCode(value, opts, hijriMode) {
	if (value > 2958465 || value < 0) return null;
	value = normalizeExcelNumber(value);
	let date = value | 0;
	let time = Math.floor(86400 * (value - date));
	const out = {
		daySerial: date,
		timeSeconds: time,
		subSeconds: 86400 * (value - date) - time,
		year: 0,
		month: 0,
		day: 0,
		hours: 0,
		minutes: 0,
		seconds: 0,
		dayOfWeek: 0
	};
	if (Math.abs(out.subSeconds) < 1e-6) out.subSeconds = 0;
	if (opts && opts.date1904) date += 1462;
	if (out.subSeconds > .9999) {
		out.subSeconds = 0;
		if (++time === 86400) {
			out.timeSeconds = time = 0;
			++date;
			++out.daySerial;
		}
	}
	let dout;
	let dow = 0;
	if (date === 60) {
		dout = hijriMode ? [
			1317,
			10,
			29
		] : [
			1900,
			2,
			29
		];
		dow = 3;
	} else if (date === 0) {
		dout = hijriMode ? [
			1317,
			8,
			29
		] : [
			1900,
			1,
			0
		];
		dow = 6;
	} else {
		if (date > 60) --date;
		const baseDate = new Date(1900, 0, 1);
		baseDate.setDate(baseDate.getDate() + date - 1);
		dout = [
			baseDate.getFullYear(),
			baseDate.getMonth() + 1,
			baseDate.getDate()
		];
		dow = baseDate.getDay();
		if (date < 60) dow = (dow + 6) % 7;
		if (hijriMode) dow = SSF_fix_hijri(baseDate, dout);
	}
	out.year = dout[0];
	out.month = dout[1];
	out.day = dout[2];
	out.seconds = time % 60;
	time = Math.floor(time / 60);
	out.minutes = time % 60;
	time = Math.floor(time / 60);
	out.hours = time;
	out.dayOfWeek = dow;
	return out;
}
/** Strip trailing zeros after the decimal point (e.g. "1.200" -> "1.2", "3.0" -> "3") */
function SSF_strip_decimal(o) {
	return o.indexOf(".") === -1 ? o : o.replace(/(?:\.0*|(\.\d*[1-9])0+)$/, "$1");
}
/** Normalize scientific notation: strip trailing decimal zeros and ensure 2-digit exponent */
function SSF_normalize_exp(o) {
	if (o.indexOf("E") === -1) return o;
	return o.replace(/(?:\.0*|(\.\d*[1-9])0+)[Ee]/, "$1E").replace(/(E[+-])(\d)$/, "$10$2");
}
/** Format a "small" number (magnitude <= 10^9) in the most compact representation */
function SSF_small_exp(v) {
	const w = v < 0 ? 12 : 11;
	let o = SSF_strip_decimal(v.toFixed(12));
	if (o.length <= w) return o;
	o = v.toPrecision(10);
	if (o.length <= w) return o;
	return v.toExponential(5);
}
/** Format a "large" number (magnitude > 10^9) in the most compact representation */
function SSF_large_exp(v) {
	const o = SSF_strip_decimal(v.toFixed(11));
	return o.length > (v < 0 ? 12 : 11) || o === "0" || o === "-0" ? v.toPrecision(6) : o;
}
/**
* Format a number using Excel's "General" numeric format.
*
* General format selects the most compact representation:
* integers are shown as-is, floats use up to 11 characters
* (or 12 for negative), switching to scientific notation for very
* large or very small values.
*/
function SSF_general_num(v) {
	if (!isFinite(v)) return isNaN(v) ? "#NUM!" : "#DIV/0!";
	const V = Math.floor(Math.log(Math.abs(v)) * Math.LOG10E);
	let o;
	if (V >= -4 && V <= -1) o = v.toPrecision(10 + V);
	else if (Math.abs(V) <= 9) o = SSF_small_exp(v);
	else if (V === 10) o = v.toFixed(10).substring(0, 12);
	else o = SSF_large_exp(v);
	return SSF_strip_decimal(SSF_normalize_exp(o.toUpperCase()));
}
/**
* Format any value using Excel's "General" format.
*
* Dispatches by type: strings pass through, booleans become "TRUE"/"FALSE",
* integers use toString(10), floats use SSF_general_num, and Dates are
* converted to serial numbers then formatted with format 14 (short date).
*/
function SSF_general(v, opts) {
	switch (typeof v) {
		case "string": return v;
		case "boolean": return v ? "TRUE" : "FALSE";
		case "number": return (v | 0) === v ? v.toString(10) : SSF_general_num(v);
		case "undefined": return "";
		case "object":
			if (v == null) return "";
			if (v instanceof Date) return formatNumber(14, dateToSerialNumber(v, opts && opts.date1904), opts);
	}
	throw new XlsxError("UNSUPPORTED", "unsupported value in General format: " + v);
}
/**
* Format a date/time component according to its type code and format token.
*
* Type codes correspond to ASCII codes of format letters:
*   98='b' (Buddhist year), 121='y' (year), 109='m' (month), 100='d' (day),
*   104='h' (12-hour), 72='H' (24-hour), 77='M' (minutes), 115='s' (seconds),
*   90='Z' (absolute/elapsed time), 101='e' (era year)
*
* @param type - ASCII code of the date/time component type
* @param fmt - The format token string (e.g. "yyyy", "mm", "hh")
* @param val - Parsed date/time components
* @param ss0 - Number of sub-second decimal digits (for "s" format)
* @returns Formatted date/time string for this component
*/
function SSF_write_date(type, fmt, val, ss0) {
	let result = "";
	let scaledSeconds = 0;
	let scaleFactor = 0;
	let year = val.year;
	let numericOut = 0;
	let outputLength = 0;
	switch (type) {
		case 98: year = val.year + 543;
		case 121:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = year % 100;
					outputLength = 2;
					break;
				default:
					numericOut = year % 1e4;
					outputLength = 4;
					break;
			}
			break;
		case 109:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = val.month;
					outputLength = fmt.length;
					break;
				case 3: return months[val.month - 1][1];
				case 5: return months[val.month - 1][0];
				default: return months[val.month - 1][2];
			}
			break;
		case 100:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = val.day;
					outputLength = fmt.length;
					break;
				case 3: return days[val.dayOfWeek][0];
				default: return days[val.dayOfWeek][1];
			}
			break;
		case 104:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = 1 + (val.hours + 11) % 12;
					outputLength = fmt.length;
					break;
				default: throw new XlsxError("MALFORMED", "bad hour format: " + fmt);
			}
			break;
		case 72:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = val.hours;
					outputLength = fmt.length;
					break;
				default: throw new XlsxError("MALFORMED", "bad hour format: " + fmt);
			}
			break;
		case 77:
			switch (fmt.length) {
				case 1:
				case 2:
					numericOut = val.minutes;
					outputLength = fmt.length;
					break;
				default: throw new XlsxError("MALFORMED", "bad minute format: " + fmt);
			}
			break;
		case 115:
			if (fmt !== "s" && fmt !== "ss" && fmt !== ".0" && fmt !== ".00" && fmt !== ".000") throw new XlsxError("MALFORMED", "bad second format: " + fmt);
			if (val.subSeconds === 0 && (fmt === "s" || fmt === "ss")) return padWithZeros(val.seconds, fmt.length);
			if (ss0 >= 2) scaleFactor = ss0 === 3 ? 1e3 : 100;
			else scaleFactor = ss0 === 1 ? 10 : 1;
			scaledSeconds = Math.round(scaleFactor * (val.seconds + val.subSeconds));
			if (scaledSeconds >= 60 * scaleFactor) scaledSeconds = 0;
			if (fmt === "s") return scaledSeconds === 0 ? "0" : "" + scaledSeconds / scaleFactor;
			result = padWithZeros(scaledSeconds, 2 + ss0);
			if (fmt === "ss") return result.substring(0, 2);
			return "." + result.substring(2, fmt.length - 1);
		case 90:
			switch (fmt) {
				case "[h]":
				case "[hh]":
					numericOut = val.daySerial * 24 + val.hours;
					break;
				case "[m]":
				case "[mm]":
					numericOut = (val.daySerial * 24 + val.hours) * 60 + val.minutes;
					break;
				case "[s]":
				case "[ss]":
					numericOut = ((val.daySerial * 24 + val.hours) * 60 + val.minutes) * 60 + (ss0 === 0 ? Math.round(val.seconds + val.subSeconds) : val.seconds);
					break;
				default: throw new XlsxError("MALFORMED", "bad abstime format: " + fmt);
			}
			outputLength = fmt.length === 3 ? 1 : 2;
			break;
		case 101:
			numericOut = year;
			outputLength = 1;
			break;
	}
	return outputLength > 0 ? padWithZeros(numericOut, outputLength) : "";
}
/** Insert thousands separators into a numeric string (e.g. "1234567" -> "1,234,567") */
function commaify(str) {
	return str.replace(/\B(?=(\d{3})+$)/g, ",");
}
const pct1 = /%/g;
/** Format a number with percentage: multiply by 100^(count of %) and append "%" symbols */
function write_num_pct(type, fmt, val) {
	const sfmt = fmt.replace(pct1, "");
	const mul = fmt.length - sfmt.length;
	return write_num(type, sfmt, val * Math.pow(10, 2 * mul)) + "%".repeat(mul);
}
/**
* Format a number with trailing comma scaling.
* Each trailing comma divides the value by 1000 (Excel convention for thousands/millions).
*/
function write_num_cm(type, fmt, val) {
	let idx = fmt.length - 1;
	while (fmt.charCodeAt(idx - 1) === 44) --idx;
	return write_num(type, fmt.substring(0, idx), val / Math.pow(10, 3 * (fmt.length - idx)));
}
/** Format a number in scientific/engineering notation (E+00 format) */
function write_num_exp(fmt, val) {
	let o;
	const idx = fmt.indexOf("E") - fmt.indexOf(".") - 1;
	if (fmt.match(/^#+0.0E\+0$/)) {
		if (val === 0) return "0.0E+0";
		if (val < 0) return "-" + write_num_exp(fmt, -val);
		const period = fmt.indexOf(".");
		const ee = Math.floor(Math.log(val) * Math.LOG10E) % period < 0 ? Math.floor(Math.log(val) * Math.LOG10E) % period + period : Math.floor(Math.log(val) * Math.LOG10E) % period;
		o = (val / Math.pow(10, ee)).toPrecision(idx + 1 + (period + ee) % period);
		if (o.indexOf("e") === -1) {
			const fakee = Math.floor(Math.log(val) * Math.LOG10E);
			if (o.indexOf(".") === -1) o = o.charAt(0) + "." + o.substring(1) + "E+" + (fakee - o.length + ee);
			else o += "E+" + (fakee - ee);
			while (o.substring(0, 2) === "0.") {
				o = o.charAt(0) + o.substring(2, period) + "." + o.substring(2 + period);
				o = o.replace(/^0+([1-9])/, "$1").replace(/^0+\./, "0.");
			}
			o = o.replace(/\+-/, "-");
		}
		o = o.replace(/^([+-]?)(\d*)\.(\d*)[Ee]/, ($$, $1, $2, $3) => $1 + $2 + $3.substring(0, (period + ee) % period) + "." + $3.substring(ee) + "E");
	} else o = val.toExponential(idx);
	if (fmt.match(/E\+00$/) && o.match(/e[+-]\d$/)) o = o.substring(0, o.length - 1) + "0" + o.charAt(o.length - 1);
	if (fmt.match(/E-/) && o.match(/e\+/)) o = o.replace(/e\+/, "e");
	return o.replace("e", "E");
}
/**
* Compute the best rational (fraction) approximation of a number using
* the Stern-Brocot / continued fraction algorithm.
*
* The algorithm iteratively builds the best fraction p/q where q <= maxDenominator,
* using the mediant property of the Stern-Brocot tree. It stops when the
* approximation error is below ~5e-8 or the denominator exceeds the limit.
*
* @param value - Number to approximate as a fraction
* @param maxDenominator - Maximum allowed denominator
* @param mixed - If true, return [wholePart, numerator, denominator]; otherwise [0, numerator, denominator]
* @returns [wholePart, numerator, denominator] triple
*/
function SSF_frac(value, maxDenominator, mixed) {
	const sgn = value < 0 ? -1 : 1;
	let absValue = value * sgn;
	let prevPrevNumer = 0, prevNumer = 1, numerator = 0;
	let prevPrevDenom = 1, prevDenom = 0, denominator = 0;
	let intPart = Math.floor(absValue);
	while (prevDenom < maxDenominator) {
		intPart = Math.floor(absValue);
		numerator = intPart * prevNumer + prevPrevNumer;
		denominator = intPart * prevDenom + prevPrevDenom;
		if (absValue - intPart < 5e-8) break;
		absValue = 1 / (absValue - intPart);
		prevPrevNumer = prevNumer;
		prevNumer = numerator;
		prevPrevDenom = prevDenom;
		prevDenom = denominator;
	}
	if (denominator > maxDenominator) if (prevDenom > maxDenominator) {
		denominator = prevPrevDenom;
		numerator = prevPrevNumer;
	} else {
		denominator = prevDenom;
		numerator = prevNumer;
	}
	if (!mixed) return [
		0,
		sgn * numerator,
		denominator
	];
	const wholePart = Math.floor(sgn * numerator / denominator);
	return [
		wholePart,
		sgn * numerator - wholePart * denominator,
		denominator
	];
}
const frac1 = /# (\?+)( ?)\/( ?)(\d+)/;
/** Format a fraction with a fixed denominator (e.g. "# ??/16") */
function write_num_f1(r, aval, sign) {
	const den = parseInt(r[4], 10);
	const rr = Math.round(aval * den);
	const base = Math.floor(rr / den);
	const myn = rr - base * den;
	const myd = den;
	return sign + (base === 0 ? "" : "" + base) + " " + (myn === 0 ? " ".repeat(r[1].length + 1 + r[4].length) : padWithSpaces(myn, r[1].length) + r[2] + "/" + r[3] + padWithZeros(myd, r[4].length));
}
/** Format an integer as a fraction with a fixed denominator (shows just the whole part) */
function write_num_f2(r, aval, sign) {
	return sign + (aval === 0 ? "" : "" + aval) + " ".repeat(r[1].length + 2 + r[4].length);
}
const dec1 = /^#*0*\.([0#]+)/;
const closeparen = /\)[^)]*[0#]/;
const phone = /\(###\) ###\\?-####/;
/**
* Replace format placeholders with their "empty" representations:
* '#' -> nothing, '?' -> space, '0' -> '0', others pass through.
* Used to generate padding for unfilled format positions.
*/
function hashq(str) {
	let o = "";
	for (let i = 0; i !== str.length; ++i) {
		const cc = str.charCodeAt(i);
		switch (cc) {
			case 35: break;
			case 63:
				o += " ";
				break;
			case 48:
				o += "0";
				break;
			default: o += String.fromCharCode(cc);
		}
	}
	return o;
}
/** Round a number to d decimal places, preserving sign */
function rnd(val, d) {
	const sgn = val < 0 ? -1 : 1;
	const dd = Math.pow(10, d);
	return "" + sgn * (Math.round(sgn * val * dd) / dd);
}
/** Extract fractional part, rounded to d decimal places; returns 0 if rounding carries into integer part */
function dec(val, d) {
	const _frac = val - Math.floor(val);
	const dd = Math.pow(10, d);
	if (d < ("" + Math.round(_frac * dd)).length) return 0;
	return Math.round(_frac * dd);
}
/** Check if rounding the fractional part to d digits causes a carry into the integer part */
function carry(val, d) {
	if (d < ("" + Math.round((val - Math.floor(val)) * Math.pow(10, d))).length) return 1;
	return 0;
}
/** Floor a number, using bitwise OR for 32-bit-safe values (faster than Math.floor) */
function flr(val) {
	if (val < 2147483647 && val > -2147483648) return "" + (val >= 0 ? val | 0 : val - 1 | 0);
	return "" + Math.floor(val);
}
/**
* Core number formatter for floating-point values.
*
* Handles all Excel numeric format patterns including:
* - Fixed decimals ("0.00"), leading zeros ("00"), digit suppression ("#")
* - Thousands separators ("#,##0"), trailing comma scaling
* - Percentage ("%"), scientific notation ("0.00E+00")
* - Fractions ("# ?/?", "# ??/??")
* - Parenthesized negatives ("(#,##0)")
* - Phone number format
* - Dash-separated patterns (like SSN: "000-00-0000")
*/
function write_num_flt(type, fmt, val) {
	if (type.charCodeAt(0) === 40 && !fmt.match(closeparen)) {
		const ffmt = fmt.replace(/\( */, "").replace(/ \)/, "").replace(/\)/, "");
		if (val >= 0) return write_num_flt("n", ffmt, val);
		return "(" + write_num_flt("n", ffmt, -val) + ")";
	}
	if (fmt.charCodeAt(fmt.length - 1) === 44) return write_num_cm(type, fmt, val);
	if (fmt.indexOf("%") !== -1) return write_num_pct(type, fmt, val);
	if (fmt.indexOf("E") !== -1) return write_num_exp(fmt, val);
	if (fmt.charCodeAt(0) === 36) return "$" + write_num_flt(type, fmt.substring(fmt.charAt(1) === " " ? 2 : 1), val);
	let o;
	let r;
	let ri;
	let ff;
	const aval = Math.abs(val);
	const sign = val < 0 ? "-" : "";
	if (fmt.match(/^00+$/)) return sign + padRoundedZeros(aval, fmt.length);
	if (fmt.match(/^[#?]+$/)) {
		o = padRoundedZeros(val, 0);
		if (o === "0") o = "";
		return o.length > fmt.length ? o : hashq(fmt.substring(0, fmt.length - o.length)) + o;
	}
	if (r = fmt.match(frac1)) return write_num_f1(r, aval, sign);
	if (fmt.match(/^#+0+$/)) return sign + padRoundedZeros(aval, fmt.length - fmt.indexOf("0"));
	if (r = fmt.match(dec1)) {
		o = rnd(val, r[1].length).replace(/^([^.]+)$/, "$1." + hashq(r[1])).replace(/\.$/, "." + hashq(r[1])).replace(/\.(\d*)$/, ($$, $1) => "." + $1 + "0".repeat(hashq(r[1]).length - $1.length));
		return fmt.indexOf("0.") !== -1 ? o : o.replace(/^0\./, ".");
	}
	fmt = fmt.replace(/^#+([0.])/, "$1");
	if (r = fmt.match(/^(0*)\.(#*)$/)) return sign + rnd(aval, r[2].length).replace(/\.(\d*[1-9])0*$/, ".$1").replace(/^(-?\d*)$/, "$1.").replace(/^0\./, r[1].length ? "0." : ".");
	if (fmt.match(/^#{1,3},##0(\.?)$/)) return sign + commaify(padRoundedZeros(aval, 0));
	if (r = fmt.match(/^#,##0\.([#0]*0)$/)) return val < 0 ? "-" + write_num_flt(type, fmt, -val) : commaify("" + (Math.floor(val) + carry(val, r[1].length))) + "." + padWithZeros(dec(val, r[1].length), r[1].length);
	if (r = fmt.match(/^#,#*,#0/)) return write_num_flt(type, fmt.replace(/^#,#*,/, ""), val);
	if (r = fmt.match(/^([0#]+)(\\?-([0#]+))+$/)) {
		o = reverseString(write_num_flt(type, fmt.replace(/[\\-]/g, ""), val));
		ri = 0;
		return reverseString(reverseString(fmt.replace(/\\/g, "")).replace(/[0#]/g, (x) => {
			return ri < o.length ? o.charAt(ri++) : x === "0" ? "0" : "";
		}));
	}
	if (fmt.match(phone)) {
		o = write_num_flt(type, "##########", val);
		return "(" + o.substring(0, 3) + ") " + o.substring(3, 6) + "-" + o.substring(6);
	}
	let oa = "";
	if (r = fmt.match(/^([#0?]+)( ?)\/( ?)([#0?]+)/)) {
		ri = Math.min(r[4].length, 7);
		ff = SSF_frac(aval, Math.pow(10, ri) - 1, false);
		o = sign;
		oa = write_num("n", r[1], ff[1]);
		if (oa.charAt(oa.length - 1) === " ") oa = oa.substring(0, oa.length - 1) + "0";
		o += oa + r[2] + "/" + r[3];
		oa = rightPadWithSpaces(ff[2], ri);
		if (oa.length < r[4].length) oa = hashq(r[4].substring(r[4].length - oa.length)) + oa;
		o += oa;
		return o;
	}
	if (r = fmt.match(/^# ([#0?]+)( ?)\/( ?)([#0?]+)/)) {
		ri = Math.min(Math.max(r[1].length, r[4].length), 7);
		ff = SSF_frac(aval, Math.pow(10, ri) - 1, true);
		return sign + (ff[0] || (ff[1] ? "" : "0")) + " " + (ff[1] ? padWithSpaces(ff[1], ri) + r[2] + "/" + r[3] + rightPadWithSpaces(ff[2], ri) : " ".repeat(2 * ri + 1 + r[2].length + r[3].length));
	}
	if (r = fmt.match(/^[#0?]+$/)) {
		o = padRoundedZeros(val, 0);
		if (fmt.length <= o.length) return o;
		return hashq(fmt.substring(0, fmt.length - o.length)) + o;
	}
	if (r = fmt.match(/^([#0?]+)\.([#0]+)$/)) {
		o = val.toFixed(Math.min(r[2].length, 10)).replace(/([^0])0+$/, "$1");
		ri = o.indexOf(".");
		const lres = fmt.indexOf(".") - ri;
		const rres = fmt.length - o.length - lres;
		return hashq(fmt.substring(0, lres) + o + fmt.substring(fmt.length - rres));
	}
	if (r = fmt.match(/^00,000\.([#0]*0)$/)) {
		ri = dec(val, r[1].length);
		return val < 0 ? "-" + write_num_flt(type, fmt, -val) : commaify(flr(val)).replace(/^\d,\d{3}$/, "0$&").replace(/^\d*$/, ($$) => "00," + ($$.length < 3 ? padWithZeros(0, 3 - $$.length) : "") + $$) + "." + padWithZeros(ri, r[1].length);
	}
	switch (fmt) {
		case "###,##0.00": return write_num_flt(type, "#,##0.00", val);
		case "###,###":
		case "##,###":
		case "#,###": {
			const x = commaify(padRoundedZeros(aval, 0));
			return x !== "0" ? sign + x : "";
		}
		case "###,###.00": return write_num_flt(type, "###,##0.00", val).replace(/^0\./, ".");
		case "#,###.00": return write_num_flt(type, "#,##0.00", val).replace(/^0\./, ".");
	}
	throw new XlsxError("UNSUPPORTED", "unsupported format |" + fmt + "|");
}
/**
* Core number formatter for integer values.
*
* Mirrors write_num_flt but optimized for values where (val | 0) === val.
* Avoids floating-point rounding operations where possible.
*/
function write_num_int(type, fmt, val) {
	if (type.charCodeAt(0) === 40 && !fmt.match(closeparen)) {
		const ffmt = fmt.replace(/\( */, "").replace(/ \)/, "").replace(/\)/, "");
		if (val >= 0) return write_num_int("n", ffmt, val);
		return "(" + write_num_int("n", ffmt, -val) + ")";
	}
	if (fmt.charCodeAt(fmt.length - 1) === 44) return write_num_cm(type, fmt, val);
	if (fmt.indexOf("%") !== -1) return write_num_pct(type, fmt, val);
	if (fmt.indexOf("E") !== -1) return write_num_exp(fmt, val);
	if (fmt.charCodeAt(0) === 36) return "$" + write_num_int(type, fmt.substring(fmt.charAt(1) === " " ? 2 : 1), val);
	let o;
	let r;
	let ri;
	let ff;
	const aval = Math.abs(val);
	const sign = val < 0 ? "-" : "";
	if (fmt.match(/^00+$/)) return sign + padWithZeros(aval, fmt.length);
	if (fmt.match(/^[#?]+$/)) {
		o = "" + val;
		if (val === 0) o = "";
		return o.length > fmt.length ? o : hashq(fmt.substring(0, fmt.length - o.length)) + o;
	}
	if (r = fmt.match(frac1)) return write_num_f2(r, aval, sign);
	if (fmt.match(/^#+0+$/)) return sign + padWithZeros(aval, fmt.length - fmt.indexOf("0"));
	if (r = fmt.match(dec1)) {
		o = ("" + val).replace(/^([^.]+)$/, "$1." + hashq(r[1])).replace(/\.$/, "." + hashq(r[1]));
		o = o.replace(/\.(\d*)$/, ($$, $1) => "." + $1 + "0".repeat(hashq(r[1]).length - $1.length));
		return fmt.indexOf("0.") !== -1 ? o : o.replace(/^0\./, ".");
	}
	fmt = fmt.replace(/^#+([0.])/, "$1");
	if (r = fmt.match(/^(0*)\.(#*)$/)) return sign + ("" + aval).replace(/\.(\d*[1-9])0*$/, ".$1").replace(/^(-?\d*)$/, "$1.").replace(/^0\./, r[1].length ? "0." : ".");
	if (fmt.match(/^#{1,3},##0(\.?)$/)) return sign + commaify("" + aval);
	if (r = fmt.match(/^#,##0\.([#0]*0)$/)) return val < 0 ? "-" + write_num_int(type, fmt, -val) : commaify("" + val) + "." + "0".repeat(r[1].length);
	if (r = fmt.match(/^#,#*,#0/)) return write_num_int(type, fmt.replace(/^#,#*,/, ""), val);
	if (r = fmt.match(/^([0#]+)(\\?-([0#]+))+$/)) {
		o = reverseString(write_num_int(type, fmt.replace(/[\\-]/g, ""), val));
		ri = 0;
		return reverseString(reverseString(fmt.replace(/\\/g, "")).replace(/[0#]/g, (x) => {
			return ri < o.length ? o.charAt(ri++) : x === "0" ? "0" : "";
		}));
	}
	if (fmt.match(phone)) {
		o = write_num_int(type, "##########", val);
		return "(" + o.substring(0, 3) + ") " + o.substring(3, 6) + "-" + o.substring(6);
	}
	let oa = "";
	if (r = fmt.match(/^([#0?]+)( ?)\/( ?)([#0?]+)/)) {
		ri = Math.min(r[4].length, 7);
		ff = SSF_frac(aval, Math.pow(10, ri) - 1, false);
		o = sign;
		oa = write_num("n", r[1], ff[1]);
		if (oa.charAt(oa.length - 1) === " ") oa = oa.substring(0, oa.length - 1) + "0";
		o += oa + r[2] + "/" + r[3];
		oa = rightPadWithSpaces(ff[2], ri);
		if (oa.length < r[4].length) oa = hashq(r[4].substring(r[4].length - oa.length)) + oa;
		o += oa;
		return o;
	}
	if (r = fmt.match(/^# ([#0?]+)( ?)\/( ?)([#0?]+)/)) {
		ri = Math.min(Math.max(r[1].length, r[4].length), 7);
		ff = SSF_frac(aval, Math.pow(10, ri) - 1, true);
		return sign + (ff[0] || (ff[1] ? "" : "0")) + " " + (ff[1] ? padWithSpaces(ff[1], ri) + r[2] + "/" + r[3] + rightPadWithSpaces(ff[2], ri) : " ".repeat(2 * ri + 1 + r[2].length + r[3].length));
	}
	if (r = fmt.match(/^[#0?]+$/)) {
		o = "" + val;
		if (fmt.length <= o.length) return o;
		return hashq(fmt.substring(0, fmt.length - o.length)) + o;
	}
	if (r = fmt.match(/^([#0]+)\.([#0]+)$/)) {
		o = val.toFixed(Math.min(r[2].length, 10)).replace(/([^0])0+$/, "$1");
		ri = o.indexOf(".");
		const lres = fmt.indexOf(".") - ri;
		const rres = fmt.length - o.length - lres;
		return hashq(fmt.substring(0, lres) + o + fmt.substring(fmt.length - rres));
	}
	if (r = fmt.match(/^00,000\.([#0]*0)$/)) return val < 0 ? "-" + write_num_int(type, fmt, -val) : commaify("" + val).replace(/^\d,\d{3}$/, "0$&").replace(/^\d*$/, ($$) => "00," + ($$.length < 3 ? padWithZeros(0, 3 - $$.length) : "") + $$) + "." + padWithZeros(0, r[1].length);
	switch (fmt) {
		case "###,###":
		case "##,###":
		case "#,###": {
			const x = commaify("" + aval);
			return x !== "0" ? sign + x : "";
		}
		default: if (fmt.match(/\.[0#?]*$/)) return write_num_int(type, fmt.slice(0, fmt.lastIndexOf(".")), val) + hashq(fmt.slice(fmt.lastIndexOf(".")));
	}
	throw new XlsxError("UNSUPPORTED", "unsupported format |" + fmt + "|");
}
/** Dispatch to integer or float formatter based on whether the value is an integer */
function write_num(type, fmt, val) {
	return (val | 0) === val ? write_num_int(type, fmt, val) : write_num_flt(type, fmt, val);
}
/**
* Split a format string into semicolon-delimited sections.
*
* Respects quoted strings (between double quotes) and escaped characters
* (preceded by backslash, underscore, or asterisk) so that semicolons
* inside those contexts are not treated as section separators.
*
* Excel format strings can have up to 4 sections:
*   section1 ; section2 ; section3 ; section4
*   positive ; negative ; zero     ; text
*/
function SSF_split_fmt(fmt) {
	const out = [];
	let in_str = false;
	let j = 0;
	for (let i = 0; i < fmt.length; ++i) switch (fmt.charCodeAt(i)) {
		case 34:
			in_str = !in_str;
			break;
		case 95:
		case 42:
		case 92:
			++i;
			break;
		case 59:
			out[out.length] = fmt.substring(j, i);
			j = i + 1;
	}
	out[out.length] = fmt.substring(j);
	if (in_str) throw new XlsxError("MALFORMED", "Format |" + fmt + "| unterminated string ");
	return out;
}
/** Regex to detect absolute time tokens like [h], [mm], [ss] (including Thai equivalents) */
const SSF_abstime = /\[[HhMmSs\u0E0A\u0E19\u0E17]*\]/;
function classifyDateTimeTokens(hasDate, hasTime, hasMonth) {
	if (hasDate) return hasTime ? "datetime" : "date";
	if (hasTime) return "time";
	return hasMonth ? "date" : "none";
}
/**
* Classify date/time tokens in a format string.
*
* Scans the format string for date/time tokens (y, m, d, h, s, etc.) while
* skipping over quoted strings, escaped characters, numeric placeholders,
* and color/condition blocks.
*
* @param fmt - Excel number format string
* @returns a classification of the date/time tokens in the format
*/
function getDateTimeFormatKind(fmt) {
	let i = 0;
	let c = "";
	let o = "";
	let hasDate = false;
	let hasTime = false;
	let hasMonth = false;
	while (i < fmt.length) switch (c = fmt.charAt(i)) {
		case "G":
			if (isGeneralFormat(fmt, i)) i += 6;
			i++;
			break;
		case "\"":
			for (; fmt.charCodeAt(++i) !== 34 && i < fmt.length;);
			++i;
			break;
		case "\\":
			i += 2;
			break;
		case "_":
			i += 2;
			break;
		case "@":
			++i;
			break;
		case "B":
		case "b": if (fmt.charAt(i + 1) === "1" || fmt.charAt(i + 1) === "2") {
			hasDate = true;
			i += 2;
			break;
		}
		case "D":
		case "Y":
		case "E":
		case "d":
		case "y":
		case "e":
		case "g":
			hasDate = true;
			++i;
			break;
		case "M":
		case "m":
			hasMonth = true;
			++i;
			break;
		case "H":
		case "S":
		case "h":
		case "s":
			hasTime = true;
			++i;
			break;
		case "A":
		case "a":
		case "上":
			if (fmt.substring(i, i + 3).toUpperCase() === "A/P") {
				hasTime = true;
				i += 3;
				break;
			}
			if (fmt.substring(i, i + 5).toUpperCase() === "AM/PM") {
				hasTime = true;
				i += 5;
				break;
			}
			if (fmt.substring(i, i + 5).toUpperCase() === "上午/下午") {
				hasTime = true;
				i += 5;
				break;
			}
			++i;
			break;
		case "[":
			o = c;
			while (fmt.charAt(i++) !== "]" && i < fmt.length) o += fmt.charAt(i);
			if (o.match(SSF_abstime)) hasTime = true;
			break;
		case ".":
		case "0":
		case "#":
			while (i < fmt.length && ("0#?.,E+-%".indexOf(c = fmt.charAt(++i)) > -1 || c === "\\" && fmt.charAt(i + 1) === "-" && "0#".indexOf(fmt.charAt(i + 2)) > -1));
			break;
		case "?":
			while (fmt.charAt(++i) === c);
			break;
		case "*":
			++i;
			if (fmt.charAt(i) === " " || fmt.charAt(i) === "*") ++i;
			break;
		case "(":
		case ")":
			++i;
			break;
		case "1":
		case "2":
		case "3":
		case "4":
		case "5":
		case "6":
		case "7":
		case "8":
		case "9":
			while (i < fmt.length && "0123456789".indexOf(fmt.charAt(++i)) > -1);
			break;
		case " ":
			++i;
			break;
		default:
			++i;
			break;
	}
	return classifyDateTimeTokens(hasDate, hasTime, hasMonth);
}
/**
* Determine if a format string represents a date/time format.
*
* Scans the format string for date/time tokens while skipping quoted strings,
* escaped characters, numeric placeholders, and color/condition blocks.
*
* @param fmt - Excel number format string
* @returns true if the format contains date/time formatting tokens
*/
function isDateFormat(fmt) {
	return getDateTimeFormatKind(fmt) !== "none";
}
/**
* Tokenize and evaluate an Excel format string against a value.
*
* This is the heart of the SSF engine. It works in 4 phases:
*
* 1. **Tokenize**: Walk the format string character by character, producing
*    an array of typed tokens (text literals, date placeholders, number
*    placeholders, AM/PM markers, etc.). During tokenization, date tokens
*    trigger lazy parsing of the value as a serial date number.
*
* 2. **Resolve ambiguous 'm'**: In Excel, "m" means month when adjacent to
*    day/year tokens, but minutes when adjacent to h/s tokens. A backward
*    scan resolves this by checking the preceding/following token types.
*
* 3. **Time rounding**: Round the parsed date/time to the appropriate
*    precision based on whether seconds, minutes, or hours are displayed.
*
* 4. **Render**: Replace date/time tokens with formatted values, coalesce
*    number format tokens, and produce the final output string.
*
* @param fmt - A single format section (no semicolons)
* @param value - The cell value to format
* @param opts - Formatting options (date1904, dateNF, etc.)
* @param flen - Number of format sections in the original format string (affects sign handling)
* @returns Formatted string
*/
function eval_fmt(fmt, value, opts, flen) {
	const out = [];
	let tokenStr = "";
	let i = 0;
	let char = "";
	let lastTokenType = "t";
	let dateVal = null;
	let scanIdx;
	let charCode;
	let hourFormat = "H";
	while (i < fmt.length) switch (char = fmt.charAt(i)) {
		case "G":
			if (!isGeneralFormat(fmt, i)) throw new XlsxError("MALFORMED", "unrecognized character " + char + " in " + fmt);
			out[out.length] = {
				type: "G",
				value: "General"
			};
			i += 7;
			break;
		case "\"":
			for (tokenStr = ""; (charCode = fmt.charCodeAt(++i)) !== 34 && i < fmt.length;) tokenStr += String.fromCharCode(charCode);
			out[out.length] = {
				type: "t",
				value: tokenStr
			};
			++i;
			break;
		case "\\": {
			const nextChar = fmt.charAt(++i);
			const t2 = nextChar === "(" || nextChar === ")" ? nextChar : "t";
			out[out.length] = {
				type: t2,
				value: nextChar
			};
			++i;
			break;
		}
		case "_":
			out[out.length] = {
				type: "t",
				value: " "
			};
			i += 2;
			break;
		case "@":
			out[out.length] = {
				type: "T",
				value
			};
			++i;
			break;
		case "B":
		case "b": if (fmt.charAt(i + 1) === "1" || fmt.charAt(i + 1) === "2") {
			if (dateVal == null) {
				dateVal = parseExcelDateCode(value, opts, fmt.charAt(i + 1) === "2");
				if (dateVal == null) return "";
			}
			out[out.length] = {
				type: "X",
				value: fmt.substring(i, i + 2)
			};
			lastTokenType = char;
			i += 2;
			break;
		}
		case "M":
		case "D":
		case "Y":
		case "H":
		case "S":
		case "E": char = char.toLowerCase();
		case "m":
		case "d":
		case "y":
		case "h":
		case "s":
		case "e":
		case "g":
			if (value < 0) return "";
			if (dateVal == null) {
				dateVal = parseExcelDateCode(value, opts);
				if (dateVal == null) return "";
			}
			tokenStr = char;
			while (++i < fmt.length && fmt.charAt(i).toLowerCase() === char) tokenStr += char;
			if (char === "m" && lastTokenType.toLowerCase() === "h") char = "M";
			if (char === "h") char = hourFormat;
			out[out.length] = {
				type: char,
				value: tokenStr
			};
			lastTokenType = char;
			break;
		case "A":
		case "a":
		case "上": {
			const ampmToken = {
				type: char,
				value: char
			};
			if (dateVal == null) dateVal = parseExcelDateCode(value, opts);
			if (fmt.substring(i, i + 3).toUpperCase() === "A/P") {
				if (dateVal != null) ampmToken.value = dateVal.hours >= 12 ? fmt.charAt(i + 2) : char;
				ampmToken.type = "T";
				hourFormat = "h";
				i += 3;
			} else if (fmt.substring(i, i + 5).toUpperCase() === "AM/PM") {
				if (dateVal != null) ampmToken.value = dateVal.hours >= 12 ? "PM" : "AM";
				ampmToken.type = "T";
				i += 5;
				hourFormat = "h";
			} else if (fmt.substring(i, i + 5).toUpperCase() === "上午/下午") {
				if (dateVal != null) ampmToken.value = dateVal.hours >= 12 ? "下午" : "上午";
				ampmToken.type = "T";
				i += 5;
				hourFormat = "h";
			} else {
				ampmToken.type = "t";
				++i;
			}
			if (dateVal == null && ampmToken.type === "T") return "";
			out[out.length] = ampmToken;
			lastTokenType = char;
			break;
		}
		case "[":
			tokenStr = char;
			while (fmt.charAt(i++) !== "]" && i < fmt.length) tokenStr += fmt.charAt(i);
			if (tokenStr.slice(-1) !== "]") throw new XlsxError("MALFORMED", "unterminated \"[\" block: |" + tokenStr + "|");
			if (tokenStr.match(SSF_abstime)) {
				if (dateVal == null) {
					dateVal = parseExcelDateCode(value, opts);
					if (dateVal == null) return "";
				}
				out[out.length] = {
					type: "Z",
					value: tokenStr.toLowerCase()
				};
				lastTokenType = tokenStr.charAt(1);
			} else if (tokenStr.indexOf("$") > -1) {
				tokenStr = (tokenStr.match(/\$([^-[\]]*)/) || [])[1] || "$";
				if (!isDateFormat(fmt)) out[out.length] = {
					type: "t",
					value: tokenStr
				};
			}
			break;
		case ".": if (dateVal != null) {
			tokenStr = char;
			while (++i < fmt.length && (char = fmt.charAt(i)) === "0") tokenStr += char;
			out[out.length] = {
				type: "s",
				value: tokenStr
			};
			break;
		}
		case "0":
		case "#":
			tokenStr = char;
			while (++i < fmt.length && "0#?.,E+-%".indexOf(char = fmt.charAt(i)) > -1) tokenStr += char;
			out[out.length] = {
				type: "n",
				value: tokenStr
			};
			break;
		case "?":
			tokenStr = char;
			while (fmt.charAt(++i) === char) tokenStr += char;
			out[out.length] = {
				type: char,
				value: tokenStr
			};
			lastTokenType = char;
			break;
		case "*":
			++i;
			if (fmt.charAt(i) === " " || fmt.charAt(i) === "*") ++i;
			break;
		case "(":
		case ")":
			out[out.length] = {
				type: flen === 1 ? "t" : char,
				value: char
			};
			++i;
			break;
		case "1":
		case "2":
		case "3":
		case "4":
		case "5":
		case "6":
		case "7":
		case "8":
		case "9":
			tokenStr = char;
			while (i < fmt.length && "0123456789".indexOf(fmt.charAt(++i)) > -1) tokenStr += fmt.charAt(i);
			out[out.length] = {
				type: "D",
				value: tokenStr
			};
			break;
		case " ":
			out[out.length] = {
				type: char,
				value: char
			};
			++i;
			break;
		case "$":
			out[out.length] = {
				type: "t",
				value: "$"
			};
			++i;
			break;
		default:
			if (",$-+/():!^&'~{}<>=€acfijklopqrtuvwxzP".indexOf(char) === -1) throw new XlsxError("MALFORMED", "unrecognized character " + char + " in " + fmt);
			out[out.length] = {
				type: "t",
				value: char
			};
			++i;
			break;
	}
	let dateTimePrecision = 0;
	let subSecondDigits = 0;
	let ssm;
	for (i = out.length - 1, lastTokenType = "t"; i >= 0; --i) {
		if (!out[i]) continue;
		switch (out[i].type) {
			case "h":
			case "H":
				out[i].type = hourFormat;
				lastTokenType = "h";
				if (dateTimePrecision < 1) dateTimePrecision = 1;
				break;
			case "s":
				if (ssm = out[i].value.match(/\.0+$/)) {
					subSecondDigits = Math.max(subSecondDigits, ssm[0].length - 1);
					dateTimePrecision = 4;
				}
				if (dateTimePrecision < 3) dateTimePrecision = 3;
			case "d":
			case "y":
			case "e":
				lastTokenType = out[i].type;
				break;
			case "M":
				lastTokenType = out[i].type;
				if (dateTimePrecision < 2) dateTimePrecision = 2;
				break;
			case "m":
				if (lastTokenType === "s") {
					out[i].type = "M";
					if (dateTimePrecision < 2) dateTimePrecision = 2;
				}
				break;
			case "X": break;
			case "Z":
				if (dateTimePrecision < 1 && out[i].value.match(/[Hh]/)) dateTimePrecision = 1;
				if (dateTimePrecision < 2 && out[i].value.match(/[Mm]/)) dateTimePrecision = 2;
				if (dateTimePrecision < 3 && out[i].value.match(/[Ss]/)) dateTimePrecision = 3;
		}
	}
	if (dateVal) {
		let _dt;
		switch (dateTimePrecision) {
			case 0: break;
			case 1:
			case 2:
			case 3:
				if (dateVal.subSeconds >= .5) {
					dateVal.subSeconds = 0;
					++dateVal.seconds;
				}
				if (dateVal.seconds >= 60) {
					dateVal.seconds = 0;
					++dateVal.minutes;
				}
				if (dateVal.minutes >= 60) {
					dateVal.minutes = 0;
					++dateVal.hours;
				}
				if (dateVal.hours >= 24) {
					dateVal.hours = 0;
					++dateVal.daySerial;
					_dt = parseExcelDateCode(dateVal.daySerial);
					if (_dt) {
						_dt.subSeconds = dateVal.subSeconds;
						_dt.seconds = dateVal.seconds;
						_dt.minutes = dateVal.minutes;
						_dt.hours = dateVal.hours;
						dateVal = _dt;
					}
				}
				break;
			case 4:
				switch (subSecondDigits) {
					case 1:
						dateVal.subSeconds = Math.round(dateVal.subSeconds * 10) / 10;
						break;
					case 2:
						dateVal.subSeconds = Math.round(dateVal.subSeconds * 100) / 100;
						break;
					case 3:
						dateVal.subSeconds = Math.round(dateVal.subSeconds * 1e3) / 1e3;
						break;
				}
				if (dateVal.subSeconds >= 1) {
					dateVal.subSeconds = 0;
					++dateVal.seconds;
				}
				if (dateVal.seconds >= 60) {
					dateVal.seconds = 0;
					++dateVal.minutes;
				}
				if (dateVal.minutes >= 60) {
					dateVal.minutes = 0;
					++dateVal.hours;
				}
				if (dateVal.hours >= 24) {
					dateVal.hours = 0;
					++dateVal.daySerial;
					_dt = parseExcelDateCode(dateVal.daySerial);
					if (_dt) {
						_dt.subSeconds = dateVal.subSeconds;
						_dt.seconds = dateVal.seconds;
						_dt.minutes = dateVal.minutes;
						_dt.hours = dateVal.hours;
						dateVal = _dt;
					}
				}
				break;
		}
	}
	let numberFmtStr = "";
	let numFmtIdx;
	for (i = 0; i < out.length; ++i) {
		if (!out[i]) continue;
		switch (out[i].type) {
			case "t":
			case "T":
			case " ":
			case "D": break;
			case "X":
				out[i].value = "";
				out[i].type = ";";
				break;
			case "d":
			case "m":
			case "y":
			case "h":
			case "H":
			case "M":
			case "s":
			case "e":
			case "b":
			case "Z":
				out[i].value = SSF_write_date(out[i].type.charCodeAt(0), out[i].value, dateVal, subSecondDigits);
				out[i].type = "t";
				break;
			case "n":
			case "?":
				numFmtIdx = i + 1;
				while (out[numFmtIdx] != null && ((char = out[numFmtIdx].type) === "?" || char === "D" || (char === " " || char === "t") && out[numFmtIdx + 1] != null && (out[numFmtIdx + 1].type === "?" || out[numFmtIdx + 1].type === "t" && out[numFmtIdx + 1].value === "/") || out[i].type === "(" && (char === " " || char === "n" || char === ")") || char === "t" && (out[numFmtIdx].value === "/" || out[numFmtIdx].value === " " && out[numFmtIdx + 1] != null && out[numFmtIdx + 1].type === "?"))) {
					out[i].value += out[numFmtIdx].value;
					out[numFmtIdx] = {
						value: "",
						type: ";"
					};
					++numFmtIdx;
				}
				numberFmtStr += out[i].value;
				i = numFmtIdx - 1;
				break;
			case "G":
				out[i].type = "t";
				out[i].value = SSF_general(value, opts);
				break;
		}
	}
	let partialValue = "";
	let adjustedValue;
	let formattedNumber;
	if (numberFmtStr.length > 0) {
		if (numberFmtStr.charCodeAt(0) === 40) {
			adjustedValue = value < 0 && numberFmtStr.charCodeAt(0) === 45 ? -value : value;
			formattedNumber = write_num("n", numberFmtStr, adjustedValue);
		} else {
			adjustedValue = value < 0 && flen > 1 ? -value : value;
			formattedNumber = write_num("n", numberFmtStr, adjustedValue);
			if (adjustedValue < 0 && out[0] && out[0].type === "t") {
				formattedNumber = formattedNumber.substring(1);
				out[0].value = "-" + out[0].value;
			}
		}
		numFmtIdx = formattedNumber.length - 1;
		let decpt = out.length;
		for (i = 0; i < out.length; ++i) if (out[i] != null && out[i].type !== "t" && out[i].value.indexOf(".") > -1) {
			decpt = i;
			break;
		}
		let lasti = out.length;
		if (decpt === out.length && formattedNumber.indexOf("E") === -1) {
			for (i = out.length - 1; i >= 0; --i) {
				if (out[i] == null || "n?".indexOf(out[i].type) === -1) continue;
				if (numFmtIdx >= out[i].value.length - 1) {
					numFmtIdx -= out[i].value.length;
					out[i].value = formattedNumber.substring(numFmtIdx + 1, out[i].value.length);
				} else if (numFmtIdx < 0) out[i].value = "";
				else {
					out[i].value = formattedNumber.substring(0, numFmtIdx + 1);
					numFmtIdx = -1;
				}
				out[i].type = "t";
				lasti = i;
			}
			if (numFmtIdx >= 0 && lasti < out.length) out[lasti].value = formattedNumber.substring(0, numFmtIdx + 1) + out[lasti].value;
		} else if (decpt !== out.length && formattedNumber.indexOf("E") === -1) {
			numFmtIdx = formattedNumber.indexOf(".") - 1;
			for (i = decpt; i >= 0; --i) {
				if (out[i] == null || "n?".indexOf(out[i].type) === -1) continue;
				scanIdx = out[i].value.indexOf(".") > -1 && i === decpt ? out[i].value.indexOf(".") - 1 : out[i].value.length - 1;
				partialValue = out[i].value.substring(scanIdx + 1);
				for (; scanIdx >= 0; --scanIdx) if (numFmtIdx >= 0 && (out[i].value.charAt(scanIdx) === "0" || out[i].value.charAt(scanIdx) === "#")) partialValue = formattedNumber.charAt(numFmtIdx--) + partialValue;
				out[i].value = partialValue;
				out[i].type = "t";
				lasti = i;
			}
			if (numFmtIdx >= 0 && lasti < out.length) out[lasti].value = formattedNumber.substring(0, numFmtIdx + 1) + out[lasti].value;
			numFmtIdx = formattedNumber.indexOf(".") + 1;
			for (i = decpt; i < out.length; ++i) {
				if (out[i] == null || "n?(".indexOf(out[i].type) === -1 && i !== decpt) continue;
				scanIdx = out[i].value.indexOf(".") > -1 && i === decpt ? out[i].value.indexOf(".") + 1 : 0;
				partialValue = out[i].value.substring(0, scanIdx);
				for (; scanIdx < out[i].value.length; ++scanIdx) if (numFmtIdx < formattedNumber.length) partialValue += formattedNumber.charAt(numFmtIdx++);
				out[i].value = partialValue;
				out[i].type = "t";
				lasti = i;
			}
		}
	}
	for (i = 0; i < out.length; ++i) if (out[i] != null && "n?".indexOf(out[i].type) > -1) {
		adjustedValue = flen > 1 && value < 0 && i > 0 && out[i - 1].value === "-" ? -value : value;
		out[i].value = write_num(out[i].type, out[i].value, adjustedValue);
		out[i].type = "t";
	}
	let retval = "";
	for (i = 0; i !== out.length; ++i) if (out[i] != null) retval += out[i].value;
	return retval;
}
/** Regex to parse conditional format expressions like [>=100] or [<0] */
const cfregex2 = /\[(=|>[=]?|<[>=]?)(-?\d+(?:\.\d*)?)\]/;
/** Evaluate a conditional format expression against a numeric value */
function chkcond(v, rr) {
	if (rr == null) return false;
	const thresh = parseFloat(rr[2]);
	switch (rr[1]) {
		case "=":
			if (v == thresh) return true;
			break;
		case ">":
			if (v > thresh) return true;
			break;
		case "<":
			if (v < thresh) return true;
			break;
		case "<>":
			if (v != thresh) return true;
			break;
		case ">=":
			if (v >= thresh) return true;
			break;
		case "<=":
			if (v <= thresh) return true;
			break;
	}
	return false;
}
/**
* Select the appropriate format section for a given value.
*
* Excel format strings can have up to 4 semicolon-separated sections:
*   1 section:  applies to all values
*   2 sections: positive/zero ; negative
*   3 sections: positive ; negative ; zero
*   4 sections: positive ; negative ; zero ; text
*
* If a section contains "@", it's a text section and is moved to position 4.
* If sections contain conditional expressions like [>=100], those are evaluated
* to determine which section applies.
*
* @param fmtStr - Full format string (may contain semicolons)
* @param value - Cell value to format
* @returns [sectionCount, selectedFormatSection] tuple
*/
function choose_fmt(fmtStr, value) {
	let fmt = SSF_split_fmt(fmtStr);
	const sectionCount = fmt.length;
	const lat = fmt[sectionCount - 1].indexOf("@");
	let ll = sectionCount;
	if (sectionCount < 4 && lat > -1) --ll;
	if (fmt.length > 4) throw new XlsxError("MALFORMED", "cannot find right format for |" + fmt.join("|") + "|");
	if (typeof value !== "number") return [4, fmt.length === 4 || lat > -1 ? fmt[fmt.length - 1] : "@"];
	if (typeof value === "number" && !isFinite(value)) value = 0;
	switch (fmt.length) {
		case 1:
			fmt = lat > -1 ? [
				"General",
				"General",
				"General",
				fmt[0]
			] : [
				fmt[0],
				fmt[0],
				fmt[0],
				"@"
			];
			break;
		case 2:
			fmt = lat > -1 ? [
				fmt[0],
				fmt[0],
				fmt[0],
				fmt[1]
			] : [
				fmt[0],
				fmt[1],
				fmt[0],
				"@"
			];
			break;
		case 3:
			fmt = lat > -1 ? [
				fmt[0],
				fmt[1],
				fmt[0],
				fmt[2]
			] : [
				fmt[0],
				fmt[1],
				fmt[2],
				"@"
			];
			break;
		case 4: break;
	}
	const selectedFmt = value > 0 ? fmt[0] : value < 0 ? fmt[1] : fmt[2];
	if (fmt[0].indexOf("[") === -1 && fmt[1].indexOf("[") === -1) return [ll, selectedFmt];
	if (fmt[0].match(/\[[=<>]/) != null || fmt[1].match(/\[[=<>]/) != null) {
		const m1 = fmt[0].match(cfregex2);
		const m2 = fmt[1].match(cfregex2);
		return chkcond(value, m1) ? [ll, fmt[0]] : chkcond(value, m2) ? [ll, fmt[1]] : [ll, fmt[m1 != null && m2 != null ? 2 : 1]];
	}
	return [ll, selectedFmt];
}
/**
* Format a numeric value using an Excel number format string or format index.
*
* This is the main entry point for the SSF engine. It resolves the format string
* (from index or direct string), selects the appropriate section for the value's
* sign, and delegates to the tokenizer/renderer ({@link eval_fmt}).
*
* @param fmt - Format string (e.g. "#,##0.00") or format index (e.g. 14 for "m/d/yy")
* @param value - The value to format (number, string, boolean, Date, etc.)
* @param options - Formatting options: date1904, dateNF (date format override), table (custom format table)
* @returns Formatted string representation
*/
function formatNumber(fmt, value, options) {
	if (options == null) options = {};
	let sfmt = "";
	switch (typeof fmt) {
		case "string":
			if (fmt === "m/d/yy" && options.dateNF) sfmt = options.dateNF;
			else sfmt = fmt;
			break;
		case "number":
			if (fmt === 14 && options.dateNF) sfmt = options.dateNF;
			else sfmt = (options.table != null ? options.table : formatTable)[fmt];
			if (sfmt == null) sfmt = options.table && options.table[DEFAULT_FORMAT_MAP[fmt]] || formatTable[DEFAULT_FORMAT_MAP[fmt]];
			if (sfmt == null) sfmt = DEFAULT_FORMAT_STRINGS[fmt] || "General";
			break;
	}
	if (isGeneralFormat(sfmt, 0)) return SSF_general(value, options);
	if (value instanceof Date) value = dateToSerialNumber(options.UTC ? value : new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds())), options.date1904);
	const chosenFmt = choose_fmt(sfmt, value);
	if (isGeneralFormat(chosenFmt[1])) return SSF_general(value, options);
	if (value === true) value = "TRUE";
	else if (value === false) value = "FALSE";
	else if (value === "" || value == null) return "";
	else if (isNaN(value) && chosenFmt[1].indexOf("0") > -1) return "#NUM!";
	else if (!isFinite(value) && chosenFmt[1].indexOf("0") > -1) return "#DIV/0!";
	return eval_fmt(chosenFmt[1], value, options, chosenFmt[0]);
}

//#endregion
//#region src/xlsx/worksheet.ts
/** Regex patterns for extracting various worksheet XML elements */
const mergecregex = /<(?:\w+:)?mergeCell ref=["'][A-Z0-9:]+['"]\s*[/]?>/g;
const hlinkregex = /<(?:\w+:)?hyperlink [^<>]*>/gm;
const dimregex = /"(\w*:\w*)"/;
const colregex = /<(?:\w+:)?col\b[^<>]*[/]?>/g;
const afregex = /<(?:\w:)?autoFilter[^>]*([/]|>([\s\S]*)<\/(?:\w:)?autoFilter)>/g;
const marginregex = /<(?:\w+:)?pageMargins[^<>]*\/>/g;
const sheetViewRegex = /<(?:\w+:)?sheetView\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetView>)/;
/** Parse the <dimension> element to set the sheet reference range */
function parseWorksheetXml_dim(ws, s) {
	const d = safeDecodeRange(s);
	if (d.s.r <= d.e.r && d.s.c <= d.e.c && d.s.r >= 0 && d.s.c >= 0) ws["!ref"] = encodeRange(d);
}
/** Parse <pageMargins> attributes with defaults matching Excel's standard margins */
function parseWorksheetXml_margins(tag) {
	return {
		left: parseFloat(tag.left) || .7,
		right: parseFloat(tag.right) || .7,
		top: parseFloat(tag.top) || .75,
		bottom: parseFloat(tag.bottom) || .75,
		header: parseFloat(tag.header) || .3,
		footer: parseFloat(tag.footer) || .3
	};
}
/** Parse <autoFilter> element extracting the filter reference range */
function parseWorksheetXml_autofilter(data, opts) {
	return { ref: parseXmlTag(data.match(/<[^>]*>/)?.[0] || "", void 0, void 0, opts).ref || "" };
}
/** Parse <col> elements to populate column width and hidden state */
function parseWorksheetXml_cols(columns, cols, opts) {
	for (let i = 0; i < cols.length; ++i) {
		const tag = parseXmlTag(cols[i], void 0, void 0, opts);
		if (!tag.min || !tag.max) continue;
		const min = parseInt(tag.min, 10) - 1;
		const max = parseInt(tag.max, 10) - 1;
		const width = tag.width ? parseFloat(tag.width) : void 0;
		const hidden = tag.hidden === "1";
		for (let j = min; j <= max; ++j) {
			if (!columns[j]) columns[j] = {};
			if (width !== void 0) columns[j].width = width;
			if (hidden) columns[j].hidden = true;
		}
	}
}
function parseWorksheetXml_views(data, opts) {
	const match = data.match(sheetViewRegex);
	if (!match) return;
	const pane = match[0].match(/<(?:\w+:)?pane\b[^>]*\/>/);
	if (!pane) return;
	const tag = parseXmlTag(pane[0], void 0, void 0, opts);
	if (tag.state !== "frozen") return;
	const view = { state: "frozen" };
	if (tag.xSplit) view.xSplit = parseFloat(tag.xSplit);
	if (tag.ySplit) view.ySplit = parseFloat(tag.ySplit);
	if (tag.topLeftCell) view.topLeftCell = tag.topLeftCell;
	if (tag.activePane === "topRight" || tag.activePane === "bottomLeft" || tag.activePane === "bottomRight") view.activePane = tag.activePane;
	return [view];
}
/** Parse <hyperlink> elements and attach link objects to the corresponding cells */
function parseWorksheetXml_hlinks(s, hlinks, rels, opts) {
	for (let i = 0; i < hlinks.length; ++i) {
		const tag = parseXmlTag(hlinks[i], void 0, void 0, opts);
		if (!tag.ref) continue;
		const rng = safeDecodeRange(tag.ref);
		for (let R = rng.s.r; R <= rng.e.r; ++R) for (let C = rng.s.c; C <= rng.e.c; ++C) {
			const addr = encodeCell({
				r: R,
				c: C
			});
			const dense = s["!data"] != null;
			let cell;
			if (dense) {
				if (!s["!data"][R]) s["!data"][R] = [];
				cell = s["!data"][R][C];
			} else cell = s[addr];
			if (!cell) {
				cell = {
					t: "z",
					v: void 0
				};
				if (dense) s["!data"][R][C] = cell;
				else s[addr] = cell;
			}
			let target = "";
			if (tag.id) {
				const rel = rels["!id"]?.[tag.id];
				if (rel) target = rel.Target;
			}
			if (tag.location) target += "#" + tag.location;
			cell.l = { Target: target };
			// NAYIVE: the tooltip is an XML attribute, so it arrives escaped
			// ("Ayuda en l&#237;nea"). Unescape it here as every other text-bearing
			// attribute in this parser does, or the accents survive reading only to
			// be escaped a second time on the way out.
			if (tag.tooltip) cell.l.Tooltip = unescapeXml(tag.tooltip);
		}
	}
}
/** Regex to match <c> (cell) elements, capturing inner content */
const cellregex = /<(?:\w+:)?c\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
/**
* Parse the <sheetData> XML into cell objects within the worksheet.
* Processes rows and cells, handling all cell types (string, number, boolean, etc.).
*/
function parseSheetData(sdata, s, opts, refguess, _themes, styles, wb) {
	const dense = s["!data"] != null;
	const date1904 = wb?.WBProps?.date1904;
	const maxWorksheetRows = xmlOptionLimit(opts.maxWorksheetRows, DEFAULT_MAX_WORKSHEET_ROWS, "maxWorksheetRows");
	const maxWorksheetCells = xmlOptionLimit(opts.maxWorksheetCells, DEFAULT_MAX_WORKSHEET_CELLS, "maxWorksheetCells");
	let rowCount = 0;
	let cellCount = 0;
	const rows = sdata.split(/<\/(?:\w+:)?row>/);
	for (let ri = 0; ri < rows.length; ++ri) {
		const rowStr = rows[ri];
		if (!rowStr) continue;
		const rowTagMatch = rowStr.match(/<(?:\w+:)?row\b[^>]*>/);
		if (!rowTagMatch) continue;
		assertXmlCountWithinLimit("worksheet row", ++rowCount, maxWorksheetRows);
		const rowTag = parseXmlTag(rowTagMatch[0], void 0, void 0, opts);
		const R = parseInt(rowTag.r, 10) - 1;
		if (isNaN(R)) continue;
		if (rowTag.ht || rowTag.hidden) {
			if (!s["!rows"]) s["!rows"] = [];
			if (!s["!rows"][R]) s["!rows"][R] = {};
			if (rowTag.ht) s["!rows"][R].hpt = parseFloat(rowTag.ht);
			if (rowTag.hidden === "1") s["!rows"][R].hidden = true;
		}
		if (opts.sheetRows && R >= opts.sheetRows) continue;
		cellregex.lastIndex = 0;
		let cellMatch;
		while (cellMatch = cellregex.exec(rowStr)) {
			assertXmlCountWithinLimit("worksheet cell", ++cellCount, maxWorksheetCells);
			const cellTag = parseXmlTag(cellMatch[0].match(/<(?:\w+:)?c\b[^>]*/)?.[0] + ">" || "", void 0, void 0, opts);
			const ref = cellTag.r;
			if (!ref) continue;
			let C = 0;
			for (let ci = 0; ci < ref.length; ++ci) {
				const cc = ref.charCodeAt(ci);
				if (cc >= 65 && cc <= 90) C = 26 * C + (cc - 64);
				else break;
			}
			C -= 1;
			if (R < refguess.s.r) refguess.s.r = R;
			if (R > refguess.e.r) refguess.e.r = R;
			if (C < refguess.s.c) refguess.s.c = C;
			if (C > refguess.e.c) refguess.e.c = C;
			const cellType = cellTag.t || "n";
			const cellStyle = cellTag.s ? parseInt(cellTag.s, 10) : 0;
			const cellValue = cellMatch[1] || "";
			let cell;
			const vMatch = cellValue.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
			const fMatch = cellValue.match(/<(?:\w+:)?f[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/);
			const isMatch = cellValue.match(/<(?:\w+:)?is>([\s\S]*?)<\/(?:\w+:)?is>/);
			const v = vMatch ? vMatch[1] : null;
			switch (cellType) {
				case "s":
					if (v !== null) {
						const idx = parseInt(v, 10);
						cell = {
							t: "s",
							v: ""
						};
						cell._sstIdx = idx;
					} else cell = { t: "z" };
					break;
				case "str":
					cell = {
						t: "s",
						v: v ? unescapeXml(v) : ""
					};
					break;
				case "inlineStr":
					if (isMatch) {
						const tMatch = isMatch[1].match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/);
						cell = {
							t: "s",
							v: tMatch ? unescapeXml(tMatch[1]) : ""
						};
					} else cell = {
						t: "s",
						v: ""
					};
					break;
				case "b":
					cell = {
						t: "b",
						v: v === "1"
					};
					break;
				case "e":
					cell = {
						t: "e",
						v: v ? parseInt(v, 10) || 0 : 0
					};
					cell.w = v || "";
					break;
				case "d":
					if (v) cell = {
						t: "d",
						v: new Date(v)
					};
					else cell = { t: "z" };
					break;
				default:
					if (v !== null) cell = {
						t: "n",
						v: parseFloat(v)
					};
					else {
						if (!opts.sheetStubs) continue;
						cell = { t: "z" };
					}
					break;
			}
			if (cellStyle > 0 && styles) {
				const xf = styles.CellXf[cellStyle];
				if (xf) {
					cell.XF = { numFmtId: xf.numFmtId };
					if (opts.cellStyles) {
						const style = getStyleFromXf(styles, cellStyle);
						if (style) cell.s = style;
					}
					if (opts.cellNF) {
						const nf = styles.NumberFmt[xf.numFmtId] || formatTable[xf.numFmtId];
						if (nf) cell.z = nf;
					}
				}
			}
			if (fMatch && opts.cellFormula !== false) {
				cell.f = unescapeXml(fMatch[1]);
				const fTag = parseXmlTag(cellValue.match(/<(?:\w+:)?f[^>]*/)?.[0] + ">" || "", void 0, void 0, opts);
				if (fTag.t === "shared" && fTag.si != null) {}
				if (fTag.t === "array" && fTag.ref) {
					cell.F = fTag.ref;
					cell.D = fTag.dt === "1";
				}
			}
			if (opts.cellText !== false) {
				if (cell.t === "n") {
					const nfmt = cell.z || cell.XF && cell.XF.numFmtId != null && styles?.NumberFmt[cell.XF.numFmtId] || formatTable[cell.XF && cell.XF.numFmtId || 0];
					if (nfmt) try {
						cell.w = formatNumber(nfmt, cell.v, { date1904 });
					} catch {}
					if (opts.cellDates && cell.XF) {
						const fmtStr = nfmt || formatTable[cell.XF.numFmtId || 0] || "";
						const fmtKind = typeof fmtStr === "string" ? getDateTimeFormatKind(fmtStr) : "none";
						if (fmtKind !== "none" && fmtKind !== "time" && typeof cell.v === "number") {
							cell.t = "d";
							cell.v = serialNumberToDate(cell.v, date1904);
						}
					}
				}
			}
			if (dense) {
				if (!s["!data"][R]) s["!data"][R] = [];
				s["!data"][R][C] = cell;
			} else s[ref] = cell;
		}
	}
}
/**
* Resolve shared string references in a worksheet by replacing SST index
* placeholders with actual string values from the shared string table.
*
* @param s - Worksheet whose cells may contain _sstIdx placeholders
* @param sst - Parsed Shared String Table
* @param opts - Options controlling HTML output (cellHTML)
*/
function resolveSharedStrings(s, sst, opts) {
	if (s["!data"] != null) {
		const data = s["!data"];
		for (let R = 0; R < data.length; ++R) {
			if (!data[R]) continue;
			for (let C = 0; C < data[R].length; ++C) {
				const cell = data[R][C];
				if (!cell || cell._sstIdx === void 0) continue;
				const idx = cell._sstIdx;
				delete cell._sstIdx;
				if (sst[idx]) {
					cell.v = sst[idx].t;
					if (opts.cellHTML !== false && sst[idx].h) cell.h = sst[idx].h;
					if (sst[idx].r) cell.r = sst[idx].r;
				}
			}
		}
	} else for (const ref of Object.keys(s)) {
		if (ref.charAt(0) === "!") continue;
		const cell = s[ref];
		if (!cell || cell._sstIdx === void 0) continue;
		const idx = cell._sstIdx;
		delete cell._sstIdx;
		if (sst[idx]) {
			cell.v = sst[idx].t;
			if (opts.cellHTML !== false && sst[idx].h) cell.h = sst[idx].h;
			if (sst[idx].r) cell.r = sst[idx].r;
		}
	}
}
/**
* Parse a worksheet XML file into a WorkSheet object.
*
* Extracts dimensions, columns, cell data, merges, hyperlinks, autofilter,
* margins, and legacy drawing references from the sheet XML.
*
* @param data - Raw XML string of the sheet file (e.g. sheet1.xml)
* @param opts - Parsing options (dense, sheetRows, cellHTML, cellDates, etc.)
* @param _idx - Sheet index (unused, reserved)
* @param rels - Relationships for resolving hyperlink targets
* @param wb - Parsed workbook properties (for date1904 flag)
* @param _themes - Theme data (reserved for theme color resolution)
* @param styles - Parsed styles data for number format resolution
* @returns Parsed WorkSheet object
*/
function parseWorksheetXml(data, opts, _idx, rels, wb, _themes, styles) {
	if (!data) return {};
	if (!opts) opts = {};
	assertXmlPartLimits("worksheet.xml", data, opts);
	if (!rels) rels = { "!id": {} };
	const s = opts.dense ? { "!data": [] } : {};
	const refguess = {
		s: {
			r: 2e6,
			c: 2e6
		},
		e: {
			r: 0,
			c: 0
		}
	};
	let data1 = "";
	let data2 = "";
	const sdMatch = data.match(/<(?:\w+:)?sheetData[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/);
	if (sdMatch) {
		data1 = data.slice(0, sdMatch.index);
		data2 = data.slice(sdMatch.index + sdMatch[0].length);
	} else data1 = data2 = data;
	const ridx = (data1.match(/<(?:\w*:)?dimension/) || { index: -1 }).index;
	if (ridx > 0) {
		const ref = data1.slice(ridx, ridx + 50).match(dimregex);
		if (ref && !opts.nodim) parseWorksheetXml_dim(s, ref[1]);
	}
	const columns = [];
	if (opts.cellStyles) {
		const cols = data1.match(colregex);
		if (cols) parseWorksheetXml_cols(columns, cols, opts);
		const views = parseWorksheetXml_views(data1, opts);
		if (views) s["!views"] = views;
	}
	if (sdMatch) parseSheetData(sdMatch[1], s, opts, refguess, _themes, styles, wb);
	const afilter = data2.match(afregex);
	if (afilter) s["!autofilter"] = parseWorksheetXml_autofilter(afilter[0], opts);
	const merges = [];
	const _merge = data2.match(mergecregex);
	if (_merge) for (let i = 0; i < _merge.length; ++i) merges[i] = safeDecodeRange(_merge[i].slice(_merge[i].indexOf("=") + 2));
	const hlink = data2.match(hlinkregex);
	if (hlink) parseWorksheetXml_hlinks(s, hlink, rels, opts);
	const margins = data2.match(marginregex);
	if (margins) s["!margins"] = parseWorksheetXml_margins(parseXmlTag(margins[0], void 0, void 0, opts));
	const legm = data2.match(/legacyDrawing r:id="(.*?)"/);
	if (legm) s["!legrel"] = legm[1];
	if (opts.nodim) refguess.s.c = refguess.s.r = 0;
	if (!s["!ref"] && refguess.e.c >= refguess.s.c && refguess.e.r >= refguess.s.r) s["!ref"] = encodeRange(refguess);
	if (opts.sheetRows > 0 && s["!ref"]) {
		const tmpref = safeDecodeRange(s["!ref"]);
		if (opts.sheetRows <= tmpref.e.r) {
			tmpref.e.r = opts.sheetRows - 1;
			if (tmpref.e.r > refguess.e.r) tmpref.e.r = refguess.e.r;
			if (tmpref.e.r < tmpref.s.r) tmpref.s.r = tmpref.e.r;
			if (tmpref.e.c > refguess.e.c) tmpref.e.c = refguess.e.c;
			if (tmpref.e.c < tmpref.s.c) tmpref.s.c = tmpref.e.c;
			s["!fullref"] = s["!ref"];
			s["!ref"] = encodeRange(tmpref);
		}
	}
	if (columns.length > 0) s["!cols"] = columns;
	if (merges.length > 0) s["!merges"] = merges;
	return s;
}
/** Generate <mergeCells> XML from an array of merge ranges */
function writeWorksheetXml_merges(merges) {
	if (merges.length === 0) return "";
	const lines = ["<mergeCells count=\"" + merges.length + "\">"];
	for (let i = 0; i < merges.length; ++i) lines.push("<mergeCell ref=\"" + encodeRange(merges[i]) + "\"/>");
	lines.push("</mergeCells>");
	return lines.join("");
}
function getFrozenPaneTopLeftCell(view) {
	if (view.topLeftCell) return view.topLeftCell;
	const xSplit = view.xSplit || 0;
	const ySplit = view.ySplit || 0;
	if (xSplit <= 0 && ySplit <= 0) return;
	return encodeCell({
		r: ySplit,
		c: xSplit
	});
}
function getFrozenPaneActivePane(view) {
	if (view.activePane) return view.activePane;
	if (view.xSplit && view.ySplit) return "bottomRight";
	return view.xSplit ? "topRight" : "bottomLeft";
}
function writeWorksheetXml_sheetViews(ws, idx) {
	const view = ws["!views"]?.find((item) => item?.state === "frozen" && ((item.xSplit || 0) > 0 || (item.ySplit || 0) > 0));
	const attrs = idx === 0 ? " tabSelected=\"1\"" : "";
	if (!view) return "<sheetViews><sheetView workbookViewId=\"0\"" + attrs + "/></sheetViews>";
	const paneAttrs = {
		state: "frozen",
		activePane: getFrozenPaneActivePane(view)
	};
	if (view.xSplit) paneAttrs.xSplit = String(view.xSplit);
	if (view.ySplit) paneAttrs.ySplit = String(view.ySplit);
	const topLeftCell = getFrozenPaneTopLeftCell(view);
	if (topLeftCell) paneAttrs.topLeftCell = topLeftCell;
	const pane = writeXmlElement("pane", null, paneAttrs);
	const selection = writeXmlElement("selection", null, { pane: paneAttrs.activePane });
	return "<sheetViews><sheetView workbookViewId=\"0\"" + attrs + ">" + pane + selection + "</sheetView></sheetViews>";
}
/**
* Write a worksheet as XML.
*
* Serializes cell data, row properties, column definitions, merged cells,
* autofilter, and page margins into a complete sheet XML document.
*
* @param ws - WorkSheet to serialize
* @param opts - Write options (cellDates, etc.)
* @param _idx - Sheet index (0-based), used to set tabSelected on the first sheet
* @param _rels - Relationships object (reserved for hyperlink writing)
* @param _wb - WorkBook reference (reserved)
* @returns Complete worksheet XML string
*/
function writeWorksheetXml(ws, opts, _idx, _rels, _wb) {
	const lines = [XML_HEADER];
	lines.push(writeXmlElement("worksheet", null, {
		xmlns: XMLNS_main[0],
		"xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
	}));
	const ref = ws["!ref"] || "A1";
	lines.push("<dimension ref=\"" + ref + "\"/>");
	lines.push(writeWorksheetXml_sheetViews(ws, _idx));
	lines.push("<sheetFormatPr defaultRowHeight=\"15\"/>");
	if (ws["!cols"]) {
		lines.push("<cols>");
		for (let i = 0; i < ws["!cols"].length; ++i) {
			if (!ws["!cols"][i]) continue;
			const col = ws["!cols"][i];
			const attrs = {
				min: String(i + 1),
				max: String(i + 1)
			};
			if (col.width) attrs.width = String(col.width);
			else attrs.width = "9.140625";
			if (col.hidden) attrs.hidden = "1";
			attrs.customWidth = "1";
			lines.push(writeXmlElement("col", null, attrs));
		}
		lines.push("</cols>");
	}
	lines.push("<sheetData>");
	const dense = ws["!data"] != null;
	const range = safeDecodeRange(ref);
	for (let rowIdx = range.s.r; rowIdx <= range.e.r; ++rowIdx) {
		const row_cells = [];
		for (let colIdx = range.s.c; colIdx <= range.e.c; ++colIdx) {
			let cell;
			if (dense) cell = ws["!data"]?.[rowIdx]?.[colIdx];
			else cell = ws[encodeCell({
				r: rowIdx,
				c: colIdx
			})];
			const styleIndex = cell ? getCellStyleIndex(opts, cell) : void 0;
			if (!cell || cell.t === "z" && styleIndex == null) continue;
			const addr = encodeCell({
				r: rowIdx,
				c: colIdx
			});
			let cellValueStr = "";
			let cellTypeAttr = "";
			switch (cell.t) {
				case "b":
					cellValueStr = cell.v ? "1" : "0";
					cellTypeAttr = "b";
					break;
				case "n":
					cellValueStr = String(cell.v);
					break;
				case "e":
					cellValueStr = String(cell.v);
					cellTypeAttr = "e";
					break;
				case "d":
					if (opts.cellDates) {
						cellValueStr = cell.v.toISOString();
						cellTypeAttr = "d";
					} else cellValueStr = String(dateToSerialNumber(cell.v));
					break;
				case "s":
					cellValueStr = escapeXml(String(cell.v));
					cellTypeAttr = "str";
					break;
			}
			let cellXml = "<c r=\"" + addr + "\"";
			if (cellTypeAttr) cellXml += " t=\"" + cellTypeAttr + "\"";
			if (styleIndex != null && styleIndex > 0) cellXml += " s=\"" + styleIndex + "\"";
			if (!cell.f && cellValueStr === "") {
				cellXml += "/>";
				row_cells.push(cellXml);
				continue;
			}
			cellXml += ">";
			if (cell.f) {
				cellXml += "<f";
				if (cell.F) cellXml += " ref=\"" + cell.F + "\" t=\"array\"";
				cellXml += ">" + escapeXml(cell.f) + "</f>";
			}
			if (cellValueStr !== "") cellXml += "<v>" + cellValueStr + "</v>";
			cellXml += "</c>";
			row_cells.push(cellXml);
		}
		if (row_cells.length > 0) {
			let rowTag = "<row r=\"" + (rowIdx + 1) + "\"";
			if (ws["!rows"]?.[rowIdx]) {
				if (ws["!rows"][rowIdx].hpt) rowTag += " ht=\"" + ws["!rows"][rowIdx].hpt + "\" customHeight=\"1\"";
				if (ws["!rows"][rowIdx].hidden) rowTag += " hidden=\"1\"";
			}
			rowTag += ">";
			lines.push(rowTag);
			lines.push(row_cells.join(""));
			lines.push("</row>");
		}
	}
	lines.push("</sheetData>");
	// NAYIVE: CT_Worksheet is a *sequence* — a reader is entitled to reject a file
	// whose elements are out of order, and Excel answers such a file with the
	// "we found a problem, do you want us to repair it" dialog. The order below is
	// the schema's: autoFilter, mergeCells, conditionalFormatting, dataValidations,
	// pageMargins, drawing, tableParts, extLst. (autoFilter and mergeCells used to
	// be emitted the other way round here, which only became reachable once Calc
	// started writing !autofilter back.)
	if (ws["!autofilter"]) lines.push("<autoFilter ref=\"" + ws["!autofilter"].ref + "\"/>");
	if (ws["!merges"] && ws["!merges"].length > 0) lines.push(writeWorksheetXml_merges(ws["!merges"]));

	// NAYIVE: fragments this library has no model for, captured verbatim from the
	// file we opened and put back where the schema says they go. `raw.refs` are the
	// parts they point at (a drawing, a table); each gets a fresh relationship id
	// here so it cannot collide with the ones written for comments above.
	const raw = ws["!raw"] || {};
	if (raw.cf) lines.push(raw.cf);
	if (raw.dv) lines.push(raw.dv);

	// NAYIVE: hyperlinks. This library parsed <hyperlink> and never wrote one back
	// (the rels argument was marked "reserved for hyperlink writing"), so a link
	// survived being read and was dropped by the very next save.
	//
	// Two kinds, and only one of them needs a relationship: an external target is
	// a rel with TargetMode="External" referenced by r:id, while a jump inside the
	// workbook ("#Hoja2!A1") is just a `location` attribute. A target can carry
	// both — "https://x/y#frag" — so it is split on the last '#'.
	if (_rels) {
		const links = [];
		const relByTarget = new Map();
		const eachCell = (addr, cell) => {
			if (!cell || !cell.l || !cell.l.Target) return;
			// A target beginning with '#' is a jump inside the workbook and becomes a
			// `location`; anything else goes out whole as an external relationship,
			// fragment included. Splitting a URL at its '#' would also be valid OOXML
			// and resolve the same, but it would come back out of the reader in a
			// different shape than it went in, and a save should not reword a link.
			const full = String(cell.l.Target);
			const internal = full.charAt(0) === "#";
			const target = internal ? "" : full;
			const location = internal ? full.slice(1) : "";
			let attrs = "ref=\"" + addr + "\"";
			if (target) {
				let rId = relByTarget.get(target);
				if (!rId) {
					// Escaped here, not in the writer: formatXmlAttributes does not escape
					// attribute values, and a query string ("?a=1&b=2") would otherwise
					// put a bare & into the .rels file and make it unparseable.
					rId = "rId" + addRelationship(_rels, -1, escapeXml(target), RELS.HLINK, "External");
					relByTarget.set(target, rId);
				}
				attrs += " r:id=\"" + rId + "\"";
			}
			if (location) attrs += " location=\"" + escapeXml(location) + "\"";
			if (cell.l.Tooltip) attrs += " tooltip=\"" + escapeXml(String(cell.l.Tooltip)) + "\"";
			links.push("<hyperlink " + attrs + "/>");
		};

		if (ws["!data"] != null) {
			const d = ws["!data"];
			for (let R = 0; R < d.length; ++R) if (d[R]) for (let C = 0; C < d[R].length; ++C)
				eachCell(encodeCell({ r: R, c: C }), d[R][C]);
		} else for (const k of Object.keys(ws)) {
			if (k.charAt(0) !== "!") eachCell(k, ws[k]);
		}

		if (links.length) lines.push("<hyperlinks xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
			+ links.join("") + "</hyperlinks>");
	}

	if (ws["!margins"]) {
		const margins = ws["!margins"];
		lines.push(writeXmlElement("pageMargins", null, {
			left: String(margins.left || .7),
			right: String(margins.right || .7),
			top: String(margins.top || .75),
			bottom: String(margins.bottom || .75),
			header: String(margins.header || .3),
			footer: String(margins.footer || .3)
		}));
	}

	if (raw.refs && raw.refs.length && _rels) {
		const RNS = " xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";
		const tableIds = [];
		for (const ref of raw.refs) {
			if (!ref || !ref.target || !ref.type) continue;
			// Belt and braces: a relationship whose part is not in the archive we are
			// copying from would leave a dangling reference and an unreadable file.
			if (opts.preserve && !opts.preserve.files[String(ref.target).replace(/^\//, "")]) continue;
			const rId = "rId" + addRelationship(_rels, -1, ref.target, ref.type);
			if (ref.tag === "drawing") lines.push("<drawing" + RNS + " r:id=\"" + rId + "\"/>");
			else if (ref.tag === "tablePart") tableIds.push(rId);
		}
		if (tableIds.length) lines.push("<tableParts" + RNS + " count=\"" + tableIds.length + "\">"
			+ tableIds.map((id) => "<tablePart r:id=\"" + id + "\"/>").join("") + "</tableParts>");
	}

	if (raw.extLst) lines.push(raw.extLst);
	lines.push("</worksheet>");
	lines[1] = lines[1].replace("/>", ">");
	return lines.join("");
}

//#endregion
//#region src/utils/helpers.ts
/**
* Find all occurrences of an XML tag in a string, ignoring namespace prefixes.
*
* Builds a regex that matches `<tag>...</tag>` or `<ns:tag>...</ns:tag>`
* and returns all matches. Handles attributes and nested content via [\s\S]*?.
*
* @param xmlString - The XML string to search
* @param tag - The local tag name (without namespace prefix)
* @returns Array of matched tag strings, or null if no matches
*/
function matchXmlTagGlobal(xmlString, tag) {
	const re = new RegExp("<(?:\\w+:)?" + tag + "[\\s>][\\s\\S]*?<\\/(?:\\w+:)?" + tag + ">", "g");
	return xmlString.match(re);
}
/**
* Find the first occurrence of an XML tag in a string, ignoring namespace prefixes.
*
* Convenience wrapper around {@link matchXmlTagGlobal} that returns only the first match.
*
* @param xmlString - The XML string to search
* @param tag - The local tag name (without namespace prefix)
* @returns The first matched tag string, or null if not found
*/
function matchXmlTagFirst(xmlString, tag) {
	const m = matchXmlTagGlobal(xmlString, tag);
	return m ? m[0] : null;
}

//#endregion
//#region src/xlsx/comments.ts
/**
* Insert parsed comments into a worksheet, attaching them to the appropriate cells.
*
* Creates empty cells if needed and expands the sheet range to include comment cells.
* When inserting threaded comments, any existing legacy comments on the same cell are removed.
*
* @param sheet - Target worksheet
* @param comments - Array of parsed comment entries
* @param threaded - Whether these are threaded (modern) comments
* @param people - Optional people list for resolving threaded comment author IDs to display names
*/
function insertCommentsIntoSheet(sheet, comments, threaded, people) {
	const dense = sheet["!data"] != null;
	for (const comment of comments) {
		const r = decodeCell(comment.ref);
		if (r.r < 0 || r.c < 0) continue;
		let cell;
		if (dense) {
			if (!sheet["!data"][r.r]) sheet["!data"][r.r] = [];
			cell = sheet["!data"][r.r][r.c];
		} else cell = sheet[comment.ref];
		if (!cell) {
			cell = { t: "z" };
			if (dense) sheet["!data"][r.r][r.c] = cell;
			else sheet[comment.ref] = cell;
			const range = safeDecodeRange(sheet["!ref"] || "BDWGO1000001:A1");
			if (range.s.r > r.r) range.s.r = r.r;
			if (range.e.r < r.r) range.e.r = r.r;
			if (range.s.c > r.c) range.s.c = r.c;
			if (range.e.c < r.c) range.e.c = r.c;
			sheet["!ref"] = encodeRange(range);
		}
		if (!cell.c) cell.c = [];
		const o = {
			a: comment.author,
			t: comment.t,
			r: comment.r,
			T: threaded
		};
		if (comment.h) o.h = comment.h;
		for (let i = cell.c.length - 1; i >= 0; --i) {
			if (!threaded && cell.c[i].T) return;
			if (threaded && !cell.c[i].T) cell.c.splice(i, 1);
		}
		if (threaded && people) {
			for (let i = 0; i < people.length; ++i) if (o.a === people[i].id) {
				o.a = people[i].name || o.a;
				break;
			}
		}
		cell.c.push(o);
	}
}
/** Parse a simple inline string item for comment text content */
function parse_si_simple(x) {
	if (!x) return {
		t: "",
		r: "",
		h: ""
	};
	const tMatch = x.match(/<(?:\w+:)?t[^>]*>([^<]*)<\/(?:\w+:)?t>/);
	const t = tMatch ? unescapeXml(tMatch[1]) : "";
	return {
		t,
		r: x,
		h: t
	};
}
/**
* Parse comments XML (ECMA-376 18.7 Comments).
*
* Extracts the author list and comment entries from a comments.xml part.
*
* @param data - Raw XML string of the comments file
* @param opts - Parsing options (sheetRows, cellHTML)
* @returns Array of parsed comment entries
*/
function parseCommentsXml(data, opts) {
	if (data.match(/<(?:\w+:)?comments\s*\/>/)) return [];
	const authors = [];
	const commentList = [];
	const authtag = matchXmlTagFirst(data, "authors");
	if (authtag) authtag.split(/<\/\w*:?author>/).forEach((x) => {
		if (x === "" || x.trim() === "") return;
		const a = x.match(/<(?:\w+:)?author\b[^<>]*>(.*)/);
		if (a) authors.push(a[1]);
	});
	const cmnttag = matchXmlTagFirst(data, "commentList");
	if (cmnttag) cmnttag.split(/<\/\w*:?comment>/).forEach((x) => {
		if (x === "" || x.trim() === "") return;
		const cm = x.match(/<(?:\w+:)?comment\b[^<>]*>/);
		if (!cm) return;
		const y = parseXmlTag(cm[0]);
		const comment = {
			author: y.authorId && authors[y.authorId] || "sheetjsghost",
			ref: y.ref,
			guid: y.guid,
			t: ""
		};
		const cell = decodeCell(y.ref);
		if (opts && opts.sheetRows && opts.sheetRows <= cell.r) return;
		const textMatch = matchXmlTagFirst(x, "text");
		const rt = textMatch ? parse_si_simple(textMatch) : {
			r: "",
			t: "",
			h: ""
		};
		comment.r = rt.r;
		if (rt.r === "<t></t>") {
			rt.t = "";
			rt.h = "";
		}
		comment.t = (rt.t || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (opts && opts.cellHTML) comment.h = rt.h;
		commentList.push(comment);
	});
	return commentList;
}
/**
* Write comments XML (ECMA-376 18.7).
*
* Serializes comment data into the legacy comments.xml format. For threaded comments,
* the text is flattened into "Comment:/Reply:" format for backward compatibility.
*
* @param data - Array of [cell_ref, comments_array] tuples
* @returns Complete comments.xml string
*/
function writeCommentsXml(data) {
	const o = [XML_HEADER, writeXmlElement("comments", null, { xmlns: XMLNS_main[0] })];
	const iauthor = [];
	o.push("<authors>");
	data.forEach((x) => {
		x[1].forEach((w) => {
			const a = escapeXml(w.a);
			if (iauthor.indexOf(a) === -1) {
				iauthor.push(a);
				o.push("<author>" + a + "</author>");
			}
			if (w.T && w.ID && iauthor.indexOf("tc=" + w.ID) === -1) {
				iauthor.push("tc=" + w.ID);
				o.push("<author>tc=" + w.ID + "</author>");
			}
		});
	});
	if (iauthor.length === 0) {
		iauthor.push("SheetJ5");
		o.push("<author>SheetJ5</author>");
	}
	o.push("</authors>");
	o.push("<commentList>");
	data.forEach((d) => {
		let lastauthor = 0;
		const ts = [];
		let tcnt = 0;
		if (d[1][0] && d[1][0].T && d[1][0].ID) lastauthor = iauthor.indexOf("tc=" + d[1][0].ID);
		d[1].forEach((c) => {
			if (c.a) lastauthor = iauthor.indexOf(escapeXml(c.a));
			if (c.T) ++tcnt;
			ts.push(c.t == null ? "" : escapeXml(c.t));
		});
		if (tcnt === 0) d[1].forEach((c) => {
			o.push("<comment ref=\"" + d[0] + "\" authorId=\"" + iauthor.indexOf(escapeXml(c.a)) + "\"><text>");
			o.push(writeXmlTag("t", c.t == null ? "" : escapeXml(c.t)));
			o.push("</text></comment>");
		});
		else {
			if (d[1][0] && d[1][0].T && d[1][0].ID) lastauthor = iauthor.indexOf("tc=" + d[1][0].ID);
			o.push("<comment ref=\"" + d[0] + "\" authorId=\"" + lastauthor + "\"><text>");
			let t = "Comment:\n    " + ts[0] + "\n";
			for (let i = 1; i < ts.length; ++i) t += "Reply:\n    " + ts[i] + "\n";
			o.push(writeXmlTag("t", escapeXml(t)));
			o.push("</text></comment>");
		}
	});
	o.push("</commentList>");
	if (o.length > 2) {
		o.push("</comments>");
		o[1] = o[1].replace("/>", ">");
	}
	return o.join("");
}
/**
* Parse threaded comments XML (MS-XLSX 2.1.17).
*
* Threaded comments are a modern Excel feature that supports reply chains.
* Each comment has a personId (author), optional parentId (reply), and text.
*
* @param data - Raw XML string of the threadedComment file
* @param opts - Parsing options
* @returns Array of parsed threaded comment entries
*/
function parseTcmntXml(data, _opts) {
	const out = [];
	let comment = {};
	let tidx = 0;
	const ignoredTags = /* @__PURE__ */ new Set([
		"<?xml",
		"<ThreadedComments",
		"</ThreadedComments>",
		"<mentions",
		"<mentions>",
		"</mentions>",
		"<extLst",
		"<extLst>",
		"</extLst>",
		"<extLst/>",
		"<ext",
		"</ext>"
	]);
	data.replace(XML_TAG_REGEX, function xml_tcmnt(x, idx) {
		const y = parseXmlTag(x);
		const tag = stripNamespace(y[0]);
		if (ignoredTags.has(tag)) return x;
		switch (tag) {
			case "<threadedComment":
				comment = {
					author: y.personId,
					guid: y.id,
					ref: y.ref,
					T: 1
				};
				break;
			case "</threadedComment>":
				if (comment.t != null) out.push(comment);
				break;
			case "<text>":
			case "<text":
				tidx = idx + x.length;
				break;
			case "</text>":
				comment.t = data.slice(tidx, idx).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
				break;
		}
		return x;
	});
	return out;
}
/**
* Write threaded comments XML (MS-XLSX 2.1.17).
*
* Generates GUIDs for each threaded comment using a deterministic counter.
* The first comment in a chain is the root; subsequent comments reference it via parentId.
*
* @param comments - Array of [cell_ref, comments_array] tuples
* @param people - Mutable people list (new authors are appended)
* @param opts - Options with tcid counter for generating unique GUIDs
* @returns Complete threadedComment XML string
*/
function writeTcmntXml(comments, people, opts) {
	const o = [XML_HEADER, writeXmlElement("ThreadedComments", null, { xmlns: XMLNS.TCMNT }).replace(/\/>/, ">")];
	comments.forEach((carr) => {
		let rootid = "";
		(carr[1] || []).forEach((c, idx) => {
			if (!c.T) {
				delete c.ID;
				return;
			}
			if (c.a && people.indexOf(c.a) === -1) people.push(c.a);
			const tcopts = {
				ref: carr[0],
				id: "{54EE7951-7262-4200-6969-" + ("000000000000" + opts.tcid++).slice(-12) + "}"
			};
			if (idx === 0) rootid = tcopts.id;
			else tcopts.parentId = rootid;
			c.ID = tcopts.id;
			if (c.a) tcopts.personId = "{54EE7950-7262-4200-6969-" + ("000000000000" + people.indexOf(c.a)).slice(-12) + "}";
			o.push(writeXmlElement("threadedComment", writeXmlTag("text", c.t || ""), tcopts));
		});
	});
	o.push("</ThreadedComments>");
	return o.join("");
}
/**
* Parse people XML (MS-XLSX 2.1.18).
*
* The people list maps person GUIDs to display names for threaded comment authorship.
*
* @param data - Raw XML string of the person.xml file
* @returns Array of person entries with name and id
*/
function parsePeopleXml(data) {
	const out = [];
	const ignoredTags = /* @__PURE__ */ new Set([
		"<?xml",
		"<personList",
		"</personList>",
		"</person>",
		"<extLst",
		"<extLst>",
		"</extLst>",
		"<extLst/>",
		"<ext",
		"</ext>"
	]);
	data.replace(XML_TAG_REGEX, function xml_people(x) {
		const y = parseXmlTag(x);
		const tag = stripNamespace(y[0]);
		if (ignoredTags.has(tag)) return x;
		switch (tag) {
			case "<person":
				out.push({
					name: y.displayname,
					id: y.id
				});
				break;
		}
		return x;
	});
	return out;
}
/**
* Write people XML for threaded comments authorship.
*
* @param people - Array of author display names
* @returns Complete person.xml string
*/
function writePeopleXml(people) {
	const o = [XML_HEADER, writeXmlElement("personList", null, {
		xmlns: XMLNS.TCMNT,
		"xmlns:x": XMLNS_main[0]
	}).replace(/\/>/, ">")];
	people.forEach((person, idx) => {
		o.push(writeXmlElement("person", null, {
			displayName: person,
			id: "{54EE7950-7262-4200-6969-" + ("000000000000" + idx).slice(-12) + "}",
			userId: person,
			providerId: "None"
		}));
	});
	o.push("</personList>");
	return o.join("");
}

//#endregion
//#region src/xlsx/vml.ts
/** VML XML namespace declarations for Microsoft Office drawing elements */
const XLMLNS = {
	v: "urn:schemas-microsoft-com:vml",
	o: "urn:schemas-microsoft-com:office:office",
	x: "urn:schemas-microsoft-com:office:excel",
	mv: "http://macVmlSchemaUri"
};
/**
* Parse VML drawings to extract comment visibility and position.
*
* VML (Vector Markup Language) is the legacy drawing format used by Excel to
* define comment box shapes. Each <v:shape> with ObjectType="Note" corresponds
* to a comment, and its <Visible> element determines if the comment is shown.
*
* @param data - Raw VML XML string
* @param sheet - Worksheet to update with comment visibility
* @param comments - Array of comment references for fallback positioning
*/
function parseVml(data, sheet, comments) {
	let cidx = 0;
	(matchXmlTagGlobal(data, "(?:shape|rect)") || []).forEach((m) => {
		let type = "";
		let hidden = true;
		let aidx = -1;
		let R = -1, C = -1;
		m.replace(XML_TAG_REGEX, function(x, idx) {
			const y = parseXmlTag(x);
			switch (stripNamespace(y[0])) {
				case "<ClientData":
					if (y.ObjectType) type = y.ObjectType;
					break;
				case "<Visible":
				case "<Visible/>":
					hidden = false;
					break;
				case "<Row":
				case "<Row>":
					aidx = idx + x.length;
					break;
				case "</Row>":
					R = +m.slice(aidx, idx).trim();
					break;
				case "<Column":
				case "<Column>":
					aidx = idx + x.length;
					break;
				case "</Column>":
					C = +m.slice(aidx, idx).trim();
					break;
			}
			return "";
		});
		switch (type) {
			case "Note": {
				const ref = R >= 0 && C >= 0 ? encodeCell({
					r: R,
					c: C
				}) : comments[cidx]?.ref;
				const dense = sheet["!data"] != null;
				let cell;
				if (dense) cell = sheet["!data"]?.[R]?.[C];
				else cell = sheet[ref];
				if (cell && cell.c) cell.c.hidden = hidden;
				++cidx;
				break;
			}
		}
	});
}
/** Format an object of attributes as XML attribute string (e.g. ' key="value"') */
function formatXmlAttributes(h) {
	return Object.keys(h).map((k) => " " + k + "=\"" + h[k] + "\"").join("");
}
/** Generate VML XML for a single comment shape */
function writeVmlComment(x, _shapeid) {
	const c = decodeCell(x[0]);
	const fillopts = {
		color2: "#BEFF82",
		type: "gradient"
	};
	if (fillopts.type === "gradient") fillopts.angle = "-180";
	const fillxml = writeXmlElement("v:fill", fillopts.type === "gradient" ? writeXmlElement("o:fill", null, {
		type: "gradientUnscaled",
		"v:ext": "view"
	}) : null, fillopts);
	return [
		"<v:shape" + formatXmlAttributes({
			id: "_x0000_s" + _shapeid,
			type: "#_x0000_t202",
			style: "position:absolute; margin-left:80pt;margin-top:5pt;width:104pt;height:64pt;z-index:10" + (x[1].hidden ? ";visibility:hidden" : ""),
			fillcolor: "#ECFAD4",
			strokecolor: "#edeaa1"
		}) + ">",
		fillxml,
		writeXmlElement("v:shadow", null, {
			on: "t",
			obscured: "t"
		}),
		writeXmlElement("v:path", null, { "o:connecttype": "none" }),
		"<v:textbox><div style=\"text-align:left\"></div></v:textbox>",
		"<x:ClientData ObjectType=\"Note\">",
		"<x:MoveWithCells/>",
		"<x:SizeWithCells/>",
		writeXmlTag("x:Anchor", [
			c.c + 1,
			0,
			c.r + 1,
			0,
			c.c + 3,
			20,
			c.r + 5,
			20
		].join(",")),
		writeXmlTag("x:AutoFill", "False"),
		writeXmlTag("x:Row", String(c.r)),
		writeXmlTag("x:Column", String(c.c)),
		x[1].hidden ? "" : "<x:Visible/>",
		"</x:ClientData>",
		"</v:shape>"
	].join("");
}
/**
* Write VML XML for all comment shapes on a sheet.
*
* VML is required for backward-compatible comment rendering in Excel.
* Each comment gets a text-box shape positioned relative to its cell.
*
* @param rId - Sheet relationship ID (used for shape ID namespace partitioning)
* @param comments - Array of [cell_ref, comment_data] tuples
* @returns Complete VML XML string
*/
function writeVml(rId, comments) {
	const csize = [21600, 21600];
	const bbox = [
		"m0,0l0",
		csize[1],
		csize[0],
		csize[1],
		csize[0],
		"0xe"
	].join(",");
	const o = [writeXmlElement("xml", null, {
		"xmlns:v": XLMLNS.v,
		"xmlns:o": XLMLNS.o,
		"xmlns:x": XLMLNS.x,
		"xmlns:mv": XLMLNS.mv
	}).replace(/\/>/, ">"), writeXmlElement("o:shapelayout", writeXmlElement("o:idmap", null, {
		"v:ext": "edit",
		data: String(rId)
	}), { "v:ext": "edit" })];
	let _shapeid = 65536 * rId;
	const _comments = comments || [];
	if (_comments.length > 0) o.push(writeXmlElement("v:shapetype", [writeXmlElement("v:stroke", null, { joinstyle: "miter" }), writeXmlElement("v:path", null, {
		gradientshapeok: "t",
		"o:connecttype": "rect"
	})].join(""), {
		id: "_x0000_t202",
		coordsize: csize.join(","),
		"o:spt": "202",
		path: bbox
	}));
	_comments.forEach((x) => {
		++_shapeid;
		o.push(writeVmlComment(x, _shapeid));
	});
	o.push("</xml>");
	return o.join("");
}

//#endregion
//#region src/xlsx/metadata.ts
/**
* Parse metadata XML (ECMA-376 18.9 / MS-XLSX extensions).
*
* Metadata provides additional cell-level information such as dynamic array
* properties (XLDAPR) and rich data types. The XML contains:
* - metadataTypes: type definitions
* - futureMetadata: type-specific data (e.g. rich value offsets)
* - cellMetadata / valueMetadata: per-cell type+index references
*
* @param data - Raw XML string of metadata.xml
* @param opts - Parsing options
* @returns Parsed metadata structure
*/
function parseMetadataXml(data, _opts) {
	const out = {
		Types: [],
		Cell: [],
		Value: []
	};
	if (!data) return out;
	let metatype = 2;
	let lastmeta;
	const ignoredTags = /* @__PURE__ */ new Set([
		"<?xml",
		"<metadata",
		"</metadata>",
		"<metadataTypes",
		"</metadataTypes>",
		"</metadataType>",
		"</futureMetadata>",
		"<bk>",
		"</bk>",
		"</rc>",
		"<extLst",
		"<extLst>",
		"</extLst>",
		"<extLst/>",
		"<ext",
		"</ext>"
	]);
	data.replace(XML_TAG_REGEX, function(x) {
		const y = parseXmlTag(x);
		const tag = stripNamespace(y[0]);
		if (ignoredTags.has(tag)) return x;
		switch (tag) {
			case "<metadataType":
				out.Types.push({ name: y.name });
				break;
			case "<futureMetadata":
				for (let j = 0; j < out.Types.length; ++j) if (out.Types[j].name === y.name) lastmeta = out.Types[j];
				break;
			case "<rc":
				if (metatype === 1) out.Cell.push({
					type: out.Types[y.t - 1].name,
					index: +y.v
				});
				else if (metatype === 0) out.Value.push({
					type: out.Types[y.t - 1].name,
					index: +y.v
				});
				break;
			case "<cellMetadata":
				metatype = 1;
				break;
			case "</cellMetadata>":
				metatype = 2;
				break;
			case "<valueMetadata":
				metatype = 0;
				break;
			case "</valueMetadata>":
				metatype = 2;
				break;
			case "<rvb":
				if (lastmeta) {
					if (!lastmeta.offsets) lastmeta.offsets = [];
					lastmeta.offsets.push(+y.i);
				}
				break;
		}
		return x;
	});
	return out;
}
/**
* Write minimal metadata XML for dynamic array support.
*
* Generates the XLDAPR (Dynamic Array Properties) metadata type that Excel
* requires for spill-range formulas. The metadata declares a single type
* and a single cell metadata entry referencing it.
*
* @returns Complete metadata.xml string
*/
function writeMetadataXml() {
	const o = [XML_HEADER];
	o.push("<metadata xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:xlrd=\"http://schemas.microsoft.com/office/spreadsheetml/2017/richdata\" xmlns:xda=\"http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray\">\n  <metadataTypes count=\"1\">\n    <metadataType name=\"XLDAPR\" minSupportedVersion=\"120000\" copy=\"1\" pasteAll=\"1\" pasteValues=\"1\" merge=\"1\" splitFirst=\"1\" rowColShift=\"1\" clearFormats=\"1\" clearComments=\"1\" assign=\"1\" coerce=\"1\" cellMeta=\"1\"/>\n  </metadataTypes>\n  <futureMetadata name=\"XLDAPR\" count=\"1\">\n    <bk>\n      <extLst>\n        <ext uri=\"{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}\">\n          <xda:dynamicArrayProperties fDynamic=\"1\" fCollapsed=\"0\"/>\n        </ext>\n      </extLst>\n    </bk>\n  </futureMetadata>\n  <cellMetadata count=\"1\">\n    <bk>\n      <rc t=\"1\" v=\"0\"/>\n    </bk>\n  </cellMetadata>\n</metadata>");
	return o.join("");
}

//#endregion
//#region src/xlsx/calc-chain.ts
/**
* Parse the calculation chain XML (ECMA-376 18.6).
*
* The calculation chain records the order in which cells with formulas should
* be recalculated. Each <c> entry references a cell and its sheet index.
* The sheet index (i) is sticky: if omitted, it inherits from the previous entry.
*
* @param data - Raw XML string of calcChain.xml
* @returns Array of calculation chain entries
*/
function parseCalcChainXml(data) {
	const d = [];
	if (!data) return d;
	let i = 1;
	(data.match(XML_TAG_REGEX) || []).forEach((x) => {
		const y = parseXmlTag(x);
		switch (y[0]) {
			case "<?xml": break;
			case "<calcChain":
			case "<calcChain>":
			case "</calcChain>": break;
			case "<c":
				delete y[0];
				if (y.i) i = y.i;
				else y.i = i;
				d.push(y);
				break;
		}
	});
	return d;
}

//#endregion
//#region src/xlsx/parse-zip.ts
/** Strip a leading "/" from a path (ZIP entries don't use leading slashes) */
function stripLeadingSlash(x) {
	return x.charAt(0) === "/" ? x.slice(1) : x;
}
/**
* Resolve a relative path against a base path.
* Handles ".." segments for paths like "../comments1.xml" relative to "xl/worksheets/sheet1.xml".
*/
function resolve_path(target, basePath) {
	if (target.charAt(0) === "/") return target;
	const parts = (basePath.slice(0, basePath.lastIndexOf("/") + 1) + target).split("/");
	const resolved = [];
	for (const p of parts) if (p === "..") resolved.pop();
	else if (p !== ".") resolved.push(p);
	return resolved.join("/");
}
/**
* Read a file from the ZIP as a string.
* Throws if the file is not found and safe is not set.
*/
function getZipString(zip, path, safe, opts) {
	const p = zipReadString(zip, path);
	if (p == null && !safe) throw new XlsxError("NOT_FOUND", "Could not find " + path);
	if (p != null) assertXmlPartLimits(path, p, opts);
	return p;
}
/** Read ZIP entry data as string (alias for XML-based files) */
function getZipData(zip, path, safe, opts) {
	return getZipString(zip, path, safe, opts);
}
/** Recognized relationship types for worksheets (standard and transitional) */
const RELS_WS = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet", "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet"];
/** Determine the sheet type from a relationship type URI */
function get_sheet_type(n) {
	if (RELS_WS.indexOf(n) > -1) return "sheet";
	return n && n.length ? n : "sheet";
}
/**
* Safely map workbook sheet entries to their target paths and types using
* the workbook relationships. Returns null if mapping fails.
*/
function safe_parse_wbrels(wbrels, sheets) {
	if (!wbrels) return null;
	try {
		const result = sheets.map((sheetEntry) => {
			const id = sheetEntry.id || sheetEntry.strRelID;
			return [
				sheetEntry.name,
				wbrels["!id"][id].Target,
				get_sheet_type(wbrels["!id"][id].Type)
			];
		});
		return result.length === 0 ? null : result;
	} catch {
		return null;
	}
}
/**
* Safely parse a single sheet from the ZIP, including its relationships,
* comments, threaded comments, and VML drawings.
*/
function safe_parse_sheet(zip, path, relsPath, sheetName, idx, sheetRels, sheets, stype, opts, wb, themes, styles, strs) {
	try {
		sheetRels[sheetName] = parseRelationships(getZipString(zip, relsPath, true, opts), path, opts);
		const data = getZipData(zip, path, false, opts);
		if (!data) return;
		let _ws;
		switch (stype) {
			case "sheet":
				_ws = parseWorksheetXml(data, opts, idx, sheetRels[sheetName], wb, themes, styles);
				break;
			default: return;
		}
		if (!_ws) return;
		resolveSharedStrings(_ws, strs, opts);
		sheets[sheetName] = _ws;
		const comments = [];
		let tcomments = [];
		if (sheetRels[sheetName]) for (const n of Object.keys(sheetRels[sheetName])) {
			if (n === "!id" || n === "!idx") continue;
			const rel = sheetRels[sheetName][n];
			if (!rel || !rel.Type) continue;
			if (rel.Type === RELS.CMNT) {
				const cmntData = getZipData(zip, resolve_path(rel.Target, path), true, opts);
				if (cmntData) {
					const parsedComments = parseCommentsXml(cmntData, opts);
					if (parsedComments && parsedComments.length > 0) insertCommentsIntoSheet(_ws, parsedComments, false);
				}
			}
			if (rel.Type === RELS.TCMNT) {
				const tcData = getZipData(zip, resolve_path(rel.Target, path), true, opts);
				if (tcData) tcomments = tcomments.concat(parseTcmntXml(tcData, opts));
			}
		}
		if (tcomments.length > 0) insertCommentsIntoSheet(_ws, tcomments, true, opts.people || []);
		if (_ws["!legdrawel"] && sheetRels[sheetName]) {
			const draw = getZipString(zip, resolve_path(_ws["!legdrawel"].Target, path), true, opts);
			if (draw) parseVml(utf8read(draw), _ws, comments);
		}
	} catch (e) {
		if (opts.WTF) throw e;
	}
}
/**
* Parse an XLSX ZIP archive into a WorkBook object.
*
* Orchestrates reading of all XLSX parts: content types, relationships,
* shared strings, themes, styles, workbook, properties, metadata, people,
* and individual worksheets with their comments and VML drawings.
*
* @param zip - ZipArchive containing the XLSX file parts
* @param opts - Read options controlling parsing behavior
* @returns Parsed WorkBook with sheets, properties, and metadata
* @throws XlsxError if the ZIP is not a valid XLSX file or the workbook is missing
*/
function parseZip(zip, opts) {
	resetFormatTable();
	const options = opts || {};
	if (!zipHas(zip, "[Content_Types].xml")) throw new XlsxError("UNSUPPORTED", "Unsupported ZIP file");
	const dir = parseContentTypes(getZipString(zip, "[Content_Types].xml", false, options), options);
	if (dir.workbooks.length === 0) {
		const binname = "xl/workbook.xml";
		if (getZipData(zip, binname, true, options)) dir.workbooks.push(binname);
	}
	if (dir.workbooks.length === 0) throw new XlsxError("NOT_FOUND", "Could not find workbook");
	const themes = { themeElements: { clrScheme: [] } };
	let styles = {
		NumberFmt: {},
		CellXf: [],
		Fonts: [],
		Fills: [],
		Borders: []
	};
	let strs = [];
	if (!options.bookSheets && !options.bookProps) {
		if (dir.sst) try {
			const sstData = getZipData(zip, stripLeadingSlash(dir.sst), false, options);
			if (sstData) strs = parseSstXml(sstData, options);
		} catch (e) {
			if (options.WTF) throw e;
		}
		if (dir.themes.length) {
			const themeData = getZipString(zip, dir.themes[0].replace(/^\//, ""), true, options);
			if (themeData) {
				const parsed = parse_theme_xml(themeData);
				Object.assign(themes, parsed);
			}
		}
		if (dir.style) {
			const styData = getZipData(zip, stripLeadingSlash(dir.style), false, options);
			if (styData) styles = parseStylesXml(styData, themes, options);
		}
	}
	const wb = parseWorkbookXml(getZipData(zip, stripLeadingSlash(dir.workbooks[0]), false, options), options);
	const props = {};
	if (dir.coreprops.length) {
		const propdata = getZipData(zip, stripLeadingSlash(dir.coreprops[0]), true, options);
		if (propdata) Object.assign(props, parseCoreProperties(propdata));
		if (dir.extprops.length) {
			const extdata = getZipData(zip, stripLeadingSlash(dir.extprops[0]), true, options);
			if (extdata) parseExtendedProperties(extdata, props);
		}
	}
	let custprops = {};
	if (!options.bookSheets || options.bookProps) {
		if (dir.custprops.length) {
			const custdata = getZipString(zip, stripLeadingSlash(dir.custprops[0]), true, options);
			if (custdata) custprops = parseCustomProperties(custdata, options);
		}
	}
	const out = {};
	if (options.bookSheets || options.bookProps) {
		let sheets;
		if (wb.Sheets) sheets = wb.Sheets.map((x) => x.name);
		else if (props.Worksheets && props.SheetNames?.length > 0) sheets = props.SheetNames;
		if (options.bookProps) {
			out.Props = props;
			out.Custprops = custprops;
		}
		if (options.bookSheets && sheets) out.SheetNames = sheets;
		if (options.bookSheets ? out.SheetNames : options.bookProps) return out;
	}
	const sheets = Object.create(null);
	if (options.bookDeps && dir.calcchain) parseCalcChainXml(getZipData(zip, stripLeadingSlash(dir.calcchain), true, options) || "");
	const sheetRels = Object.create(null);
	const wbsheets = wb.Sheets;
	props.Worksheets = wbsheets.length;
	props.SheetNames = [];
	for (let j = 0; j < wbsheets.length; ++j) props.SheetNames[j] = wbsheets[j].name;
	const wbrelsi = dir.workbooks[0].lastIndexOf("/");
	let wbrelsfile = (dir.workbooks[0].slice(0, wbrelsi + 1) + "_rels/" + dir.workbooks[0].slice(wbrelsi + 1) + ".rels").replace(/^\//, "");
	if (!zipHas(zip, wbrelsfile)) wbrelsfile = "xl/_rels/workbook.xml.rels";
	const wbrels = parseRelationships(getZipString(zip, wbrelsfile, true, options), wbrelsfile.replace(/_rels.*/, "s5s"), options);
	if ((dir.metadata || []).length >= 1) options.xlmeta = parseMetadataXml(getZipData(zip, stripLeadingSlash(dir.metadata[0]), true, options) || "", options);
	if ((dir.people || []).length >= 1) options.people = parsePeopleXml(getZipData(zip, stripLeadingSlash(dir.people[0]), true, options) || "");
	const wbrelsArr = wbrels ? safe_parse_wbrels(wbrels, wb.Sheets) : null;
	const nmode = getZipData(zip, "xl/worksheets/sheet.xml", true, options) ? 1 : 0;
	for (let i = 0; i < props.Worksheets; ++i) {
		let stype = "sheet";
		let path;
		if (wbrelsArr && wbrelsArr[i]) {
			path = "xl/" + wbrelsArr[i][1].replace(/[/]?xl\//, "");
			if (!zipHas(zip, path)) path = wbrelsArr[i][1];
			if (!zipHas(zip, path)) path = wbrelsfile.replace(/_rels\/[\S\s]*$/, "") + wbrelsArr[i][1];
			stype = wbrelsArr[i][2];
		} else {
			path = "xl/worksheets/sheet" + (i + 1 - nmode) + ".xml";
			path = path.replace(/sheet0\./, "sheet.");
		}
		if (options.sheets != null) {
			if (typeof options.sheets === "number" && i !== options.sheets) continue;
			if (typeof options.sheets === "string" && props.SheetNames[i].toLowerCase() !== options.sheets.toLowerCase()) continue;
			if (Array.isArray(options.sheets)) {
				let seen = false;
				for (const s of options.sheets) {
					if (typeof s === "number" && s === i) seen = true;
					if (typeof s === "string" && s.toLowerCase() === props.SheetNames[i].toLowerCase()) seen = true;
				}
				if (!seen) continue;
			}
		}
		const relsPath = path.replace(/^(.*)(\/)([^/]*)$/, "$1/_rels/$3.rels");
		safe_parse_sheet(zip, path, relsPath, props.SheetNames[i], i, sheetRels, sheets, stype, options, wb, themes, styles, strs);
	}
	const result = {
		Sheets: sheets,
		SheetNames: props.SheetNames,
		Props: props,
		Custprops: custprops,
		bookType: "xlsx"
	};
	if (wb.WBProps) result.Workbook = {
		WBProps: wb.WBProps,
		Sheets: wb.Sheets,
		Names: wb.Names
	};
	return result;
}

//#endregion
//#region src/utils/base64.ts
/**
* Decode a base64 string to a Uint8Array.
*
* Automatically strips a data-URI prefix (e.g. "data:application/octet-stream;base64,...")
* if present before decoding.
*
* @param input - Base64-encoded string, optionally prefixed with a data URI scheme
* @returns Decoded byte array
*/
function base64decode(input) {
	let str = input;
	if (str.slice(0, 5) === "data:") {
		const i = str.slice(0, 1024).indexOf(";base64,");
		if (i !== -1) str = str.slice(i + 8);
	}
	const binaryStr = atob(str);
	const len = binaryStr.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
	return bytes;
}
/**
* Encode a Uint8Array to a base64 string.
*
* Converts each byte to a character and uses the built-in btoa() for encoding.
*
* @param data - Byte array to encode
* @returns Base64-encoded string
*/
function base64encode(data) {
	let binaryStr = "";
	for (let i = 0; i < data.length; i++) binaryStr += String.fromCharCode(data[i]);
	return btoa(binaryStr);
}

//#endregion
//#region src/utils/export-range.ts
const CELL_REF_RE = /^[A-Z]+[1-9]\d*$/;
const MAX_EXPORT_CELLS = 1e6;
function rangeCellCount(range) {
	const rows = range.e.r - range.s.r + 1;
	const cols = range.e.c - range.s.c + 1;
	return rows > 0 && cols > 0 ? rows * cols : 0;
}
function occupiedRangeEnd(sheet, range) {
	let maxRow = -1;
	let maxCol = -1;
	const data = sheet["!data"];
	if (data != null) for (const rowKey of Object.keys(data)) {
		const rowIdx = Number(rowKey);
		if (!Number.isInteger(rowIdx) || rowIdx < range.s.r || rowIdx > range.e.r) continue;
		const row = data[rowIdx];
		if (!row) continue;
		for (const colKey of Object.keys(row)) {
			const colIdx = Number(colKey);
			if (!Number.isInteger(colIdx) || colIdx < range.s.c || colIdx > range.e.c || row[colIdx] == null) continue;
			if (rowIdx > maxRow) maxRow = rowIdx;
			if (colIdx > maxCol) maxCol = colIdx;
		}
	}
	else for (const ref of Object.keys(sheet)) {
		if (!CELL_REF_RE.test(ref) || sheet[ref] == null) continue;
		const cell = decodeCell(ref);
		if (cell.r < range.s.r || cell.r > range.e.r || cell.c < range.s.c || cell.c > range.e.c) continue;
		if (cell.r > maxRow) maxRow = cell.r;
		if (cell.c > maxCol) maxCol = cell.c;
	}
	return maxRow === -1 ? null : {
		r: maxRow,
		c: maxCol
	};
}
function clampLargeExportRange(sheet, range) {
	if (rangeCellCount(range) <= MAX_EXPORT_CELLS) return range;
	const end = occupiedRangeEnd(sheet, range);
	if (!end) return null;
	return {
		s: {
			r: range.s.r,
			c: range.s.c
		},
		e: {
			r: Math.max(range.s.r, Math.min(range.e.r, end.r)),
			c: Math.max(range.s.c, Math.min(range.e.c, end.c))
		}
	};
}

//#endregion
//#region src/types.ts
/**
* Map of Excel error codes to their display strings.
* Keys are the numeric error codes stored in XLSX files.
*/
const BErr = {
	0: "#NULL!",
	7: "#DIV/0!",
	15: "#VALUE!",
	23: "#REF!",
	29: "#NAME?",
	36: "#NUM!",
	42: "#N/A",
	43: "#GETTING_DATA"
};
/** Reverse map from error display strings to numeric error codes */
const RBErr = {};
for (const [k, v] of Object.entries(BErr)) RBErr[v] = +k;

//#endregion
//#region src/api/format.ts
function resolveNumberFormat(fmt, options) {
	if (typeof fmt === "string") return fmt === "m/d/yy" && options?.dateNF ? String(options.dateNF) : fmt;
	if (typeof fmt !== "number") return;
	if (fmt === 14 && options?.dateNF) return String(options.dateNF);
	const table = options?.table || formatTable;
	return table[fmt] || table[DEFAULT_FORMAT_MAP[fmt]] || DEFAULT_FORMAT_STRINGS[fmt];
}
function resolveCellNumberFormat(cell, options) {
	return resolveNumberFormat(cell.z ?? cell.XF?.numFmtId, options);
}
/** Return the date/time classification for a cell's number format. */
function getCellDateTimeFormatKind(cell, options) {
	const fmt = resolveCellNumberFormat(cell, options);
	return fmt ? getDateTimeFormatKind(fmt) : "none";
}
function pad2(value) {
	return value < 10 ? "0" + value : "" + value;
}
function formatDateIso(date, kind) {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	const hours = date.getUTCHours();
	const minutes = date.getUTCMinutes();
	const seconds = date.getUTCSeconds();
	const datePart = `${year < 1e3 ? String(year).padStart(4, "0") : String(year)}-${pad2(month)}-${pad2(day)}`;
	if (kind === "date") return datePart;
	return `${datePart}T${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}
function inferDateKind(date, options) {
	const useUtc = options?.UTC !== false;
	const hours = useUtc ? date.getUTCHours() : date.getHours();
	const minutes = useUtc ? date.getUTCMinutes() : date.getMinutes();
	const seconds = useUtc ? date.getUTCSeconds() : date.getSeconds();
	const ms = useUtc ? date.getUTCMilliseconds() : date.getMilliseconds();
	return hours || minutes || seconds || ms ? "datetime" : "date";
}
function normalizeDateOutput(date, options) {
	return options?.UTC === false ? utcToLocal(date) : date;
}
/**
* Attempt to format a cell value using the cell's number format or XF record.
* Falls back to a plain string coercion if all formatting attempts fail.
*/
function safeFormatCell(cell, value) {
	const isDateCell = cell.t === "d" && value instanceof Date;
	if (cell.z != null) try {
		cell.w = formatNumber(cell.z, isDateCell ? dateToSerialNumber(value) : value);
		return cell.w;
	} catch {}
	try {
		cell.w = formatNumber((cell.XF || {}).numFmtId || (isDateCell ? 14 : 0), isDateCell ? dateToSerialNumber(value) : value);
		return cell.w;
	} catch {
		return "" + value;
	}
}
/**
* Format a cell's value into its display string representation.
*
* Returns the cached `cell.w` if already computed, otherwise formats the value
* using the cell's number format string or XF style information.
*
* @param cell - The cell object to format
* @param value - Optional override value; if omitted, uses `cell.v`
* @param options - Optional settings (e.g. `dateNF` for a default date format)
* @returns The formatted display string, or empty string for null/blank cells
*/
function formatCell(cell, value, options) {
	if (cell == null || cell.t == null || cell.t === "z") return "";
	if (cell.w !== void 0) return cell.w;
	if (cell.t === "d" && !cell.z && options && options.dateNF) cell.z = options.dateNF;
	if (cell.t === "e") return BErr[cell.v] || String(cell.v);
	if (value == null) return safeFormatCell(cell, cell.v);
	return safeFormatCell(cell, value);
}
/**
* Format a cell for worksheet export APIs.
*
* This mirrors `formatCell` by default. With `dateOutput: "iso"`, date and
* datetime number formats are rendered as stable ISO-like strings, while
* time-only formats keep their display value instead of becoming epoch dates.
*/
function formatCellForOutput(cell, value, options) {
	if (options?.dateOutput !== "iso") return formatCell(cell, value, options);
	const cellValue = value == null ? cell.v : value;
	const kind = getCellDateTimeFormatKind(cell, options);
	if (cell.t === "n" && typeof cellValue === "number") {
		if (kind === "date" || kind === "datetime") return formatDateIso(normalizeDateOutput(serialNumberToDate(cellValue, options?.date1904), options), kind);
		return formatCell(cell, value, options);
	}
	if (cellValue instanceof Date) return formatDateIso(normalizeDateOutput(cellValue, options), kind === "none" || kind === "time" ? inferDateKind(cellValue, options) : kind);
	return formatCell(cell, value, options);
}

//#endregion
//#region src/api/json.ts
function setRowValue(row, key, value) {
	if (key === "__proto__" || key === "constructor" || key === "prototype") Object.defineProperty(row, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
	else row[key] = value;
}
/**
* Build a single JSON row object (or array) from a worksheet row.
*
* Reads each cell in the row, converts its value based on type (handling dates,
* errors, booleans, etc.), and populates the output row keyed by column headers.
*
* @returns An object containing the built `row` and an `isempty` flag
*/
function buildJsonRow(sheet, range, rowIndex, header, headers, options) {
	const defval = options.defval;
	const raw = options.raw || !Object.hasOwn(options, "raw");
	let isempty = true;
	const row = header === 1 ? [] : {};
	if (header !== 1) try {
		Object.defineProperty(row, "__rowNum__", {
			value: rowIndex,
			enumerable: false
		});
	} catch {
		row.__rowNum__ = rowIndex;
	}
	for (let colIdx = range.s.c; colIdx <= range.e.c; ++colIdx) {
		const val = getCell(sheet, rowIndex, colIdx);
		if (val == null || val.t === void 0) {
			if (defval === void 0) continue;
			if (headers[colIdx] != null) setRowValue(row, headers[colIdx], defval);
			continue;
		}
		let cellValue = val.v;
		switch (val.t) {
			case "z":
				if (cellValue == null) break;
				continue;
			case "e":
				cellValue = cellValue === 0 ? null : void 0;
				break;
			case "s":
			case "b": break;
			case "n": {
				const fmtKind = getCellDateTimeFormatKind(val, options);
				if (fmtKind === "none" || fmtKind === "time") break;
				cellValue = serialNumberToDate(cellValue, options.date1904);
				if (typeof cellValue === "number") break;
			}
			case "d":
				if (!(options && (options.UTC || options.raw === false || options.dateOutput === "iso"))) cellValue = utcToLocal(new Date(cellValue));
				break;
			default: throw new XlsxError("INVALID_ARGUMENT", "unrecognized type " + val.t);
		}
		if (headers[colIdx] != null) {
			if (cellValue == null) if (val.t === "e" && cellValue === null) setRowValue(row, headers[colIdx], null);
			else if (defval !== void 0) setRowValue(row, headers[colIdx], defval);
			else if (raw && cellValue === null) setRowValue(row, headers[colIdx], null);
			else continue;
			else {
				const useRaw = val.t === "n" && typeof options.rawNumbers === "boolean" ? options.rawNumbers : raw;
				const fmtKind = getCellDateTimeFormatKind(val, options);
				const useDateOutput = options.dateOutput === "iso" && (val.t === "d" || fmtKind === "date" || fmtKind === "datetime");
				setRowValue(row, headers[colIdx], useDateOutput || !useRaw ? formatCellForOutput(val, cellValue, options) : cellValue);
			}
			if (cellValue != null) isempty = false;
		}
	}
	return {
		row,
		isempty
	};
}
/**
* Convert a worksheet to an array of JSON objects (or arrays).
*
* The first row is used as header keys by default. Supports multiple header
* modes (raw arrays, column-letter keys, custom headers), range overrides,
* hidden row/column skipping, blank-row handling, and date conversion.
*
* @param sheet - The worksheet to convert
* @param opts - Optional conversion options (header, range, raw, rawNumbers, defval, blankrows, skipHidden, dateNF, UTC)
* @returns An array of row objects (or arrays when `header: 1`)
*/
function sheetToJson(sheet, opts) {
	if (sheet == null || sheet["!ref"] == null) return [];
	let header = 0, offset = 1;
	const headers = [];
	const options = opts || {};
	const range = options.range != null ? options.range : sheet["!ref"];
	if (options.header === 1) header = 1;
	else if (options.header === "A") header = 2;
	else if (Array.isArray(options.header)) header = 3;
	else if (options.header == null) header = 0;
	let decodedRange;
	switch (typeof range) {
		case "string":
			decodedRange = safeDecodeRange(range);
			break;
		case "number":
			decodedRange = safeDecodeRange(sheet["!ref"]);
			decodedRange.s.r = range;
			break;
		default: decodedRange = range;
	}
	if (options.range == null || typeof options.range === "number") {
		const clampedRange = clampLargeExportRange(sheet, decodedRange);
		if (!clampedRange) return [];
		decodedRange = clampedRange;
	}
	if (header > 0) offset = 0;
	const out = [];
	let outputIndex = 0;
	let rowIdx = decodedRange.s.r;
	const header_cnt = Object.create(null);
	const colinfo = options.skipHidden && sheet["!cols"] || [];
	const rowinfo = options.skipHidden && sheet["!rows"] || [];
	for (let colIdx = decodedRange.s.c; colIdx <= decodedRange.e.c; ++colIdx) {
		if ((colinfo[colIdx] || {}).hidden) continue;
		const val = getCell(sheet, rowIdx, colIdx);
		let cellValue, headerLabel;
		switch (header) {
			case 1:
				headers[colIdx] = colIdx - decodedRange.s.c;
				break;
			case 2:
				headers[colIdx] = encodeCol(colIdx);
				break;
			case 3:
				headers[colIdx] = options.header[colIdx - decodedRange.s.c];
				break;
			default: {
				headerLabel = cellValue = formatCell(val == null ? {
					w: "__EMPTY",
					t: "s"
				} : val, null, options);
				let counter = header_cnt[cellValue] || 0;
				if (!counter) header_cnt[cellValue] = 1;
				else {
					do
						headerLabel = cellValue + "_" + counter++;
					while (header_cnt[headerLabel]);
					header_cnt[cellValue] = counter;
					header_cnt[headerLabel] = 1;
				}
				headers[colIdx] = headerLabel;
			}
		}
	}
	for (rowIdx = decodedRange.s.r + offset; rowIdx <= decodedRange.e.r; ++rowIdx) {
		if ((rowinfo[rowIdx] || {}).hidden) continue;
		const row = buildJsonRow(sheet, decodedRange, rowIdx, header, headers, options);
		if (!row.isempty || (header === 1 ? options.blankrows !== false : !!options.blankrows)) out[outputIndex++] = row.row;
	}
	out.length = outputIndex;
	return out;
}
/**
* Add an array of JSON objects to an existing worksheet, or create a new one.
*
* Object keys become column headers (written in the first row unless
* `skipHeader` is set). Supports dense and sparse storage, origin offsets,
* date handling, and automatic type detection.
*
* @param existingSheet - An existing worksheet to append to, or `null` to create a new one
* @param jsonData - Array of plain objects whose keys map to column headers
* @param opts - Optional settings (header, origin, dense, skipHeader, cellDates, UTC, dateNF, nullError)
* @returns The updated or newly created worksheet
*/
function addJsonToSheet(existingSheet, jsonData, opts) {
	const options = opts || {};
	const dense = existingSheet ? existingSheet["!data"] != null : !!options.dense;
	const offset = +!options.skipHeader;
	const worksheet = existingSheet || {};
	if (!existingSheet && dense) worksheet["!data"] = [];
	let originRow = 0, originCol = 0;
	if (worksheet && options.origin != null) if (typeof options.origin === "number") originRow = options.origin;
	else {
		const parsedOrigin = typeof options.origin === "string" ? decodeCell(options.origin) : options.origin;
		originRow = parsedOrigin.r;
		originCol = parsedOrigin.c;
	}
	const range = {
		s: {
			c: 0,
			r: 0
		},
		e: {
			c: originCol,
			r: originRow + jsonData.length - 1 + offset
		}
	};
	if (worksheet["!ref"]) {
		const existingRange = safeDecodeRange(worksheet["!ref"]);
		range.e.c = Math.max(range.e.c, existingRange.e.c);
		range.e.r = Math.max(range.e.r, existingRange.e.r);
		if (originRow === -1) {
			originRow = existingRange.e.r + 1;
			range.e.r = originRow + jsonData.length - 1 + offset;
		}
	} else if (originRow === -1) {
		originRow = 0;
		range.e.r = jsonData.length - 1 + offset;
	}
	const headers = options.header || [];
	let colIdx = 0;
	jsonData.forEach((rowObj, rowIdx) => {
		if (dense && !worksheet["!data"][originRow + rowIdx + offset]) worksheet["!data"][originRow + rowIdx + offset] = [];
		const denseRow = dense ? worksheet["!data"][originRow + rowIdx + offset] : null;
		Object.keys(rowObj).forEach((key) => {
			if ((colIdx = headers.indexOf(key)) === -1) headers[colIdx = headers.length] = key;
			let value = rowObj[key];
			let cellType = "z";
			let dateFormat = "";
			const ref = dense ? "" : encodeCol(originCol + colIdx) + encodeRow(originRow + rowIdx + offset);
			const cell = dense ? denseRow[originCol + colIdx] : worksheet[ref];
			if (value && typeof value === "object" && !(value instanceof Date)) if (dense) denseRow[originCol + colIdx] = value;
			else worksheet[ref] = value;
			else {
				if (typeof value === "number") cellType = "n";
				else if (typeof value === "boolean") cellType = "b";
				else if (typeof value === "string") cellType = "s";
				else if (value instanceof Date) {
					cellType = "d";
					if (!options.UTC) value = localToUtc(value);
					if (!options.cellDates) {
						cellType = "n";
						value = dateToSerialNumber(value);
					}
					dateFormat = cell != null && cell.z && isDateFormat(String(cell.z)) ? String(cell.z) : options.dateNF || formatTable[14];
				} else if (value === null && options.nullError) {
					cellType = "e";
					value = 0;
				}
				if (!cell) {
					const newCell = {
						t: cellType,
						v: value
					};
					if (dateFormat) newCell.z = dateFormat;
					if (dense) denseRow[originCol + colIdx] = newCell;
					else worksheet[ref] = newCell;
				} else {
					cell.t = cellType;
					cell.v = value;
					delete cell.w;
					if (dateFormat) cell.z = dateFormat;
				}
			}
		});
	});
	range.e.c = Math.max(range.e.c, originCol + headers.length - 1);
	const encodedOriginRow = encodeRow(originRow);
	if (dense && !worksheet["!data"][originRow]) worksheet["!data"][originRow] = [];
	if (offset) for (colIdx = 0; colIdx < headers.length; ++colIdx) if (dense) worksheet["!data"][originRow][colIdx + originCol] = {
		t: "s",
		v: headers[colIdx]
	};
	else worksheet[encodeCol(colIdx + originCol) + encodedOriginRow] = {
		t: "s",
		v: headers[colIdx]
	};
	worksheet["!ref"] = encodeRange(range);
	return worksheet;
}
/**
* Create a new worksheet from an array of JSON objects.
*
* This is a convenience wrapper around `addJsonToSheet` that always creates
* a fresh worksheet.
*
* @param js - Array of plain objects whose keys map to column headers
* @param opts - Optional settings (same as `addJsonToSheet`)
* @returns A new worksheet populated with the given data
*/
function jsonToSheet(js, opts) {
	return addJsonToSheet(null, js, opts);
}

//#endregion
//#region src/api/aoa.ts
/**
* Add an array-of-arrays to an existing worksheet, or create a new one.
*
* Each inner array represents a row, and each element within it a cell value.
* Supports dense and sparse storage modes, origin offsets, date handling,
* and automatic type detection (number, boolean, string, date, error).
*
* @param worksheet - An existing worksheet to append to, or `null` to create a new one
* @param data - The array-of-arrays containing raw cell values
* @param opts - Optional settings (origin, dense, dateNF, cellDates, UTC, date1904, nullError, sheetStubs)
* @returns The updated or newly created worksheet
*/
function addArrayToSheet(worksheet, data, opts) {
	const options = opts || {};
	const dense = worksheet ? worksheet["!data"] != null : !!options.dense;
	const ws = worksheet || (dense ? { "!data": [] } : {});
	if (dense && !ws["!data"]) ws["!data"] = [];
	let originRow = 0, originCol = 0;
	if (ws && options.origin != null) if (typeof options.origin === "number") originRow = options.origin;
	else {
		const parsedOrigin = typeof options.origin === "string" ? decodeCell(options.origin) : options.origin;
		originRow = parsedOrigin.r;
		originCol = parsedOrigin.c;
	}
	const range = {
		s: {
			c: 1e7,
			r: 1e7
		},
		e: {
			c: 0,
			r: 0
		}
	};
	if (ws["!ref"]) {
		const existingRange = safeDecodeRange(ws["!ref"]);
		range.s.c = existingRange.s.c;
		range.s.r = existingRange.s.r;
		range.e.c = Math.max(range.e.c, existingRange.e.c);
		range.e.r = Math.max(range.e.r, existingRange.e.r);
		if (originRow === -1) range.e.r = originRow = ws["!ref"] ? existingRange.e.r + 1 : 0;
	} else range.s.c = range.e.c = range.s.r = range.e.r = 0;
	let seen = false;
	for (let rowIdx = 0; rowIdx < data.length; ++rowIdx) {
		if (!data[rowIdx]) continue;
		if (!Array.isArray(data[rowIdx])) throw new XlsxError("INVALID_ARGUMENT", "arrayToSheet expects an array of arrays");
		const targetRow = originRow + rowIdx;
		const rowData = data[rowIdx];
		for (let colIdx = 0; colIdx < rowData.length; ++colIdx) {
			if (rowData[colIdx] === void 0) continue;
			let cell = {
				v: rowData[colIdx],
				t: ""
			};
			const targetCol = originCol + colIdx;
			if (range.s.r > targetRow) range.s.r = targetRow;
			if (range.s.c > targetCol) range.s.c = targetCol;
			if (range.e.r < targetRow) range.e.r = targetRow;
			if (range.e.c < targetCol) range.e.c = targetCol;
			seen = true;
			if (rowData[colIdx] && typeof rowData[colIdx] === "object" && !Array.isArray(rowData[colIdx]) && !(rowData[colIdx] instanceof Date)) cell = rowData[colIdx];
			else {
				if (Array.isArray(cell.v)) {
					cell.f = rowData[colIdx][1];
					cell.v = cell.v[0];
				}
				if (cell.v === null) if (cell.f) cell.t = "n";
				else if (options.nullError) {
					cell.t = "e";
					cell.v = 0;
				} else if (!options.sheetStubs) continue;
				else cell.t = "z";
				else if (typeof cell.v === "number") if (isFinite(cell.v)) cell.t = "n";
				else if (isNaN(cell.v)) {
					cell.t = "e";
					cell.v = 15;
				} else {
					cell.t = "e";
					cell.v = 7;
				}
				else if (typeof cell.v === "boolean") cell.t = "b";
				else if (cell.v instanceof Date) {
					cell.z = options.dateNF || formatTable[14];
					if (!options.UTC) cell.v = localToUtc(cell.v);
					if (options.cellDates) {
						cell.t = "d";
						cell.w = formatNumber(cell.z, dateToSerialNumber(cell.v, options.date1904));
					} else {
						cell.t = "n";
						cell.v = dateToSerialNumber(cell.v, options.date1904);
						cell.w = formatNumber(cell.z, cell.v);
					}
				} else cell.t = "s";
			}
			const existingCell = getCell(ws, targetRow, targetCol);
			if (existingCell?.z && !cell.z) cell.z = existingCell.z;
			setCell(ws, targetRow, targetCol, cell);
		}
	}
	if (seen && range.s.c < 104e5) ws["!ref"] = encodeRange(range);
	return ws;
}
/**
* Create a new worksheet from an array-of-arrays.
*
* This is a convenience wrapper around `addArrayToSheet` that always creates
* a fresh worksheet.
*
* @param data - The array-of-arrays containing raw cell values
* @param opts - Optional settings (same as `addArrayToSheet`)
* @returns A new worksheet populated with the given data
*/
function arrayToSheet(data, opts) {
	return addArrayToSheet(null, data, opts);
}
/**
* Convert a worksheet to an array-of-arrays.
*
* This is a convenience wrapper around `sheetToJson(sheet, { header: 1 })`
* that mirrors `arrayToSheet` for callers that prefer explicit conversion
* pairs.
*
* @param sheet - The worksheet to convert
* @param opts - Optional conversion settings, except `header` which is fixed to array output
* @returns A two-dimensional array of worksheet values
*/
function sheetToArray(sheet, opts) {
	return sheetToJson(sheet, {
		...opts,
		header: 1
	});
}

//#endregion
//#region src/api/csv.ts
/** Regex to match double-quote characters for CSV escaping (doubled inside quoted fields) */
const qreg = /"/g;
function escapeFormulaText(txt, options) {
	if (options.escapeFormulae === false || txt.length === 0) return txt;
	switch (txt.charCodeAt(0)) {
		case 9:
		case 13:
		case 43:
		case 45:
		case 61:
		case 64: return "'" + txt;
		default: return txt;
	}
}
/**
* Build a single CSV row string from a worksheet row.
*
* Handles value quoting (when field/record separators, newlines, or double
* quotes appear in the text), the special "ID" SYLK-avoidance quoting,
* formula-only cells, and the `strip`/`blankrows` options.
*
* @returns The joined CSV row string, or `null` if the row is blank and blankrows is disabled
*/
function buildCsvRow(sheet, range, rowIndex, cols, fieldSepCode, recordSepCode, fieldSeparator, rowCount, options) {
	let isempty = true;
	const row = [];
	for (let colIdx = range.s.c; colIdx <= range.e.c; ++colIdx) {
		if (!cols[colIdx]) continue;
		const val = getCell(sheet, rowIndex, colIdx);
		let txt = "";
		if (val == null) txt = "";
		else if (val.v != null) {
			isempty = false;
			const fmtKind = getCellDateTimeFormatKind(val, options);
			const useDateOutput = options.dateOutput === "iso" && (val.t === "d" || fmtKind === "date" || fmtKind === "datetime");
			txt = "" + (options.rawNumbers && val.t === "n" && !useDateOutput ? val.v : formatCellForOutput(val, null, options));
			txt = escapeFormulaText(txt, options);
			for (let i = 0, charCode = 0; i !== txt.length; ++i) if ((charCode = txt.charCodeAt(i)) === fieldSepCode || charCode === recordSepCode || charCode === 10 || charCode === 13 || charCode === 34 || options.forceQuotes) {
				txt = "\"" + txt.replace(qreg, "\"\"") + "\"";
				break;
			}
			if (txt === "ID" && rowCount === 0 && row.length === 0) txt = "\"ID\"";
		} else if (val.f != null && !val.F) {
			isempty = false;
			txt = "=" + val.f;
			txt = escapeFormulaText(txt, options);
			if (txt.indexOf(",") >= 0) txt = "\"" + txt.replace(qreg, "\"\"") + "\"";
		} else txt = "";
		row.push(txt);
	}
	if (options.strip) while (row.at(-1) === "") --row.length;
	if (options.blankrows === false && isempty) return null;
	return row.join(fieldSeparator);
}
/**
* Convert a worksheet to a CSV string.
*
* Supports customizable field and record separators, hidden row/column
* skipping, blank-row suppression, raw number output, and forced quoting.
*
* @param sheet - The worksheet to convert
* @param opts - Optional CSV generation options (FS, RS, skipHidden, strip, blankrows, rawNumbers, forceQuotes)
* @returns The CSV string representation of the worksheet
*/
function sheetToCsv(sheet, opts) {
	const out = [];
	const options = opts == null ? {} : opts;
	if (sheet == null || sheet["!ref"] == null) return "";
	const range = clampLargeExportRange(sheet, safeDecodeRange(sheet["!ref"]));
	if (!range) return "";
	const fieldSeparator = options.FS !== void 0 ? options.FS : ",";
	const fieldSepCode = fieldSeparator.charCodeAt(0);
	const recordSeparator = options.RS !== void 0 ? options.RS : "\n";
	const recordSepCode = recordSeparator.charCodeAt(0);
	const cols = [];
	const colinfo = options.skipHidden && sheet["!cols"] || [];
	const rowinfo = options.skipHidden && sheet["!rows"] || [];
	for (let colIdx = range.s.c; colIdx <= range.e.c; ++colIdx) if (!(colinfo[colIdx] || {}).hidden) cols[colIdx] = encodeCol(colIdx);
	let rowCount = 0;
	for (let rowIdx = range.s.r; rowIdx <= range.e.r; ++rowIdx) {
		if ((rowinfo[rowIdx] || {}).hidden) continue;
		const row = buildCsvRow(sheet, range, rowIdx, cols, fieldSepCode, recordSepCode, fieldSeparator, rowCount, options);
		if (row == null) continue;
		if (row || options.blankrows !== false) out.push((rowCount++ ? recordSeparator : "") + row);
	}
	return out.join("");
}
/**
* Convert a worksheet to a tab-separated values (TSV) string.
*
* This is a convenience wrapper around `sheetToCsv` with tab as the field
* separator and newline as the record separator.
*
* @param sheet - The worksheet to convert
* @param opts - Optional CSV/TSV generation options (same as `sheetToCsv`)
* @returns The TSV string representation of the worksheet
*/
function sheetToTxt(sheet, opts) {
	const options = opts || {};
	options.FS = "	";
	options.RS = "\n";
	return sheetToCsv(sheet, options);
}
/**
* Parse an RFC 4180 CSV string into a 2D array of values.
*
* Handles quoted fields, escaped double-quotes, and newlines within quotes.
*/
function parseCsv(text, sep) {
	const rows = [];
	let row = [];
	let i = 0;
	const len = text.length;
	while (i <= len) {
		if (i === len) {
			if (row.length > 0 || rows.length > 0) {
				row.push("");
				rows.push(row);
			}
			break;
		}
		if (text[i] === "\"") {
			let val = "";
			i++;
			while (i < len) if (text[i] === "\"") if (i + 1 < len && text[i + 1] === "\"") {
				val += "\"";
				i += 2;
			} else {
				i++;
				break;
			}
			else {
				val += text[i];
				i++;
			}
			row.push(val);
			if (i < len && text[i] === sep) i++;
			else if (i < len && (text[i] === "\r" || text[i] === "\n")) {
				if (text[i] === "\r" && i + 1 < len && text[i + 1] === "\n") i++;
				i++;
				rows.push(row);
				row = [];
			}
		} else if (text[i] === sep) {
			row.push("");
			i++;
		} else if (text[i] === "\r" || text[i] === "\n") {
			if (text[i] === "\r" && i + 1 < len && text[i + 1] === "\n") i++;
			i++;
			rows.push(row);
			row = [];
		} else {
			let val = "";
			while (i < len && text[i] !== sep && text[i] !== "\r" && text[i] !== "\n") {
				val += text[i];
				i++;
			}
			row.push(val);
			if (i < len && text[i] === sep) i++;
			else if (i < len && (text[i] === "\r" || text[i] === "\n")) {
				if (text[i] === "\r" && i + 1 < len && text[i + 1] === "\n") i++;
				i++;
				rows.push(row);
				row = [];
			}
		}
	}
	return rows;
}
/** Try to coerce a string value to a number or boolean */
function coerceValue(val) {
	if (val === "") return val;
	if (val === "TRUE" || val === "true") return true;
	if (val === "FALSE" || val === "false") return false;
	const num = Number(val);
	if (val.length > 0 && !isNaN(num) && isFinite(num)) return num;
	return val;
}
/**
* Parse a CSV string into a WorkSheet.
*
* @param text - CSV text to parse
* @param opts - Optional: { FS: field separator (default ",") }
* @returns A WorkSheet with the parsed data
*/
function csvToSheet(text, opts) {
	return arrayToSheet(parseCsv(text, opts && opts.FS || ",").map((row) => row.map((value) => coerceValue(value))));
}

//#endregion
//#region src/api/html.ts
/** Default HTML document prefix wrapping the table in a minimal page structure */
const HTML_BEGIN = "<html><head><meta charset=\"utf-8\"/><title>SheetJS Table Export</title></head><body>";
/** Default HTML document suffix closing the body and html tags */
const HTML_END = "</body></html>";
const UNSAFE_LINK_TARGET_RE = /^(?:javascript|vbscript|data):/;
function isIgnorableLinkTargetCode(code) {
	return code <= 32 || code === 127 || code === 173 || code === 1564 || code === 6158 || code >= 8203 && code <= 8207 || code >= 8234 && code <= 8238 || code >= 8288 && code <= 8303 || code === 65279;
}
function isSanitizedLinkTarget(target) {
	let normalized = "";
	for (let i = 0; i < target.length; ++i) if (!isIgnorableLinkTargetCode(target.charCodeAt(i))) normalized += target[i];
	normalized = normalized.toLowerCase();
	return !UNSAFE_LINK_TARGET_RE.test(normalized);
}
/**
* Build a single HTML `<tr>` row from a worksheet row, handling merged cells,
* error coercion, hyperlinks, editable mode, and data attributes.
*/
function buildHtmlRow(ws, range, rowIndex, options) {
	const merges = ws["!merges"] || [];
	const cells = [];
	for (let colIdx = range.s.c; colIdx <= range.e.c; ++colIdx) {
		let rowSpan = 0, colSpan = 0;
		for (let j = 0; j < merges.length; ++j) {
			if (merges[j].s.r > rowIndex || merges[j].s.c > colIdx) continue;
			if (merges[j].e.r < rowIndex || merges[j].e.c < colIdx) continue;
			if (merges[j].s.r < rowIndex || merges[j].s.c < colIdx) {
				rowSpan = -1;
				break;
			}
			rowSpan = merges[j].e.r - merges[j].s.r + 1;
			colSpan = merges[j].e.c - merges[j].s.c + 1;
			break;
		}
		if (rowSpan < 0) continue;
		const coord = encodeCol(colIdx) + encodeRow(rowIndex);
		let cell = getCell(ws, rowIndex, colIdx);
		if (cell && cell.t === "n" && cell.v != null && !isFinite(cell.v)) if (isNaN(cell.v)) cell = {
			t: "e",
			v: 36,
			w: BErr[36]
		};
		else cell = {
			t: "e",
			v: 7,
			w: BErr[7]
		};
		let cellContent = "";
		if (cell && cell.v != null) cellContent = cell.h || escapeHtml(cell.w || formatCell(cell) || "");
		const cellAttrs = {};
		if (rowSpan > 1) cellAttrs.rowspan = String(rowSpan);
		if (colSpan > 1) cellAttrs.colspan = String(colSpan);
		if (options.editable) cellContent = "<span contenteditable=\"true\">" + cellContent + "</span>";
		else if (cell) {
			cellAttrs["data-t"] = cell && cell.t || "z";
			if (cell.v != null) cellAttrs["data-v"] = escapeHtml(cell.v instanceof Date ? cell.v.toISOString() : String(cell.v));
			if (cell.z != null) cellAttrs["data-z"] = String(cell.z);
			if (cell.f != null) cellAttrs["data-f"] = escapeHtml(cell.f);
			if (cell.l && (cell.l.Target || "#").charAt(0) !== "#" && (options.sanitizeLinks === false || isSanitizedLinkTarget(cell.l.Target || ""))) cellContent = "<a href=\"" + escapeHtml(cell.l.Target) + "\">" + cellContent + "</a>";
		}
		cellAttrs.id = (options.id || "sjs") + "-" + coord;
		cells.push(writeXmlElement("td", cellContent, cellAttrs));
	}
	return "<tr>" + cells.join("") + "</tr>";
}
/**
* Convert a worksheet to an HTML table string.
*
* Generates a full HTML document (or fragment) containing a `<table>` with
* one `<tr>` per row. Supports merged cells, hyperlinks, editable mode,
* and data attributes for round-tripping.
*
* @param ws - The worksheet to convert
* @param opts - Optional HTML generation options (header, footer, id, editable, sanitizeLinks)
* @returns The HTML string representation of the worksheet
*/
function sheetToHtml(ws, opts) {
	const options = opts || {};
	const header = options.header != null ? options.header : HTML_BEGIN;
	const footer = options.footer != null ? options.footer : HTML_END;
	const out = [header];
	const range = clampLargeExportRange(ws, decodeRange(ws["!ref"] || "A1"));
	out.push("<table" + (options.id ? " id=\"" + options.id + "\"" : "") + ">");
	if (ws["!ref"] && range) for (let rowIdx = range.s.r; rowIdx <= range.e.r; ++rowIdx) out.push(buildHtmlRow(ws, range, rowIdx, options));
	out.push("</table>" + footer);
	return out.join("");
}
/** Unescape basic HTML entities */
function unescapeHtml(s) {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}
/** Strip HTML tags from a string, returning only text content */
function stripTags(s) {
	return s.replace(/<[^>]*>/g, "");
}
/** Extract an attribute value from a tag string */
function getAttr(tag, name) {
	const re = new RegExp(name + "\\s*=\\s*\"([^\"]*)\"", "i");
	const m = tag.match(re);
	return m ? m[1] : null;
}
/** Coerce a data-v value based on data-t type code */
function coerceDataValue(type, rawValue) {
	switch (type) {
		case "n": return Number(rawValue);
		case "b": return rawValue === "true" || rawValue === "1";
		case "d": return rawValue;
		case "e": return rawValue;
		default: return rawValue;
	}
}
/** Try to coerce a plain text value to number or boolean */
function coerceTextValue(text) {
	if (text === "") return text;
	if (text === "TRUE" || text === "true") return true;
	if (text === "FALSE" || text === "false") return false;
	const num = Number(text);
	if (text.length > 0 && !isNaN(num) && isFinite(num)) return num;
	return text;
}
/**
* Parse an HTML string containing a `<table>` into a WorkSheet.
*
* Handles `rowspan`/`colspan` attributes and uses `data-t`/`data-v`
* attributes (when present) for round-trip fidelity.
*
* @param html - HTML string containing a table
* @returns A WorkSheet with the parsed table data
*/
function htmlToSheet(html) {
	const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
	if (!tableMatch) return arrayToSheet([]);
	const rowMatches = tableMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
	const data = [];
	const occupied = {};
	for (let r = 0; r < rowMatches.length; r++) {
		if (!data[r]) data[r] = [];
		if (!occupied[r]) occupied[r] = {};
		const cellMatches = rowMatches[r].match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
		let col = 0;
		for (let ci = 0; ci < cellMatches.length; ci++) {
			while (occupied[r][col]) col++;
			const cellHtml = cellMatches[ci];
			const tagEnd = cellHtml.indexOf(">");
			const tag = cellHtml.slice(0, tagEnd + 1);
			const rowspanStr = getAttr(tag, "rowspan");
			const colspanStr = getAttr(tag, "colspan");
			const rs = rowspanStr ? parseInt(rowspanStr, 10) : 1;
			const cs = colspanStr ? parseInt(colspanStr, 10) : 1;
			const dataT = getAttr(tag, "data-t");
			const dataV = getAttr(tag, "data-v");
			const innerHtml = cellHtml.slice(tagEnd + 1, cellHtml.lastIndexOf("</"));
			let value;
			if (dataT && dataV != null) value = coerceDataValue(dataT, unescapeHtml(dataV));
			else value = coerceTextValue(unescapeHtml(stripTags(innerHtml)).trim());
			data[r][col] = value;
			for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
				if (dr === 0 && dc === 0) continue;
				const tr = r + dr;
				const tc = col + dc;
				if (!occupied[tr]) occupied[tr] = {};
				occupied[tr][tc] = true;
			}
			for (let dc = 1; dc < cs; dc++) data[r][col + dc] = "";
			col += cs;
		}
	}
	return arrayToSheet(data);
}

//#endregion
//#region src/read.ts
/**
* Normalize any supported input type into a Uint8Array for ZIP parsing.
*
* Handles Uint8Array, ArrayBuffer, Node Buffer, base64 strings, binary strings, and plain arrays.
*/
function to_uint8array(data, opts) {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.length);
	if (typeof data === "string") {
		if (opts.type === "base64") return base64decode(data);
		const u8 = new Uint8Array(data.length);
		for (let i = 0; i < data.length; ++i) u8[i] = data.charCodeAt(i);
		return u8;
	}
	if (Array.isArray(data)) return new Uint8Array(data);
	throw new XlsxError("INVALID_ARGUMENT", "Unsupported data type for read()");
}
/**
* Auto-detect the input data type based on its JavaScript type.
*
* Used when the caller does not explicitly set opts.type.
*/
function detect_type(data) {
	if (data instanceof Uint8Array || data instanceof ArrayBuffer) return "array";
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return "buffer";
	if (typeof data === "string") return "base64";
	return "array";
}
/** Wrap a single worksheet into a WorkBook */
function sheetToWorkBook(ws, name) {
	const n = name || "Sheet1";
	return {
		SheetNames: [n],
		Sheets: { [n]: ws }
	};
}
/**
* Read a spreadsheet from an in-memory data source.
*
* Supports XLSX (ZIP), CSV, and HTML input. For string input with type "string",
* auto-detects HTML (starts with "<") vs CSV.
*
* @param data - File contents as Uint8Array, ArrayBuffer, Buffer, base64 string, binary string, or plain text string
* @param opts - Read options controlling parsing behavior
* @returns Promise resolving to a parsed WorkBook object
* @throws XlsxError if the input is a PDF, PNG, or other unsupported format
*/
async function read(data, opts) {
	resetFormatTable();
	const options = opts ? { ...opts } : {};
	if (!options.type) options.type = detect_type(data);
	if (options.type === "string" && typeof data === "string") {
		if (data.trimStart().charAt(0) === "<") return sheetToWorkBook(htmlToSheet(data));
		return sheetToWorkBook(csvToSheet(data));
	}
	const u8 = to_uint8array(data, options);
	if (u8[0] === 80 && u8[1] === 75) {
		const archive = await zipRead(u8, options);
		const parsed = parseZip(archive, options);
		// NAYIVE: with `keepZip`, hand the caller the inflated archive as well.
		// parseZip models only what this library understands; charts, images,
		// data validation and conditional formatting are dropped on the floor.
		// Calc needs the untouched parts to tell the user what a save would
		// destroy — and, later, to copy them back into the file it writes.
		if (options.keepZip) parsed._zip = archive;
		return parsed;
	}
	if (u8[0] === 37 && u8[1] === 80 && u8[2] === 68 && u8[3] === 70) throw new XlsxError("UNSUPPORTED", "PDF File is not a spreadsheet");
	if (u8[0] === 137 && u8[1] === 80 && u8[2] === 78 && u8[3] === 71) throw new XlsxError("UNSUPPORTED", "PNG Image File is not a spreadsheet");
	throw new XlsxError("UNSUPPORTED", "Unsupported file format. xlsx-format only supports XLSX files.");
}

//#endregion
//#region src/xlsx/write-zip.ts
/**
* Write a WorkBook to a ZIP archive in XLSX format.
*
* Orchestrates the serialization of all workbook parts: core/extended/custom
* properties, worksheets, shared strings, styles, theme, metadata, comments
* (both simple and threaded), VML drawings, and relationships.
*
* @param wb - WorkBook to serialize
* @param opts - Write options (mutated to carry shared state like Strings and rels)
* @returns ZipArchive containing all XLSX parts ready for final compression
*/
function writeZipXlsx(wb, opts) {
	if (wb && !wb.SSF) wb.SSF = { ...formatTable };
	if (wb && wb.SSF) {
		resetFormatTable();
		loadFormatTable(wb.SSF);
	}
	opts.rels = { "!id": {} };
	opts.wbrels = { "!id": {} };
	opts.Strings = [];
	opts.Strings.Count = 0;
	opts.Strings.Unique = 0;
	opts.revStrings = /* @__PURE__ */ new Map();
	const ct = createContentTypes();
	const zip = zipCreate();
	let filePath = "";
	opts.cellXfs = [];
	if (opts.cellStyles) opts.styleRegistry = buildStyleRegistry(wb, opts);
	if (!wb.Props) wb.Props = {};
	filePath = "docProps/core.xml";
	zipAddString(zip, filePath, writeCoreProperties(wb.Props, opts));
	ct.coreprops.push(filePath);
	addRelationship(opts.rels, 2, filePath, RELS.CORE_PROPS);
	filePath = "docProps/app.xml";
	if (wb.Props && wb.Props.SheetNames) {} else if (!wb.Workbook || !wb.Workbook.Sheets) wb.Props.SheetNames = wb.SheetNames;
	else {
		const visibleSheetNames = [];
		for (let sheetIdx = 0; sheetIdx < wb.SheetNames.length; ++sheetIdx) if ((wb.Workbook.Sheets[sheetIdx] || {}).Hidden !== 2) visibleSheetNames.push(wb.SheetNames[sheetIdx]);
		wb.Props.SheetNames = visibleSheetNames;
	}
	wb.Props.Worksheets = wb.Props.SheetNames.length;
	zipAddString(zip, filePath, writeExtendedProperties(wb.Props));
	ct.extprops.push(filePath);
	addRelationship(opts.rels, 3, filePath, RELS.EXT_PROPS);
	if (wb.Custprops !== wb.Props && Object.keys(wb.Custprops || {}).length > 0) {
		filePath = "docProps/custom.xml";
		zipAddString(zip, filePath, writeCustomProperties(wb.Custprops));
		ct.custprops.push(filePath);
		addRelationship(opts.rels, 4, filePath, RELS.CUST_PROPS);
	}
	const people = ["SheetJ5"];
	opts.tcid = 0;
	for (let rId = 1; rId <= wb.SheetNames.length; ++rId) {
		const wsrels = { "!id": {} };
		const ws = wb.Sheets[wb.SheetNames[rId - 1]];
		filePath = "xl/worksheets/sheet" + rId + ".xml";
		zipAddString(zip, filePath, writeWorksheetXml(ws || {}, opts, rId - 1, wsrels, wb));
		ct.sheets.push(filePath);
		addRelationship(opts.wbrels, -1, "worksheets/sheet" + rId + ".xml", RELS.SHEET);
		if (ws) {
			const comments = ws["!comments"];
			let need_vml = false;
			if (comments && comments.length > 0) {
				let needtc = false;
				comments.forEach((carr) => {
					carr[1].forEach((c) => {
						if (c.T === true) needtc = true;
					});
				});
				if (needtc) {
					const cf = "xl/threadedComments/threadedComment" + rId + ".xml";
					zipAddString(zip, cf, writeTcmntXml(comments, people, opts));
					ct.threadedcomments.push(cf);
					addRelationship(wsrels, -1, "../threadedComments/threadedComment" + rId + ".xml", RELS.TCMNT);
				}
				const cf2 = "xl/comments" + rId + ".xml";
				zipAddString(zip, cf2, writeCommentsXml(comments));
				ct.comments.push(cf2);
				addRelationship(wsrels, -1, "../comments" + rId + ".xml", RELS.CMNT);
				need_vml = true;
			}
			if (ws["!legacy"] && need_vml) zipAddString(zip, "xl/drawings/vmlDrawing" + rId + ".vml", writeVml(rId, ws["!comments"]));
			delete ws["!comments"];
			delete ws["!legacy"];
		}
		if (wsrels["!id"].rId1) zipAddString(zip, getRelsPath(filePath), writeRelationships(wsrels));
	}
	if (opts.Strings != null && opts.Strings.length > 0) {
		filePath = "xl/sharedStrings.xml";
		zipAddString(zip, filePath, writeSstXml(opts.Strings, opts));
		ct.strs.push(filePath);
		addRelationship(opts.wbrels, -1, "sharedStrings.xml", RELS.SST);
	}
	filePath = "xl/workbook.xml";
	zipAddString(zip, filePath, writeWorkbookXml(wb));
	ct.workbooks.push(filePath);
	addRelationship(opts.rels, 1, filePath, RELS.WB);
	filePath = "xl/theme/theme1.xml";
	zipAddString(zip, filePath, write_theme_xml());
	ct.themes.push(filePath);
	addRelationship(opts.wbrels, -1, "theme/theme1.xml", RELS.THEME);
	filePath = "xl/styles.xml";
	zipAddString(zip, filePath, writeStylesXml(wb, opts));
	ct.styles.push(filePath);
	addRelationship(opts.wbrels, -1, "styles.xml", RELS.STY);
	filePath = "xl/metadata.xml";
	zipAddString(zip, filePath, writeMetadataXml());
	ct.metadata.push(filePath);
	addRelationship(opts.wbrels, -1, "metadata.xml", RELS.META);
	if (people.length > 1) {
		filePath = "xl/persons/person.xml";
		zipAddString(zip, filePath, writePeopleXml(people));
		ct.people.push(filePath);
		addRelationship(opts.wbrels, -1, "persons/person.xml", RELS.PEOPLE);
	}
	zipAddString(zip, "[Content_Types].xml", writeContentTypes(ct, opts));
	zipAddString(zip, "_rels/.rels", writeRelationships(opts.rels));
	zipAddString(zip, "xl/_rels/workbook.xml.rels", writeRelationships(opts.wbrels));
	if (opts.preserve) preserveSourceParts(zip, opts.preserve, wb);
	return zip;
}

/**
* NAYIVE: copy the parts of the ORIGINAL file that this library cannot rebuild.
*
* writeZipXlsx builds a brand-new package from the workbook model, so anything the
* model does not describe — charts, the drawings and images they sit on, table
* definitions — simply would not be in the output. The worksheets now carry
* `!raw.refs` pointing at those parts; this copies each one across, follows its own
* .rels so nothing it depends on is left behind, and declares the lot in
* [Content_Types].xml. Conditional formatting is put back by the sheet writer, but
* its `dxfId`s index a <dxfs> block in styles.xml that this library never writes, so
* the source's block is spliced in whole to keep those indices meaning the same thing.
*
* @param zip - the freshly written package, modified in place
* @param src - the inflated source archive (from `read` with `keepZip`)
* @param wb - the workbook being written
*/
function preserveSourceParts(zip, src, wb) {
	if (!src || !src.files) return;

	const norm = (path) => String(path || "").replace(/^\//, "");
	const relsPathOf = (part) => {
		const i = part.lastIndexOf("/");
		return part.slice(0, i + 1) + "_rels/" + part.slice(i + 1) + ".rels";
	};
	// Resolve a .rels Target against the part that owns it ("../charts/c1.xml").
	const resolve = (owner, target) => {
		if (target.charAt(0) === "/") return norm(target);
		const base = owner.slice(0, owner.lastIndexOf("/") + 1).split("/").filter(Boolean);
		for (const seg of target.split("/")) {
			if (seg === "." || seg === "") continue;
			if (seg === "..") base.pop();
			else base.push(seg);
		}
		return base.join("/");
	};

	// Every part any worksheet points at, plus everything those reach in turn.
	const wanted = [];
	for (const name of wb.SheetNames || []) {
		const refs = ((wb.Sheets[name] || {})["!raw"] || {}).refs || [];
		for (const ref of refs) if (ref && ref.target) wanted.push(norm(ref.target));
	}

	const copied = new Set();
	const queue = wanted.slice();
	while (queue.length) {
		const part = queue.shift();
		if (copied.has(part) || !src.files[part]) continue;
		copied.add(part);
		if (!zip.files[part]) zip.files[part] = src.files[part];

		const rp = relsPathOf(part);
		if (!src.files[rp]) continue;
		if (!zip.files[rp]) zip.files[rp] = src.files[rp];
		copied.add(rp);

		const relsXml = decoder$1.decode(src.files[rp]);
		const re = /Target="([^"]+)"([^>]*)/g;
		let m;
		while ((m = re.exec(relsXml)) !== null) {
			if (m[2].indexOf("External") !== -1) continue;   // a URL, not a part
			queue.push(resolve(part, m[1]));
		}
	}
	if (!copied.size) return;

	declareContentTypes(zip, src, copied);
	carryDxfs(zip, src);
}

/** NAYIVE: give every copied part its [Content_Types].xml entry. */
function declareContentTypes(zip, src, copied) {
	const ctPath = "[Content_Types].xml";
	if (!zip.files[ctPath] || !src.files[ctPath]) return;

	let out = decoder$1.decode(zip.files[ctPath]);
	const from = decoder$1.decode(src.files[ctPath]);
	const add = [];

	for (const part of copied) {
		const abs = "/" + part;
		if (out.indexOf("PartName=\"" + abs + "\"") !== -1) continue;

		const ov = new RegExp("<Override PartName=\"" + abs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"[^>]*/>").exec(from);
		if (ov) { add.push(ov[0]); continue; }

		// No Override: the part is covered by a <Default> for its extension.
		const ext = part.slice(part.lastIndexOf(".") + 1);
		if (out.indexOf("Extension=\"" + ext + "\"") !== -1) continue;
		const df = new RegExp("<Default Extension=\"" + ext + "\"[^>]*/>").exec(from);
		if (df) add.push(df[0]);
	}
	if (!add.length) return;

	// Defaults must precede Overrides in [Content_Types].xml.
	const defaults = add.filter((x) => x.indexOf("<Default") === 0);
	const overrides = add.filter((x) => x.indexOf("<Default") !== 0);
	if (defaults.length) out = out.replace("<Override", defaults.join("") + "<Override");
	if (overrides.length) out = out.replace("</Types>", overrides.join("") + "</Types>");
	zipAddString(zip, ctPath, out);
}

/** NAYIVE: carry the source <dxfs> block so conditional-formatting dxfIds still resolve. */
function carryDxfs(zip, src) {
	const p = "xl/styles.xml";
	if (!zip.files[p] || !src.files[p]) return;

	const out = decoder$1.decode(zip.files[p]);
	if (out.indexOf("<dxfs") !== -1) return;

	const m = /<dxfs[\s>][\s\S]*?<\/dxfs>/.exec(decoder$1.decode(src.files[p]));
	if (!m) return;

	// dxfs sits after cellStyles and before tableStyles in CT_Stylesheet.
	zipAddString(zip, p, out.indexOf("</cellStyles>") !== -1
		? out.replace("</cellStyles>", "</cellStyles>" + m[0])
		: out.replace("</styleSheet>", m[0] + "</styleSheet>"));
}

//#endregion
//#region src/write.ts
/** Encode a text string as a UTF-8 Uint8Array */
function textToUint8Array(text) {
	return new TextEncoder().encode(text);
}
/** Convert text output to the requested output type */
function textOutput(text, type) {
	switch (type) {
		case "string": return text;
		case "base64": return base64encode(textToUint8Array(text));
		case "buffer":
			if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8");
			return textToUint8Array(text);
		case "array": return textToUint8Array(text);
		default: return text;
	}
}
/** Get the first worksheet from a workbook */
function firstSheet(wb) {
	return wb.Sheets[wb.SheetNames[0]];
}
/**
* Write a WorkBook to an in-memory representation.
*
* Supports XLSX (default), CSV, TSV, and HTML output formats via opts.bookType.
*
* @param wb - WorkBook object to serialize
* @param opts - Write options controlling output format and behavior
* @returns Promise resolving to the serialized data in the requested format
*/
async function write(wb, opts) {
	resetFormatTable();
	if (!opts || !opts.unsafe) validateWorkbook(wb);
	const options = { ...opts };
	if (options.cellStyles) {
		options.cellNF = true;
		options.sheetStubs = true;
	}
	switch (options.bookType || "xlsx") {
		case "csv": {
			const ws = firstSheet(wb);
			return textOutput(ws ? sheetToCsv(ws, options) : "", options.type);
		}
		case "tsv": {
			const ws = firstSheet(wb);
			return textOutput(ws ? sheetToTxt(ws, options) : "", options.type);
		}
		case "html": {
			const ws = firstSheet(wb);
			return textOutput(ws ? sheetToHtml(ws, options) : "", options.type);
		}
		default: {
			const compressed = await zipWrite(writeZipXlsx(wb, options), !!options.compression);
			switch (options.type) {
				case "base64": return base64encode_u8(compressed);
				case "buffer":
					if (typeof Buffer !== "undefined") return Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength);
					return compressed;
				case "array": return compressed;
				default: return compressed;
			}
		}
	}
}
/** Thin wrapper to encode Uint8Array to base64 */
function base64encode_u8(data) {
	return base64encode(data);
}

//#endregion
//#region src/api/book.ts
/**
* Create a new blank workbook, optionally containing an initial worksheet.
*
* @param ws - Optional worksheet to include as the first sheet
* @param wsname - Name for the initial sheet (defaults to "Sheet1")
* @returns A new workbook object
*/
function createWorkbook(ws, wsname) {
	const wb = {
		SheetNames: [],
		Sheets: {}
	};
	if (ws) appendSheet(wb, ws, wsname || "Sheet1");
	return wb;
}
/**
* Append a worksheet to the end of a workbook's sheet list.
*
* If no name is provided, generates one automatically ("Sheet1", "Sheet2", ...).
* When `roll` is true and the name already exists, appends an incrementing
* numeric suffix to make it unique (e.g. "Sheet1" -> "Sheet2").
*
* @param wb - The workbook to add the sheet to
* @param ws - The worksheet to append
* @param name - Optional sheet name; auto-generated if omitted
* @param roll - If true, auto-increment the name suffix on collision instead of throwing
* @returns The final sheet name that was used
*/
function appendSheet(wb, ws, name, roll) {
	let i = 1;
	if (!name) {
		for (; i <= 65535; ++i, name = void 0) if (wb.SheetNames.indexOf(name = "Sheet" + i) === -1) break;
	}
	if (!name || wb.SheetNames.length >= 65535) throw new XlsxError("LIMIT_EXCEEDED", "Too many worksheets");
	if (roll && wb.SheetNames.indexOf(name) >= 0 && name.length < 32) {
		const m = name.match(/\d+$/);
		i = m && +m[0] || 0;
		const root = m && name.slice(0, m.index) || name;
		for (++i; i <= 65535; ++i) if (wb.SheetNames.indexOf(name = root + i) === -1) break;
	}
	validateSheetName(name);
	if (wb.SheetNames.indexOf(name) >= 0) throw new XlsxError("DUPLICATE", "Worksheet with name |" + name + "| already exists!");
	wb.SheetNames.push(name);
	wb.Sheets[name] = ws;
	return name;
}
/**
* Create a new empty worksheet.
*
* @param opts - Optional settings; set `dense: true` for dense storage mode (array-of-arrays backing)
* @returns A new empty worksheet object
*/
function createSheet(opts) {
	const out = {};
	if (opts?.dense) out["!data"] = [];
	return out;
}
/**
* Resolve a sheet name or numeric index to a validated sheet index.
*
* @param wb - The workbook to search
* @param sh - Sheet name (string) or zero-based sheet index (number)
* @returns The zero-based sheet index
* @throws If the sheet name or index is not found in the workbook
*/
function getSheetIndex(wb, sh) {
	if (typeof sh === "number") {
		if (sh >= 0 && wb.SheetNames.length > sh) return sh;
		throw new XlsxError("NOT_FOUND", "Cannot find sheet # " + sh);
	} else if (typeof sh === "string") {
		const idx = wb.SheetNames.indexOf(sh);
		if (idx !== -1) return idx;
		throw new XlsxError("NOT_FOUND", "Cannot find sheet name |" + sh + "|");
	}
	throw new XlsxError("NOT_FOUND", "Cannot find sheet |" + sh + "|");
}
/**
* Set the visibility state of a worksheet in the workbook.
*
* Initialises the `Workbook.Sheets` metadata array if it does not yet exist.
*
* @param wb - The workbook containing the sheet
* @param sh - Sheet name or zero-based index
* @param vis - Visibility level: 0 = visible, 1 = hidden, 2 = very hidden
*/
function setSheetVisibility(wb, sh, vis) {
	if (!wb.Workbook) wb.Workbook = {};
	if (!wb.Workbook.Sheets) wb.Workbook.Sheets = [];
	const idx = getSheetIndex(wb, sh);
	if (!wb.Workbook.Sheets[idx]) wb.Workbook.Sheets[idx] = {};
	switch (vis) {
		case 0:
		case 1:
		case 2: break;
		default: throw new XlsxError("INVALID_ARGUMENT", "Bad sheet visibility setting " + vis);
	}
	wb.Workbook.Sheets[idx].Hidden = vis;
}
/**
* Set the number format string on a cell.
*
* @param cell - The cell object to modify
* @param fmt - A number format string (e.g. "0.00%") or built-in format ID
* @returns The same cell object, for chaining
*/
function setCellNumberFormat(cell, fmt) {
	cell.z = fmt;
	return cell;
}
/**
* Set or replace the style object on a cell.
*
* Mutates `cell` in place and returns the same object for chaining.
*/
function setCellStyle(cell, style) {
	cell.s = style;
	return cell;
}
function expandSheetRef(ws, range) {
	if (!ws["!ref"]) {
		ws["!ref"] = encodeRange(range);
		return;
	}
	const current = decodeRange(ws["!ref"]);
	if (current.s.r > range.s.r) current.s.r = range.s.r;
	if (current.s.c > range.s.c) current.s.c = range.s.c;
	if (current.e.r < range.e.r) current.e.r = range.e.r;
	if (current.e.c < range.e.c) current.e.c = range.e.c;
	ws["!ref"] = encodeRange(current);
}
/**
* Apply a style to every existing cell in a range.
*
* Mutates `ws` in place and returns the same worksheet for chaining. When
* `createCells` is true, missing cells in the range are created as styled stubs.
*/
function styleRange(ws, range, style, opts) {
	const rng = typeof range === "string" ? safeDecodeRange(range) : range;
	const createCells = !!opts?.createCells;
	for (let R = rng.s.r; R <= rng.e.r; ++R) for (let C = rng.s.c; C <= rng.e.c; ++C) {
		const cell = createCells ? getOrCreateCell(ws, R, C) : getCell(ws, R, C);
		if (cell) cell.s = style;
	}
	if (createCells) expandSheetRef(ws, rng);
	return ws;
}
/**
* Add a merged-cell range and expand `!ref` to include it.
*
* Mutates `ws` in place and returns the same worksheet for chaining.
*/
function mergeCells(ws, range) {
	const rng = typeof range === "string" ? safeDecodeRange(range) : range;
	if (!ws["!merges"]) ws["!merges"] = [];
	ws["!merges"].push(rng);
	expandSheetRef(ws, rng);
	return ws;
}
/**
* Set a row height in points.
*
* Mutates `ws` in place and returns the same worksheet for chaining. Row indexes
* are zero-based.
*/
function setRowHeight(ws, row, hpt) {
	if (!ws["!rows"]) ws["!rows"] = [];
	if (!ws["!rows"][row]) ws["!rows"][row] = {};
	ws["!rows"][row].hpt = hpt;
	return ws;
}
/**
* Set a column width.
*
* Mutates `ws` in place and returns the same worksheet for chaining. Column
* indexes are zero-based.
*/
function setColumnWidth(ws, col, width) {
	if (!ws["!cols"]) ws["!cols"] = [];
	if (!ws["!cols"][col]) ws["!cols"][col] = {};
	ws["!cols"][col].width = width;
	return ws;
}
/**
* Freeze rows and/or columns in a worksheet view.
*
* Mutates `ws` in place and returns the same worksheet for chaining.
*/
function freezePanes(ws, pane) {
	ws["!views"] = [{
		state: "frozen",
		xSplit: pane.xSplit,
		ySplit: pane.ySplit
	}];
	return ws;
}
/**
* Set or remove a hyperlink on a cell.
*
* Pass `undefined` or an empty string for `target` to remove an existing link.
*
* @param cell - The cell object to modify
* @param target - The hyperlink URL or path; falsy to remove
* @param tooltip - Optional tooltip text shown on hover
* @returns The same cell object, for chaining
*/
function setCellHyperlink(cell, target, tooltip) {
	if (!target) delete cell.l;
	else {
		cell.l = { Target: target };
		if (tooltip) cell.l.Tooltip = tooltip;
	}
	return cell;
}
/**
* Set an internal (within-workbook) link on a cell.
*
* Internal links are prefixed with "#" to distinguish them from external URLs.
*
* @param cell - The cell object to modify
* @param range - The target cell reference or range string (e.g. "Sheet2!A1")
* @param tooltip - Optional tooltip text shown on hover
* @returns The same cell object, for chaining
*/
function setCellInternalLink(cell, range, tooltip) {
	return setCellHyperlink(cell, "#" + range, tooltip);
}
/**
* Add a comment (note) to a cell.
*
* Initialises the cell's comment array if it does not yet exist, then appends
* a new comment entry.
*
* @param cell - The cell object to modify
* @param text - The comment text content
* @param author - Optional author name (defaults to "SheetJS")
*/
function addCellComment(cell, text, author) {
	if (!cell.c) cell.c = [];
	cell.c.push({
		t: text,
		a: author || "SheetJS"
	});
}
/**
* Set an array formula across a rectangular range of cells.
*
* The formula is stored on the top-left cell of the range (`cell.f`), and every
* cell in the range receives the `cell.F` property indicating the array formula
* extent. Optionally marks the formula as a dynamic array formula.
*
* @param ws - The worksheet to modify
* @param range - The target range as a string (e.g. "A1:C3") or range object
* @param formula - The array formula expression (without surrounding braces)
* @param dynamic - If true, mark as a dynamic array formula (spill)
* @returns The modified worksheet
*/
function setArrayFormula(ws, range, formula, dynamic) {
	const rng = typeof range !== "string" ? range : safeDecodeRange(range);
	const rngstr = typeof range === "string" ? range : encodeRange(range);
	for (let R = rng.s.r; R <= rng.e.r; ++R) for (let C = rng.s.c; C <= rng.e.c; ++C) {
		const cell = getOrCreateCell(ws, R, C);
		cell.t = "n";
		cell.F = rngstr;
		delete cell.v;
		if (R === rng.s.r && C === rng.s.c) {
			cell.f = formula;
			if (dynamic) cell.D = true;
		}
	}
	if (ws["!ref"]) {
		const wsr = decodeRange(ws["!ref"]);
		if (wsr.s.r > rng.s.r) wsr.s.r = rng.s.r;
		if (wsr.s.c > rng.s.c) wsr.s.c = rng.s.c;
		if (wsr.e.r < rng.e.r) wsr.e.r = rng.e.r;
		if (wsr.e.c < rng.e.c) wsr.e.c = rng.e.c;
		ws["!ref"] = encodeRange(wsr);
	}
	return ws;
}
/**
* Convert a worksheet to an array of formula strings.
*
* Each entry has the format "CellRef=Value" (e.g. "A1=42", "B2='Hello").
* For array formulas, the ref is the full range (e.g. "A1:C3={formula}").
* String values are prefixed with a single quote; booleans become TRUE/FALSE.
*
* @param ws - The worksheet to extract formulas from
* @returns An array of "ref=value" strings representing every non-empty cell
*/
function sheetToFormulae(ws) {
	if (ws == null || ws["!ref"] == null) return [];
	const r = safeDecodeRange(ws["!ref"]);
	const cols = [];
	const cmds = [];
	for (let C = r.s.c; C <= r.e.c; ++C) cols[C] = encodeCol(C);
	for (let R = r.s.r; R <= r.e.r; ++R) {
		const rr = encodeRow(R);
		for (let C = r.s.c; C <= r.e.c; ++C) {
			const y = cols[C] + rr;
			const x = getCell(ws, R, C);
			if (x === void 0) continue;
			let val = "";
			let ref = y;
			if (x.F != null) {
				ref = x.F;
				if (!x.f) continue;
				val = x.f;
				if (ref.indexOf(":") === -1) ref = ref + ":" + ref;
			}
			if (x.f != null) val = x.f;
			else if (x.t === "z") continue;
			else if (x.t === "n" && x.v != null) val = "" + x.v;
			else if (x.t === "b") val = x.v ? "TRUE" : "FALSE";
			else if (x.w !== void 0) val = "'" + x.w;
			else if (x.v === void 0) continue;
			else if (x.t === "s") val = "'" + x.v;
			else val = "" + x.v;
			cmds.push(ref + "=" + val);
		}
	}
	return cmds;
}

//#endregion
//#region src/index.ts
const version = "2.4.1";

//#endregion
export { XlsxError, addArrayToSheet, addCellComment, addJsonToSheet, appendSheet, arrayToSheet, createSheet, createWorkbook, csvToSheet, decodeCell, decodeCol, decodeRange, decodeRow, encodeCell, encodeCol, encodeRange, encodeRow, formatCell, formatNumber, freezePanes, getSheetIndex, htmlToSheet, jsonToSheet, mergeCells, read, setArrayFormula, setCellHyperlink, setCellInternalLink, setCellNumberFormat, setCellStyle, setColumnWidth, setRowHeight, setSheetVisibility, sheetToArray, sheetToCsv, sheetToFormulae, sheetToHtml, sheetToJson, sheetToTxt, styleRange, version, write };
//# sourceMappingURL=index.js.map