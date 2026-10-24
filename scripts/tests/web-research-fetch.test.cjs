// Tests for the outbound fetch path: the address a connection uses is the one checked at connect time, redirects are
// validated again, and private, documentation and IPv4-mapped addresses are refused.
//
// WHAT IS MOCKED, AND WHAT IS NOT. Three layers are used, and each test says which one it uses.
//  1. DNS (dns.promises.lookup): replaced by withDns() in every test that calls it. No name is resolved.
//  2. The request functions (http.get / https.get): replaced by withRequests() only in the tests that call it. The
//     fake calls the request's own `lookup` option, the way Node does, so the connect-time check still runs on every
//     hop. It never opens a socket. Its redirect, size, status and request-option tests are mocked transport tests.
//  3. The real request path: the "rebinding (real Node request ...)" tests and the two "rebinding:" tests that do not
//     call withRequests() use Node's real http.get / https.get, with only DNS mocked. In the real-Node test, the test
//     owns a TCP listener on 127.0.0.1 and counts every connection it accepts, so a refused connect shows as zero.
//
// NOT TESTED HERE: a real TLS handshake, a real redirect chain on the internet, the behaviour of a real DNS server,
// and any real private-network service. Those need a live test in a controlled environment.

const assert = require("node:assert/strict");
const dns = require("node:dns").promises;
const EventEmitter = require("node:events");
const http = require("node:http");
const net = require("node:net");
const https = require("node:https");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const content = require(path.join(root, "scripts", "search", "content.js"));
const { fetchRawDocument, connectionOptions, safeLookup, isPrivateIp, MAX_REDIRECTS } = content;

// Replaces dns.promises.lookup with a function that answers from `records` (host -> array of addresses, or a
// function returning the addresses for the nth call). Returns the calls it received.
async function withDns(records, run) {
  const original = dns.lookup;
  const calls = [];
  const counts = new Map();
  dns.lookup = async (host, options) => {
    calls.push({ host, options });
    const n = (counts.get(host) || 0) + 1;
    counts.set(host, n);
    const answer = records[host];
    const addresses = typeof answer === "function" ? answer(n) : answer;
    if (!addresses) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
      err.code = "ENOTFOUND";
      throw err;
    }
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  try {
    return await run(calls);
  } finally {
    dns.lookup = original;
  }
}

// Replaces http.get and https.get with a fake that never opens a socket. `respond(url)` returns the fake response.
// Every call records its URL and options. Like Node, the fake calls the request's `lookup` option when it would open
// a socket (not for an IP literal). If the lookup refuses the address, the request fails with that error, and no
// response is given. So the connect-time check is exercised on every hop, including redirects.
async function withRequests(respond, run) {
  const originals = { http: http.get, https: https.get };
  const calls = [];
  const fake = () => (url, options, callback) => {
    const target = String(url);
    const parsed = new URL(target);
    calls.push({ url: target, options });
    const req = new EventEmitter();
    req.destroy = () => {};
    const connect = () => new Promise((resolve, reject) => {
      if (net.isIP(bareHostOf(parsed)) || typeof options.lookup !== "function") return resolve();
      options.lookup(bareHostOf(parsed), { all: true }, (err, records) => (err ? reject(err) : resolve(records)));
    });
    connect().then(() => setImmediate(() => {
      const spec = respond(target);
      const res = new PassThrough();
      res.statusCode = spec.status || 200;
      res.headers = spec.headers || { "content-type": "text/html; charset=utf-8" };
      callback(res);
      if (spec.body !== undefined) res.end(spec.body);
      else res.end();
    }), (err) => setImmediate(() => req.emit("error", err)));
    return req;
  };
  http.get = fake("http:");
  https.get = fake("https:");
  try {
    return await run(calls);
  } finally {
    http.get = originals.http;
    https.get = originals.https;
  }
}

const bareHostOf = (parsed) => parsed.hostname.replace(/^\[|\]$/g, "");

const REAL_HTTP_GET = http.get;
const REAL_HTTPS_GET = https.get;

