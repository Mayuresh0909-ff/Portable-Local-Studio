const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const net = require("net");
const zlib = require("zlib");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAIStudio/1.0";
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 768 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

// IPv4 ranges that must never be fetched: loopback, private, link-local, CGNAT, benchmarking, multicast and reserved.
function isPrivateIpv4(ip) {
  const parts = String(ip || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

// Converts the hex form of an IPv4-mapped address (::ffff:7f00:1) to dotted IPv4.
function mappedIpv4(value) {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return null;
}

function isPrivateIpv6(ip) {
  const value = String(ip || "").toLowerCase();
  const mapped = mappedIpv4(value);
  if (mapped) return isPrivateIpv4(mapped);
  if (value.startsWith("::ffff:") || value.startsWith("64:ff9b::")) return true;
  const first = parseInt(value.split(":")[0] || "0", 16);
  return value === "::1" ||
    value === "::" ||
    (first & 0xfe00) === 0xfc00 ||   // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 ||   // fe80::/10 link local
    (first & 0xff00) === 0xff00;     // ff00::/8 multicast
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

function bareHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

async function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs can be fetched.");
  }
  const host = bareHost(parsed.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Localhost URLs are blocked.");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Private network URLs are blocked.");
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: false });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("Private network addresses are blocked.");
  }
}

// DNS lookup used when the connection is made. The address is checked again at connect time, so a
// hostname that changes between the early check and the connection cannot reach a private address.
function safeLookup(hostname, options, callback) {
  const wantsAll = Boolean(options && options.all);
  const host = bareHost(hostname);
  const finish = (records) => {
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
      callback(new Error("Private network addresses are blocked."));
      return;
    }
    if (wantsAll) {
      callback(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
  if (net.isIP(host)) {
    finish([{ address: host, family: net.isIP(host) }]);
    return;
  }
  dns.lookup(host, { all: true, verbatim: false }).then(finish, (err) => callback(err));
}

function stripHtml(html) {
  const withoutNoise = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  const title = decodeHtml((withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const mainMatch = withoutNoise.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    withoutNoise.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    withoutNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const contentHtml = mainMatch ? mainMatch[1] : withoutNoise;
  const text = decodeHtml(contentHtml
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
  return { title, text };
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || "").toLowerCase();
  if (value.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
  if (value.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
  if (value.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

function acceptableContentType(contentType) {
  return contentType.includes("text/") || contentType.includes("html") || contentType.includes("xml") || contentType.includes("json");
}

// Fetches a text, HTML, XML or JSON document. Every redirect target is validated before it is followed.
// Resolves to { url, status, contentType, body }. Rejects on a blocked, failed or oversized response.
async function fetchRawDocument(rawUrl, options = {}, redirects = 0) {
  await assertPublicUrl(rawUrl);
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000));
  const hardMax = Math.max(64 * 1024, Math.min(Number(options.hardMaxBytes) || HARD_MAX_BYTES, 16 * 1024 * 1024));
  const maxBytes = Math.max(64 * 1024, Math.min(hardMax, Number(options.maxBytes) || DEFAULT_MAX_BYTES));
  const parsed = new URL(rawUrl);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.get(parsed, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.2",
        "Accept-Encoding": "gzip, deflate, br",
      },
      timeout: timeoutMs,
      lookup: safeLookup,
    }, async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error("Too many redirects."));
          return;
        }
        try {
          const nextUrl = new URL(res.headers.location, parsed).toString();
          resolve(await fetchRawDocument(nextUrl, options, redirects + 1));
        } catch (err) {
          reject(err);
        }
        return;
      }
      const contentType = String(res.headers["content-type"] || "").toLowerCase();
      if (res.statusCode < 200 || res.statusCode >= 300 || !acceptableContentType(contentType)) {
        res.resume();
        reject(new Error(`Page returned HTTP ${res.statusCode || "unknown"} or unsupported content type.`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      res.on("data", (chunk) => {
        if (tooLarge) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          // Reject at once, so a truncated body can never resolve as a complete document.
          tooLarge = true;
          reject(new Error("Page content is too large."));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (tooLarge) return;
        try {
          const body = decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]);
          resolve({ url: parsed.toString(), status: res.statusCode, contentType, body });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Page fetch timed out.")));
    req.on("error", reject);
  });
}

// Fetches a page and returns its visible text. JSON documents are returned as their raw text.
async function fetchPageContent(rawUrl, options = {}) {
  const doc = await fetchRawDocument(rawUrl, options);
  if (doc.contentType.includes("json")) {
    return { title: "", text: doc.body, url: doc.url, contentType: doc.contentType };
  }
  const { title, text } = stripHtml(doc.body);
  return { title, text, url: doc.url, contentType: doc.contentType };
}

module.exports = {
  fetchPageContent,
  fetchRawDocument,
  assertPublicUrl,
  safeLookup,
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  stripHtml,
  MAX_REDIRECTS,
};
