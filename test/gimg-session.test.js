import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGimgSession, isGimgUrl, GIMG_ORIGIN } from "../public/gimg-session.js";

const reply = (mode, authenticated = false, expiresAt = null) => ({ ok: true, mode, authenticated, expiresAt });
function fixture(responses, options = {}) {
  let clock = 1000000;
  let challenges = 0;
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const session = createGimgSession({
    now: () => clock,
    setTimer(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimer(id) { timers.delete(id); },
    async fetch(url, init) {
      requests.push({ url, ...init });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value(init);
      assert.ok(value, "unexpected extra session request");
      return { ok: value.status ? value.status < 400 : true, status: value.status || 200, json: async () => value };
    },
    async challenge() { challenges += 1; return "test-token"; },
    ...options
  });
  return { session, requests, timers, challenges: () => challenges, advance: (ms) => { clock += ms; } };
}

test("only the exact HTTPS gimg origin is eligible", () => {
  assert.equal(isGimgUrl(`${GIMG_ORIGIN}/img/a`), true);
  for (const url of ["https://gimg.mtcacg.top.evil.test/a", "http://gimg.mtcacg.top/a", "/image.jpg", "data:image/png,a"]) assert.equal(isGimgUrl(url), false);
});

test("concurrent callers share one GET, challenge, POST and cookie confirmation", async () => {
  const f = fixture([reply("enforce"), reply("enforce", true, 2000), reply("enforce", true, 2000)]);
  await Promise.all(Array.from({ length: 30 }, () => f.session.ensure()));
  assert.equal(f.requests.length, 3);
  assert.equal(f.challenges(), 1);
  assert.equal(f.session.ready(), true);
  assert.deepEqual(f.requests.map((item) => item.method), ["GET", "POST", "GET"]);
  assert.ok(f.requests.every((item) => item.credentials === "include" && item.cache === "no-store" && item.url === `${GIMG_ORIGIN}/session`));
  assert.equal(f.requests[1].body, JSON.stringify({ token: "test-token" }));
  await f.session.ensure();
  assert.equal(f.requests.length, 3);
});

test("404 old backend is remembered for the page and never challenged", async () => {
  const f = fixture([{ status: 404 }]);
  await f.session.ensure();
  f.advance(900000);
  await f.session.ensure();
  assert.equal(await f.session.recoverImage(), false);
  assert.equal(f.session.ready(), true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.challenges(), 0);
});

test("observe and unavailable initial endpoint preserve browsing", async () => {
  for (const first of [reply("observe"), reply("off"), new Error("network"), { status: 429 }]) {
    const f = fixture([first]);
    await f.session.ensure();
    await f.session.ensure();
    assert.equal(f.session.ready(), true);
    assert.equal(f.challenges(), 0);
    assert.equal(f.requests.length, 1);
  }
});

test("observe explicit test challenges once and confirms cookie", async () => {
  const f = fixture([reply("observe"), reply("observe", true, 2000), reply("observe", true, 2000)]);
  await f.session.ensure({ verify: true });
  assert.equal(f.challenges(), 1);
  assert.equal(f.requests.length, 3);
});

test("observe explicit failure still preserves browsing", async () => {
  let failures = 0;
  const f = fixture([reply("observe"), new Error("POST failed")], { onFailure: () => { failures += 1; } });
  await f.session.ensure({ verify: true });
  assert.equal(f.session.ready(), true);
  assert.equal(failures, 1);
});

test("renewal is scheduled before expiry and remains single-flight", async () => {
  const f = fixture([reply("enforce", true, 1100), reply("enforce", true, 1100), reply("enforce", true, 2000), reply("enforce", true, 2000)]);
  await f.session.ensure();
  assert.equal(f.timers.size, 1);
  const renewal = [...f.timers.values()][0];
  assert.equal(renewal.delay, 80000);
  f.advance(80000);
  await Promise.all([f.session.ensure({ renew: true }), f.session.ensure({ renew: true })]);
  assert.equal(f.challenges(), 1);
  assert.equal(f.requests.length, 4);
  f.session.dispose();
  assert.equal(f.timers.size, 0);
});

test("blocked cookie after POST latches enforce failure until explicit retry", async () => {
  const f = fixture([reply("enforce"), reply("enforce", true, 2000), reply("enforce"), reply("enforce", true, 2000)]);
  await assert.rejects(f.session.ensure(), /cookie/);
  assert.equal(f.session.ready(), false);
  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(f.session.ensure());
    assert.equal(await f.session.recoverImage(), false);
  }
  assert.equal(f.challenges(), 1);
  assert.equal(f.requests.length, 3);
  await f.session.retry();
  assert.equal(f.session.ready(), true);
});

test("valid session image errors (including 429) do not challenge or retry images", async () => {
  const f = fixture(Array.from({ length: 3 }, () => reply("enforce", true, 2000)));
  await f.session.ensure();
  assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => f.session.recoverImage())), Array(100).fill(false));
  assert.equal(f.requests.length, 2);
  f.advance(61000);
  assert.equal(await f.session.recoverImage(), false);
  f.advance(61000);
  assert.equal(await f.session.recoverImage(), false);
  assert.equal(f.requests.length, 3);
  assert.equal(f.challenges(), 0);
});

test("expired cookie errors recover once for a concurrent image batch", async () => {
  const f = fixture([reply("enforce", true, 2000), reply("enforce"), reply("enforce", true, 2000), reply("enforce", true, 2000)]);
  await f.session.ensure();
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.session.recoverImage())), Array(20).fill(true));
  assert.equal(f.challenges(), 1);
  assert.equal(f.requests.length, 4);
  assert.equal(await f.session.recoverImage(), false);
});

test("challenge and renewal failures have no automatic retry loop", async () => {
  let count = 0;
  const f = fixture([reply("enforce")], { challenge: async () => { count += 1; throw new Error("challenge failed"); } });
  await assert.rejects(f.session.ensure(), /challenge failed/);
  await assert.rejects(f.session.ensure());
  assert.equal(await f.session.recoverImage(), false);
  assert.equal(count, 1);
  assert.equal(f.timers.size, 0);
});

test("known enforce endpoint failure does not fail open after expiry", async () => {
  const f = fixture([reply("enforce", true, 1001), new Error("network")]);
  await f.session.ensure();
  f.advance(2000);
  await assert.rejects(f.session.ensure(), /network/);
  assert.equal(f.session.ready(), false);
  assert.equal(f.challenges(), 0);
});

test("app keeps public JSON fallback credential-free and explicit observe retries enabled", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /return fetchJsonWithTimeout\(fallbackUrl, FALLBACK_JSON_TIMEOUT\);/);
  assert.match(source, /gimgSession\.retry\(\{ verify: verifyGimgSession \}\)/);
  assert.match(source, /const sourceAttribute = isGimgUrl\(src\) && !gimgSession\.ready\(\) \? "data-gimg-src" : "src"/);
  assert.match(source, /if \(!gimgSession\.ready\(\)\) return;/);
});

test("session fetch abort timeout is bounded", async () => {
  const f = fixture([(init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })]);
  const pending = f.session.ensure();
  assert.equal([...f.timers.values()][0].delay, 8000);
  [...f.timers.values()][0].fn();
  await pending;
  assert.equal(f.session.ready(), true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
});