const PUBLIC = "93.184.216.34";
const PUBLIC_2 = "8.8.8.8";

// ---------------------------------------------------------------------------------------------------------------
// The request options: the connection uses the checked lookup, never a socket reused from a pool, and TLS uses the name
// ---------------------------------------------------------------------------------------------------------------

test("connection options: every request uses the connect-time lookup and gets its own socket", () => {
  const options = connectionOptions(new URL("https://example.test/a"), 5000);
  assert.equal(options.lookup, safeLookup, "the connection resolves through safeLookup");
  assert.equal(options.agent, false, "no keep-alive reuse: a reused socket would skip the lookup");
  assert.equal(options.timeout, 5000);
});

test("connection options: TLS uses the hostname for SNI, and an IP literal gets no SNI name", () => {
  assert.equal(connectionOptions(new URL("https://example.test/a"), 5000).servername, "example.test");
  assert.equal(connectionOptions(new URL("https://8.8.8.8/a"), 5000).servername, undefined);
  assert.equal(connectionOptions(new URL("http://example.test/a"), 5000).servername, undefined, "plain HTTP has no SNI");
});

test("fetch: the request passed to the transport carries the connect-time lookup and no pooled agent", async () => {
  await withDns({ "example.test": [PUBLIC] }, () => withRequests(() => ({ body: "<html><body>ok</body></html>" }), async (calls) => {
    const doc = await fetchRawDocument("https://example.test/page");
    assert.equal(doc.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.lookup, safeLookup);
    assert.equal(calls[0].options.agent, false);
    assert.equal(calls[0].options.servername, "example.test");
  }));
});

// ---------------------------------------------------------------------------------------------------------------
// DNS rebinding: a name that is public when checked, and private when the connection is made
// ---------------------------------------------------------------------------------------------------------------

test("rebinding: a name that resolves publicly during the early check and privately at connect time is refused", async () => {
  // The first lookup is the early check (public). The second is the connect-time lookup (private).
  const records = { "rebind.example.test": (call) => (call === 1 ? [PUBLIC] : ["127.0.0.1"]) };
  await withDns(records, async (calls) => {
    await assert.rejects(fetchRawDocument("https://rebind.example.test/x"), /Private network addresses are blocked/);
    assert.equal(calls.length, 2, "the connect-time lookup ran, not only the early check");
  });
});

test("rebinding: over plain HTTP the same connect-time refusal applies", async () => {
  const records = { "rebind.example.test": (call) => (call === 1 ? [PUBLIC] : ["10.0.0.5"]) };
  await withDns(records, async (calls) => {
    await assert.rejects(fetchRawDocument("http://rebind.example.test/x"), /Private network addresses are blocked/);
    assert.equal(calls.length, 2);
  });
});

test("rebinding: a name with one public and one private record is refused, because every record must be public", async () => {
  await withDns({ "mixed.example.test": [PUBLIC, "192.168.1.10"] }, async () => {
    await assert.rejects(fetchRawDocument("https://mixed.example.test/x"), /Private network addresses are blocked/);
  });
});

