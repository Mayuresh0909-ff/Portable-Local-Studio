// Tests for the IPv6 address policy of the outbound fetcher (scripts/search/content.js, ipv6Policy).
//
// These tests are offline. They call the real classifier and the real URL check on address literals, without
// resolving any name and without opening a socket. The policy follows the IANA IPv6 Special-Purpose Address
// Space registry (last updated 2025-10-09; read 2026-10-24). The registry is copied by hand into content.js, so
// re-check it when the registry changes. These tests show how each address is classified. They do not show what
// a real network does with it.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const content = require(path.join(root, "scripts", "search", "content.js"));
const { ipv6Policy, isPrivateIp, assertPublicUrl } = content;

const blocked = (ip) => ipv6Policy(ip).blocked;

// --- The prefixes named in the regression list -------------------------------------------------------------------

test("registry: the discard-only prefix 100::/64 is blocked, and so is the dummy prefix 100:0:0:1::/64", () => {
  for (const ip of ["100::1", "100::ffff:1", "100:0:0:0:ffff:ffff:ffff:ffff"]) assert.equal(blocked(ip), true, ip);
  assert.equal(blocked("100:0:0:1::1"), true, "RFC 9780 dummy prefix");
});

test("registry: each explicit block is recorded under its own reason (100::/64 is also outside 2000::/3, so the reason shows which rule fired)", () => {
  // 100::/64 is outside 2000::/3, so the outside-the-global-space rule would block it too. Checking the reason shows the
  // registry entry itself is in place, and is not left to the fallback.
  assert.match(ipv6Policy("100::1").reason, /discard-only/);
  assert.match(ipv6Policy("100:0:0:1::1").reason, /dummy/);
  assert.match(ipv6Policy("3fff::1").reason, /documentation/);
  assert.match(ipv6Policy("fec0::1").reason, /site-local/);
  assert.match(ipv6Policy("64:ff9b:1::1").reason, /local-use IPv4\/IPv6 translation/);
  assert.match(ipv6Policy("64:ff9b::1").reason, /NAT64/);
});

test("registry: the documentation prefix 3fff::/20 is blocked, and the addresses just outside it are not", () => {
  for (const ip of ["3fff::1", "3fff:0::1", "3fff:0fff:ffff::1"]) assert.equal(blocked(ip), true, ip);
  // 3fff:1000::/20 is outside the documentation prefix, so it is not blocked by it. It is an ordinary allocation.
  assert.equal(blocked("3fff:1000::1"), false, "only the /20 is documentation");
});

test("registry: the deprecated site-local prefix fec0::/10 is blocked", () => {
  for (const ip of ["fec0::1", "fec0:1234::1", "feff:ffff::1"]) assert.equal(blocked(ip), true, ip);
});

test("registry: the local-use translation prefix 64:ff9b:1::/48 is blocked", () => {
  assert.equal(blocked("64:ff9b:1::1"), true);
  assert.equal(blocked("64:ff9b:1:ffff::1"), true);
});

test("registry: NAT64 64:ff9b::/96 stays blocked, even for a public embedded IPv4 address (no weakening)", () => {
  // The registry says globally reachable. This fetcher does not follow a NAT64 destination, because the gateway chooses it.
  assert.equal(blocked("64:ff9b::808:808"), true, "8.8.8.8 embedded");
  assert.equal(blocked("64:ff9b::1"), true, "existing test case");
});

// --- Mapped and compatible forms -----------------------------------------------------------------------------------

test("mapped: IPv4-mapped addresses are classified by the IPv4 address they carry", () => {
  assert.equal(blocked("::ffff:10.0.0.5"), true, "private, dotted");
  assert.equal(blocked("::ffff:0a00:0005"), true, "private, hexadecimal");
  assert.equal(blocked("::ffff:127.0.0.1"), true, "loopback");
  assert.equal(blocked("::ffff:169.254.169.254"), true, "link-local metadata address");
  assert.equal(blocked("::ffff:8.8.8.8"), false, "public, dotted");
  assert.equal(blocked("::ffff:0808:0808"), false, "public, hexadecimal");
});

test("mapped: the expanded and upper-case spellings of a mapped address get the same answer", () => {
  assert.equal(blocked("0:0:0:0:0:ffff:0a00:0005"), true, "fully written");
  assert.equal(blocked("0000:0000:0000:0000:0000:FFFF:10.0.0.5"), true, "upper case with dotted suffix");
  assert.equal(blocked("0:0:0:0:0:ffff:0808:0808"), false);
});

test("compatible: ::/96 is blocked, which covers the unspecified and loopback addresses and IPv4-compatible forms", () => {
  for (const ip of ["::", "::1", "::8.8.8.8", "::0.0.0.1", "0:0:0:0:0:0:0:1"]) assert.equal(blocked(ip), true, ip);
});

