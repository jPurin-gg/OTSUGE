import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { Agent } from "node:https";
import { Socket } from "node:net";
import test from "node:test";
import tls, { type ConnectionOptions } from "node:tls";
import {
  createPushAgent,
  isPublicPushAddress,
  PushEndpointError,
  validatePushEndpoint,
  validatePushEndpointAddress,
} from "./push-security";

const endpoint = "https://fcm.googleapis.com/wp/opaque-token";
const publicAddresses: LookupAddress[] = [
  { address: "142.250.1.1", family: 4 },
  { address: "2607:f8b0:4005:80a::200a", family: 6 },
];

function socketLookup(agent: Agent, options: LookupOptions = {}, hostname = "fcm.googleapis.com") {
  return new Promise<{ address: string | LookupAddress[]; family?: number }>((resolve, reject) => {
    assert.ok(agent.options.lookup);
    agent.options.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test("supported provider URLs retain opaque paths, queries and standard port", () => {
  for (const value of [
    endpoint,
    "HTTPS://FCM.GOOGLEAPIS.COM:443/fcm/send/token%2Fpart?key=a%2Bb%3D",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/Q/token",
    "https://region.web.push.apple.com/Q/token",
    "https://wns2-par02p.notify.windows.com/?token=a%2Bb%3D",
  ]) {
    const parsed = validatePushEndpoint(value);
    assert.equal(parsed.protocol, "https:", value);
    assert.equal(parsed.username, "", value);
    assert.equal(parsed.password, "", value);
    assert.equal(parsed.port, "", value);
  }
  const value = "https://wns2-par02p.notify.windows.com/?token=a%2Bb%3D&x=%2F";
  assert.equal(validatePushEndpoint(value).href, value);
});

test("host boundary, URL parser and authority tricks cannot escape the allowlist", () => {
  for (const value of [
    "not a URL",
    "http://fcm.googleapis.com/wp/token",
    "ftp://fcm.googleapis.com/wp/token",
    "https://example.com/token",
    "https://localhost/token",
    "https://127.0.0.1/token",
    "https://2130706433/token",
    "https://0x7f000001/token",
    "https://[::1]/token",
    "https://fcm.googleapis.com.evil.example/token",
    "https://evilfcm.googleapis.com/token",
    "https://sub.fcm.googleapis.com/token",
    "https://push.apple.com/token",
    "https://evilpush.apple.com/token",
    "https://web.push.apple.com.evil.example/token",
    "https://notify.windows.com/token",
    "https://evilnotify.windows.com/token",
    "https://x.notify.windows.com.evil.example/token",
    "https://fcm.googleapis.com./wp/token",
    "https://fcm.googleapis.com:8443/wp/token",
    "https://fcm.googleapis.com:0443/wp/token",
    "https://fcm.googleapis.com:/wp/token",
    "https://user:secret@fcm.googleapis.com/wp/token",
    "https://@fcm.googleapis.com/wp/token",
    "https://evil.example@fcm.googleapis.com/wp/token",
    "https://fcm.googleapis.com@evil.example/wp/token",
    "https://fcm%2egoogleapis.com/wp/token",
    "https://fcm.googleapis.com%2f.evil.example/wp/token",
    "https://fcm。googleapis.com/wp/token",
    "https:////fcm.googleapis.com/wp/token",
    "https://fcm.googleapis.com\\@evil.example/wp/token",
    " https://fcm.googleapis.com/wp/token",
    "https://fcm.googleapis.com/wp/to\nken",
    "https://fcm.googleapis.com/wp/token\u007f",
    "https://fcm.googleapis.com/wp/token#fragment",
    "https://fcm.googleapis.com/wp/token#",
    "https://fcm.googleapis.com/",
    "https://fcm.googleapis.com",
    `https://fcm.googleapis.com/wp/${"a".repeat(2048)}`,
  ]) assert.throws(() => validatePushEndpoint(value), PushEndpointError, value);
});

test("IPv4 policy rejects internal, special-purpose and cloud platform addresses", () => {
  for (const address of [
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255",
    "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1",
    "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255", "168.63.129.16",
  ]) assert.equal(isPublicPushAddress(address), false, address);
  for (const address of ["142.250.1.1", "17.188.170.1", "172.15.255.255", "172.32.0.1", "100.128.0.1"]) {
    assert.equal(isPublicPushAddress(address), true, address);
  }
});

test("IPv6 policy rejects internal, transition, scoped and special-purpose addresses", () => {
  for (const address of [
    "::", "::1", "::ffff:127.0.0.1", "::ffff:142.250.1.1", "::142.250.1.1",
    "64:ff9b::8efa:101", "64:ff9b:1::1", "100::1", "fc00::1", "fd00::1",
    "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "2001::1", "2001:2::1",
    "2001:20::1", "2001:db8::1", "2002:8efa:101::1", "3ffe::1", "3fff::1",
    "4000::1", "2607:f8b0::1%eth0", "not-an-address", "127.1", "",
  ]) assert.equal(isPublicPushAddress(address), false, address);
  for (const address of ["2607:f8b0:4005:80a::200a", "2a00:1450:400e:80c::200a", "2001:4860:4860::8888"]) {
    assert.equal(isPublicPushAddress(address), true, address);
  }
});

test("registration checks all DNS answers and suppresses resolver details on failure", async () => {
  let calls = 0;
  await validatePushEndpointAddress(endpoint, async (hostname) => {
    calls += 1;
    assert.equal(hostname, "fcm.googleapis.com");
    return publicAddresses;
  });
  assert.equal(calls, 1);
  for (const addresses of [
    [],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "fd00::1", family: 6 }],
    [publicAddresses[0], { address: "169.254.169.254", family: 4 }],
    [publicAddresses[1], { address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: "142.250.1.1", family: 6 }],
    [{ address: "not-an-address", family: 4 }],
  ]) await assert.rejects(validatePushEndpointAddress(endpoint, async () => addresses), PushEndpointError);
  await assert.rejects(validatePushEndpointAddress(endpoint, async () => {
    throw new Error("private resolver diagnostic");
  }), (error: unknown) => error instanceof PushEndpointError && !error.message.includes("diagnostic"));
  await assert.rejects(validatePushEndpointAddress("https://example.com/token", async () => {
    assert.fail("unapproved hosts must be rejected before DNS");
  }), PushEndpointError);
});

test("registration and connection DNS checks have a finite timeout", async () => {
  const unresolved = () => new Promise<LookupAddress[]>(() => {});
  await assert.rejects(validatePushEndpointAddress(endpoint, unresolved, 5), PushEndpointError);
  const agent = createPushAgent(unresolved, 5);
  try {
    await assert.rejects(socketLookup(agent), PushEndpointError);
  } finally {
    agent.destroy();
  }
});

test("socket lookup returns the checked IPv4/IPv6 answers in Node's requested form", async () => {
  const agent = createPushAgent(async () => publicAddresses);
  try {
    assert.deepEqual(await socketLookup(agent), { address: publicAddresses[0].address, family: 4 });
    assert.deepEqual(await socketLookup(agent, { all: true }), { address: publicAddresses, family: undefined });
    for (const family of [6, "IPv6"] as const) {
      assert.deepEqual(await socketLookup(agent, { family }), { address: publicAddresses[1].address, family: 6 });
    }
    for (const family of [4, "IPv4"] as const) {
      assert.deepEqual(await socketLookup(agent, { family, all: true }), { address: [publicAddresses[0]], family: undefined });
    }
    await assert.rejects(socketLookup(agent, {}, "example.com"), PushEndpointError);
  } finally {
    agent.destroy();
  }
  const v4Only = createPushAgent(async () => [publicAddresses[0]]);
  try {
    await assert.rejects(socketLookup(v4Only, { family: 6 }), PushEndpointError);
  } finally {
    v4Only.destroy();
  }
});

test("a DNS change after registration or between sends cannot reach a private socket address", async () => {
  let resolutions = 0;
  const resolver = async () => {
    resolutions += 1;
    return resolutions <= 2 ? publicAddresses : [{ address: "127.0.0.1", family: 4 }];
  };
  await validatePushEndpointAddress(endpoint, resolver);
  const agent = createPushAgent(resolver);
  try {
    assert.deepEqual(await socketLookup(agent, { all: true }), { address: publicAddresses, family: undefined });
    await assert.rejects(socketLookup(agent, { all: true }), PushEndpointError);
    assert.equal(resolutions, 3, "each socket lookup uses one fresh, validated resolution");
  } finally {
    agent.destroy();
  }
});

test("a mixed answer fails even when Node requests only the public address family", async () => {
  for (const addresses of [
    [publicAddresses[0], { address: "fd00::1", family: 6 }],
    [publicAddresses[1], { address: "192.168.1.1", family: 4 }],
  ]) {
    const agent = createPushAgent(async () => addresses);
    try {
      await assert.rejects(socketLookup(agent, { family: addresses[0].family }), PushEndpointError);
    } finally {
      agent.destroy();
    }
  }
});

test("the HTTPS Agent hands its validated lookup to TLS while keeping hostname identity", async (context) => {
  const socket = new tls.TLSSocket(new Socket());
  let connectionOptions: ConnectionOptions | undefined;
  context.mock.method(tls, "connect", ((options: ConnectionOptions) => {
    connectionOptions = options;
    return socket;
  }) as typeof tls.connect);
  let resolutions = 0;
  const agent = createPushAgent(async () => {
    resolutions += 1;
    return [publicAddresses[0]];
  });
  try {
    agent.createConnection({
      ...agent.options,
      host: "fcm.googleapis.com",
      servername: "fcm.googleapis.com",
      port: 443,
    });
    assert.ok(connectionOptions);
    assert.equal(connectionOptions.host, "fcm.googleapis.com");
    assert.equal(connectionOptions.servername, "fcm.googleapis.com");
    assert.notEqual(connectionOptions.rejectUnauthorized, false);
    assert.equal(connectionOptions.lookup, agent.options.lookup);
    assert.deepEqual(await socketLookup(agent), { address: publicAddresses[0].address, family: 4 });
    assert.equal(resolutions, 1, "the socket callback receives the checked IP without resolving twice");
  } finally {
    socket.destroy();
    agent.destroy();
  }
});