test("rebinding: the connect-time lookup returns only the validated public record to Node", async () => {
  // Node calls the lookup option with all:true when it connects. The record it returns is the one it will dial.
  await withDns({ "stable.example.test": [PUBLIC] }, async () => {
    const records = await new Promise((resolve, reject) => {
      safeLookup("stable.example.test", { all: true }, (err, recs) => (err ? reject(err) : resolve(recs)));
    });
    assert.deepEqual(records.map((item) => item.address), [PUBLIC]);
    const single = await new Promise((resolve, reject) => {
      safeLookup("stable.example.test", {}, (err, address) => (err ? reject(err) : resolve(address)));
    });
    assert.equal(single, PUBLIC);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real request path. Only DNS is mocked: the request goes through Node's own http.get, its own connect code and
// the lookup option. The test listens on 127.0.0.1 itself and counts every TCP connection it accepts. A refused
// connect means the count stays at zero.
// ---------------------------------------------------------------------------------------------------------------

test("rebinding (real Node request, DNS mocked): the connect-time lookup refuses a private record, and the listener accepts no connection", async () => {
  assert.equal(http.get, REAL_HTTP_GET, "the request function is Node's own, not a fake");
  let accepted = 0;
  const listener = net.createServer((socket) => {
    accepted += 1;
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  try {
    // The early check (first lookup) sees a public address. Node's connect-time lookup (second) sees 127.0.0.1.
    const records = { "rebind-real.example.test": (call) => (call === 1 ? [PUBLIC] : ["127.0.0.1"]) };
    await withDns(records, async (calls) => {
      await assert.rejects(fetchRawDocument(`http://rebind-real.example.test:${port}/x`), /Private network addresses are blocked/);
      assert.equal(calls.length, 2, "the connect-time lookup ran inside Node's request");
    });
    // Wait a moment, so that a connection that should not have happened would be counted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(accepted, 0, "no TCP connection reached the loopback listener");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Redirects: every target is validated and dialled through the same checked lookup.
// These tests use the MOCKED transport (withRequests); they do not open a socket.
// ---------------------------------------------------------------------------------------------------------------

const redirectTo = (location) => () => ({ status: 302, headers: { location, "content-type": "text/html" }, body: "" });

test("redirect: a redirect to a private IPv4 literal is refused before any request is made", async () => {
  await withDns({ "start.example.test": [PUBLIC] }, () => withRequests(
    (url) => (url.startsWith("https://start.example.test") ? redirectTo("http://10.0.0.1/admin")() : { body: "" }),
    async (calls) => {
      await assert.rejects(fetchRawDocument("https://start.example.test/begin"), /Private network URLs are blocked/);
      assert.equal(calls.length, 1, "only the first hop was requested");
    },
  ));
});

test("redirect: loopback, IPv6 loopback, IPv4-mapped IPv6 and localhost targets are all refused", async () => {
  for (const target of ["http://127.0.0.1/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://localhost/", "http://[::ffff:c0a8:0101]/"]) {
    await withDns({ "start.example.test": [PUBLIC] }, () => withRequests(
      (url) => (url.startsWith("https://start.example.test") ? redirectTo(target)() : { body: "" }),
      async (calls) => {
        await assert.rejects(fetchRawDocument("https://start.example.test/begin"), /Localhost|Private network/, target);
        assert.equal(calls.length, 1, `${target} was not requested`);
      },
    ));
  }
});

test("redirect: a redirect to a name that resolves privately is refused at the early check", async () => {
  await withDns({ "start.example.test": [PUBLIC], "inner.example.test": ["10.0.0.5"] }, () => withRequests(
    (url) => (url.startsWith("https://start.example.test") ? redirectTo("https://inner.example.test/x")() : { body: "" }),
    async (calls) => {
      await assert.rejects(fetchRawDocument("https://start.example.test/begin"), /Private network addresses are blocked/);
      assert.equal(calls.length, 1);
    },
  ));
});

test("redirect: a redirect target that is public when checked and private at connect time is refused", async () => {
  // The redirect target passes the early check (call 1) and is then resolved again for the connection (call 2).
  const records = {
    "start.example.test": [PUBLIC],
    "next.example.test": (call) => (call === 1 ? [PUBLIC_2] : ["127.0.0.1"]),
  };
  const served = [];
  await withDns(records, () => withRequests(
    (url) => {
      served.push(url);
      return url.startsWith("https://start.example.test") ? redirectTo("https://next.example.test/doc")() : { body: "<p>ok</p>" };
    },
    async (calls) => {
      await assert.rejects(fetchRawDocument("https://start.example.test/begin"), /Private network addresses are blocked/);
      // The second hop was attempted, but its connection was refused before any response was given.
      assert.equal(calls.length, 2);
      assert.deepEqual(served, ["https://start.example.test/begin"], "no response came from the private connection");
    },
  ));
});

test("redirect: a relative redirect to a public host is followed, and its request uses the connect-time lookup", async () => {
  await withDns({ "start.example.test": [PUBLIC], "docs.example.test": [PUBLIC_2] }, () => withRequests(
    (url) => (url === "https://start.example.test/begin" ? redirectTo("https://docs.example.test/final")() : { body: "<p>final</p>" }),
    async (calls) => {
      const doc = await fetchRawDocument("https://start.example.test/begin");
      assert.equal(doc.url, "https://docs.example.test/final");
      assert.equal(calls.length, 2);
      assert.equal(calls[1].options.lookup, safeLookup, "the redirect hop is dialled through the checked lookup");
      assert.equal(calls[1].options.agent, false);
    },
  ));
});

test("redirect: a redirect to a non-http scheme is refused", async () => {
  await withDns({ "start.example.test": [PUBLIC] }, () => withRequests(
    (url) => (url.startsWith("https://start.example.test") ? redirectTo("file:///etc/passwd")() : { body: "" }),
    async () => {
      await assert.rejects(fetchRawDocument("https://start.example.test/begin"), /Only HTTP and HTTPS/);
    },
  ));
});

test("redirect: a redirect loop stops at the redirect limit", async () => {
  await withDns({ "loop.example.test": [PUBLIC] }, () => withRequests(
    () => redirectTo("https://loop.example.test/again")(),
    async (calls) => {
      await assert.rejects(fetchRawDocument("https://loop.example.test/start"), /Too many redirects/);
      assert.equal(calls.length, MAX_REDIRECTS + 1, "the first request plus one per allowed redirect");
    },
  ));
});

// ---------------------------------------------------------------------------------------------------------------
// Ordinary public destinations, and the existing limits
// ---------------------------------------------------------------------------------------------------------------

test("public destination: an ordinary public host is fetched and returned", async () => {
  await withDns({ "news.example.test": [PUBLIC] }, () => withRequests(() => ({ body: "<title>Story</title><p>Body</p>" }), async (calls) => {
    const doc = await fetchRawDocument("https://news.example.test/story");
    assert.equal(doc.status, 200);
    assert.match(doc.body, /Story/);
    assert.equal(calls.length, 1);
  }));
});

test("public destination: a public IPv4 literal and a public IPv4-mapped IPv6 address are allowed", async () => {
  await withRequests(() => ({ body: "ok" }), async (calls) => {
    await fetchRawDocument("https://8.8.8.8/doc");
    await fetchRawDocument("http://[::ffff:8.8.8.8]/doc");
    assert.equal(calls.length, 2);
  });
});

test("size limit: a body over the limit is rejected, not returned as a truncated document", async () => {
  const big = "x".repeat(200 * 1024);
  await withDns({ "big.example.test": [PUBLIC] }, () => withRequests(() => ({ body: big }), async () => {
    await assert.rejects(fetchRawDocument("https://big.example.test/", { maxBytes: 64 * 1024 }), /too large/);
  }));
});

test("status: a non-success response is an error", async () => {
  await withDns({ "missing.example.test": [PUBLIC] }, () => withRequests(() => ({ status: 404, body: "" }), async () => {
    await assert.rejects(fetchRawDocument("https://missing.example.test/"), /HTTP 404/);
  }));
});

// ---------------------------------------------------------------------------------------------------------------
// Address classes
// ---------------------------------------------------------------------------------------------------------------

test("address classes: documentation and other non-routable ranges are refused, as the docs state", () => {
  for (const ip of ["192.0.2.10", "198.51.100.7", "203.0.113.9", "192.0.0.5", "2001:db8::1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be refused`);
  }
});

test("address classes: IPv4-mapped IPv6 private and public forms are classified by their IPv4 address", () => {
  assert.equal(isPrivateIp("::ffff:10.0.0.5"), true);
  assert.equal(isPrivateIp("::ffff:0a00:0005"), true, "hexadecimal form of 10.0.0.5");
  assert.equal(isPrivateIp("::ffff:c0a8:0101"), true, "hexadecimal form of 192.168.1.1");
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateIp("::ffff:0808:0808"), false, "hexadecimal form of 8.8.8.8");
});