// --- The spelling regression: the old code compared text prefixes -------------------------------------------------

test("spelling: every spelling of a documentation address is blocked, not only the canonical one", () => {
  // The old code compared text, so 2001:0db8::1 was allowed. The address is the same, so it is blocked here.
  for (const ip of ["2001:db8::1", "2001:0db8::1", "2001:DB8::1", "2001:db8:0:0::1", "2001:0db8:0000:0000:0000:0000:0000:0001"]) {
    assert.equal(blocked(ip), true, ip);
  }
});

test("spelling: a zone identifier does not change the answer", () => {
  assert.equal(blocked("fe80::1%eth0"), true);
  assert.equal(blocked("2606:4700:4700::1111%1"), false, "the public address is still public");
});

// --- Teredo, 6to4, and the IETF protocol assignments -------------------------------------------------------------

test("Teredo: 2001::/32 is blocked, because the endpoint is hidden behind a relay", () => {
  assert.equal(blocked("2001:0::1"), true);
  assert.equal(blocked("2001::4136:e378:8000:63bf:3fff:fdd2"), true);
});

test("6to4: the embedded IPv4 address decides", () => {
  assert.equal(blocked("2002:c000:201::1"), true, "192.0.2.1, documentation");
  assert.equal(blocked("2002:0a00:0001::1"), true, "10.0.0.1, private");
  assert.equal(blocked("2002:0808:0808::1"), false, "8.8.8.8, public");
});

test("IETF protocol assignments: 2001::/23 is blocked unless the registry marks the entry globally reachable", () => {
  assert.equal(blocked("2001:5::1"), true, "not listed");
  assert.equal(blocked("2001:2::1"), true, "benchmarking");
  for (const ip of ["2001:1::1", "2001:1::2", "2001:1::3", "2001:3::1", "2001:4:112::1", "2001:20::1", "2001:30::1"]) {
    assert.equal(blocked(ip), false, `${ip} is listed as globally reachable`);
  }
});

// --- Outside the global unicast space ------------------------------------------------------------------------------

test("outside 2000::/3: addresses in other allocations are blocked, because nothing there is allocated for global use", () => {
  for (const ip of ["4000::1", "8000::1", "a000::1", "c000::1", "e000::1", "f000::1", "fe80::1", "ff02::1", "5f00::1"]) {
    assert.equal(blocked(ip), true, ip);
  }
});

// --- Ordinary globally routable destinations ----------------------------------------------------------------------

test("ordinary: globally routable IPv6 destinations are allowed", () => {
  for (const ip of [
    "2606:4700:4700::1111", // a public resolver
    "2001:4860:4860::8888", // a public resolver
    "2a00:1450:4001:82a::200e", // a public web host
    "2620:4f:8000::1", // inside 2620::/23 and not blocked; the registry lists 2620:4f:8000::/48 as globally reachable
    "2400:cb00::1", // an ordinary 2400::/12 allocation
  ]) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be allowed`);
  }
});

test("ordinary: the answers carry a reason, so a refused address can be explained", () => {
  assert.match(ipv6Policy("fec0::1").reason, /site-local/);
  assert.match(ipv6Policy("2001:0::1").reason, /Teredo/);
  assert.match(ipv6Policy("2606:4700:4700::1111").reason, /globally routable/);
});

// --- Invalid input ---------------------------------------------------------------------------------------------------

test("invalid input is blocked, not allowed", () => {
  for (const ip of ["", "not-an-address", "2001:db8:::1", "12345::1", "2001:db8::1::2"]) {
    assert.equal(blocked(ip), true, `"${ip}" must be blocked`);
  }
});

// --- The URL check refuses these literals before any lookup -------------------------------------------------------

test("the URL check refuses blocked IPv6 literals, in any spelling, without a lookup", async () => {
  // A literal needs no name resolution. Count the calls to dns.lookup to show that none were made.
  const dns = require("node:dns").promises;
  const original = dns.lookup;
  let lookups = 0;
  dns.lookup = async (...args) => {
    lookups += 1;
    return original.apply(dns, args);
  };
  try {
    for (const url of ["http://[2001:0db8::1]/", "https://[fec0::1]/x", "http://[64:ff9b:1::1]/", "http://[2001:0::1]/"]) {
      await assert.rejects(assertPublicUrl(url), /Private network URLs are blocked/, url);
    }
    // A public literal is accepted by the same check.
    await assertPublicUrl("http://[2606:4700:4700::1111]/");
  } finally {
    dns.lookup = original;
  }
  assert.equal(lookups, 0, "no name was resolved for any literal");
});
