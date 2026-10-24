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
  const [a, b, c] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||     // 192.0.0.0/24 and TEST-NET-1 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||               // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||                // TEST-NET-3
    a >= 224;
}

// IPv6 address classification for the outbound fetcher.
//
// The policy follows the IANA IPv6 Special-Purpose Address Space registry (last updated 2025-10-09; read 2026-10-24):
// https://www.iana.org/assignments/iana-ipv6-special-registry
// Rows of that table are marked in the list below. fec0::/10 and ff00::/8 are not rows in the table: fec0::/10 is
// deprecated by RFC 3879 and ff00::/8 is multicast under RFC 4291. Both are blocked on those grounds. 2001:10::/28
// (deprecated ORCHID, terminated 2014-03) is also blocked here, though the table gives no flags for it.
//
// Each address is expanded to eight 16-bit groups before it is compared, so every spelling of the same address
// (for example 2001:0db8::1 and 2001:db8::1) gets the same answer. The rules, in order:
//  1. IPv4-mapped (::ffff:0:0/96). Classified by the IPv4 address it carries, as before.
//  2. ::/96. Blocked. This covers the unspecified and loopback addresses and the deprecated IPv4-compatible form.
//  3. Explicit blocks, whatever the rest of the address is:
//     - 64:ff9b::/96 (NAT64, well-known prefix). Blocked entirely, as before. The registry marks it globally
//       reachable, but the NAT64 gateway, not this fetcher, chooses the IPv4 destination, so it cannot be checked here.
//     - 64:ff9b:1::/48 (local-use translation), 100::/64 (discard-only), 100:0:0:1::/64 (dummy prefix),
//       fc00::/7 (unique-local), fe80::/10 (link-local), fec0::/10 (deprecated site-local), ff00::/8 (multicast),
//       2001:2::/48 (benchmarking), 2001:10::/28 (deprecated ORCHID), 2001:db8::/32 (documentation),
//       3fff::/20 (documentation, RFC 9637), 5f00::/16 (SRv6 SIDs, not globally reachable).
//  4. 6to4 (2002::/16). Classified by the IPv4 address it embeds (bits 16 to 47). Blocked when that address is not public.
//  5. Teredo (2001::/32). Blocked. The endpoint is hidden behind a relay, so the fetcher cannot check where it leads.
//  6. IETF protocol assignments (2001::/23). Blocked, as the registry says ("unless allowed by a more specific
//     allocation"). Allowed only for the entries the registry marks as globally reachable: the anycast services
//     2001:1::1/128, 2001:1::2/128 and 2001:1::3/128, AMT (2001:3::/32), AS112-v6 (2001:4:112::/48),
//     ORCHIDv2 (2001:20::/28) and Drone Remote ID (2001:30::/28).
//  7. Anything outside 2000::/3. Blocked. IANA allocates global unicast addresses only inside 2000::/3.
//  8. Anything else inside 2000::/3 is allowed. This includes ordinary allocations such as 2606:4700::/32 and
//     2001:4860::/32.
//
// Trade-off: rule 8 allows an address inside 2000::/3 that a later registry change marks as special-purpose,
// until this list is updated. Rule 7 is a default-deny for everything else. This classifier never fetches anything; it
// only decides whether an address may be connected to. The registry is copied by hand, so the list must be re-checked
// when the registry changes. Tests: scripts/tests/web-research-ipv6.test.cjs.

// Expands an IPv6 address to eight 16-bit numbers, or returns null when it is not a valid address. A zone identifier
// (fe80::1%eth0) is removed first, so the zone cannot change the classification. An embedded IPv4 suffix is converted.
function ipv6Words(text) {
  let value = String(text || "").toLowerCase().split("%")[0];
  if (!net.isIPv6(value)) return null;
  const dotted = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    value = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  // "::" stands for one or more groups of zeros. Without "::", all eight groups must be written.
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => parseInt(group, 16));
  return numbers.every((number) => Number.isInteger(number) && number >= 0 && number <= 0xffff) ? numbers : null;
}

