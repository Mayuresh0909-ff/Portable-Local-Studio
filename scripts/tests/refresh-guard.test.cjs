// Tests for the discovery-refresh guard (Stage D).
//
// EXECUTED: discoveryRefreshBlockedReason() is called directly with each runtime flag. The
// route wiring checks at the end are source-text assertions. They supplement the behaviour tests
// and do not replace them. Full route behaviour with a live backend needs a Windows run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const selection = require(path.join(root, "scripts", "server", "gpu-selection.cjs"));
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("no active runtime allows a refresh", () => {
  assert.equal(selection.discoveryRefreshBlockedReason({}), null);
  assert.equal(selection.discoveryRefreshBlockedReason({
    imageRunning: false, textRunning: false, openvinoRunning: false, generating: false,
  }), null);
});

test("each active runtime blocks a refresh with the same message", () => {
  for (const flags of [
    { imageRunning: true },
    { textRunning: true },
    { openvinoRunning: true },
    { generating: true },
  ]) {
    assert.equal(
      selection.discoveryRefreshBlockedReason(flags),
      selection.DISCOVERY_REFRESH_BLOCKED_MESSAGE,
      JSON.stringify(flags),
    );
  }
});

test("the message tells the user what to do", () => {
  assert.match(selection.DISCOVERY_REFRESH_BLOCKED_MESSAGE, /^Stop the active image or text model/);
});

test("the OpenVINO NPU runtime is covered by the guard", () => {
  // Before this change the hardware refresh checked only the image and text runtimes.
  assert.notEqual(selection.discoveryRefreshBlockedReason({ openvinoRunning: true }), null);
});

test("both refresh routes go through the same guard before any probe runs", () => {
  const server = read("scripts/server/serve.cjs");
  // backend-options: the route checks the guard before it calls getBackendOptions.
  assert.match(
    server,
    /if \(req\.url\.split\("\?"\)\[0\] === "\/api\/backend-options"[\s\S]*?assertDiscoveryRefreshAllowed\(\);[\s\S]*?getBackendOptions\(\{ refresh \}\)/,
  );
  // hardware-specs: the refresh function runs the guard before it clears any cache.
  const body = server.slice(server.indexOf("function refreshHardwareDiscoveryState()"));
  const guardAt = body.indexOf("assertDiscoveryRefreshAllowed();");
  const clearAt = body.indexOf("cachedGpuDiscovery = null;");
  assert.ok(guardAt > 0 && clearAt > guardAt, "guard must run before the caches are cleared");
});

test("the automatic negative-cache re-check does not run while a runtime is active", () => {
  const server = read("scripts/server/serve.cjs");
  assert.match(server, /const runtimeActive = currentDiscoveryRefreshBlock\(\) !== null;/);
  assert.match(server, /const negativeExpired = !runtimeActive && cachedBackendOptionsNegative/);
});