// Whether the first `bits` bits of an address are the prefix.
function matchesPrefix(words, prefix, bits) {
  const expected = ipv6Words(prefix);
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i += 1) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((words[i] & mask) !== (expected[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

// Rules 3 (explicit blocks), 5 and 6 are checked in this order. Each entry is [prefix, bits, reason].
const IPV6_EXPLICIT_BLOCKS = [
  ["64:ff9b::", 96, "NAT64 well-known prefix: the gateway chooses the IPv4 destination"],
  ["64:ff9b:1::", 48, "local-use IPv4/IPv6 translation, not globally reachable"],
  ["100::", 64, "discard-only block"],
  ["100:0:0:1::", 64, "dummy IPv6 prefix"],
  ["fc00::", 7, "unique-local"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "deprecated site-local"],
  ["ff00::", 8, "multicast"],
  ["2001:2::", 48, "benchmarking"],
  ["2001:10::", 28, "deprecated ORCHID"],
  ["2001:db8::", 32, "documentation"],
  ["3fff::", 20, "documentation"],
  ["5f00::", 16, "segment routing SIDs, not globally reachable"],
];

// The more specific entries inside 2001::/23 that the registry marks as globally reachable. Each is [prefix, bits].
const IPV6_GLOBAL_EXCEPTIONS = [
  ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128],
  ["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28],
];

// The classification of one IPv6 address: { blocked, reason }. Reasons are for tests and documentation.
function ipv6Policy(ip) {
  const words = ipv6Words(ip);
  if (!words) return { blocked: true, reason: "not a valid IPv6 address" };
  const ipv4From = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join(".");

  // 1. IPv4-mapped: the IPv4 address decides.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return { blocked: isPrivateIpv4(ipv4From(words[6], words[7])), reason: "IPv4-mapped: classified by the IPv4 address it carries" };
  }
  // 2. ::/96 (unspecified, loopback, deprecated IPv4-compatible).
  if (words.slice(0, 6).every((word) => word === 0)) {
    return { blocked: true, reason: "::/96: unspecified, loopback, or deprecated IPv4-compatible" };
  }
  // 3. Explicit blocks.
  for (const [prefix, bits, reason] of IPV6_EXPLICIT_BLOCKS) {
    if (matchesPrefix(words, prefix, bits)) return { blocked: true, reason };
  }
  // 4. 6to4: the embedded IPv4 address decides.
  if (matchesPrefix(words, "2002::", 16)) {
    return { blocked: isPrivateIpv4(ipv4From(words[1], words[2])), reason: "6to4: classified by the IPv4 address it embeds" };
  }
  // 5. Teredo: blocked, because the endpoint cannot be checked.
  if (matchesPrefix(words, "2001::", 32)) {
    return { blocked: true, reason: "Teredo: the endpoint is behind a relay and cannot be checked" };
  }
  // 6. IETF protocol assignments: blocked unless listed as globally reachable.
  if (matchesPrefix(words, "2001::", 23)) {
    const listed = IPV6_GLOBAL_EXCEPTIONS.some(([prefix, bits]) => matchesPrefix(words, prefix, bits));
    return listed
      ? { blocked: false, reason: "listed in the registry as globally reachable" }
      : { blocked: true, reason: "IETF protocol assignments (2001::/23), not globally reachable unless listed" };
  }
  // 7. Outside the global unicast space: blocked.
  if ((words[0] & 0xe000) !== 0x2000) {
    return { blocked: true, reason: "outside 2000::/3, the global unicast space" };
  }
  // 8. Everything else inside 2000::/3 is an ordinary allocation.
  return { blocked: false, reason: "globally routable unicast" };
}

function isPrivateIpv6(ip) {
  return ipv6Policy(ip).blocked;
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

// Options for one outbound request. The address a connection uses is the one safeLookup returns at connect time,
// because Node calls the `lookup` option whenever it opens a socket. That lookup refuses any private record, so a
// hostname that resolved publicly during the early check cannot connect to a private address.
//  - agent: false. The default keep-alive agent can reuse a socket without calling lookup again. Every request
//    gets its own socket, so every connection is resolved and checked.
//  - servername. TLS uses the hostname for SNI and certificate checks, never the IP address.
function connectionOptions(parsed, timeoutMs) {
  const host = bareHost(parsed.hostname);
  const options = {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.2",
      "Accept-Encoding": "gzip, deflate, br",
    },
    timeout: timeoutMs,
    lookup: safeLookup,
    agent: false,
  };
  if (parsed.protocol === "https:" && !net.isIP(host)) options.servername = host;
  return options;
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
    const req = transport.get(parsed, connectionOptions(parsed, timeoutMs), async (res) => {
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
  connectionOptions,
  assertPublicUrl,
  safeLookup,
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  ipv6Policy,
  ipv6Words,
  stripHtml,
  MAX_REDIRECTS,
};
