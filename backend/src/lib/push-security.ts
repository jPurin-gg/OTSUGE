import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { Agent } from "node:https";
import { BlockList, isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";

export class PushEndpointError extends Error {
  constructor() {
    super("許可された公開 Push サービスの endpoint を指定してください。");
    this.name = "PushEndpointError";
  }
}

// Browser-owned services only. Keep paths/queries opaque (in particular WNS tokens).
// Sources and the special-purpose IP policy are documented in README.md.
function isPushHostname(hostname: string) {
  if (hostname === "fcm.googleapis.com" || hostname === "updates.push.services.mozilla.com") return true;
  return ["push.apple.com", "notify.windows.com"].some(
    (suffix) => hostname.endsWith(`.${suffix}`) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(hostname.slice(0, -suffix.length - 1)),
  );
}

export function validatePushEndpoint(value: string): URL {
  if (
    value.length > 2048 ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    value.includes("\\") ||
    value.includes("#")
  ) throw new PushEndpointError();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PushEndpointError();
  }
  // web-push uses legacy url.parse. Reject nonliteral authorities so both parsers
  // agree on hostname, credentials and port; do not rewrite the opaque endpoint.
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1].toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username || url.password || url.port ||
    !isPushHostname(url.hostname) ||
    (authority !== url.hostname && authority !== `${url.hostname}:443`) ||
    (url.pathname === "/" && !url.search)
  ) throw new PushEndpointError();
  return url;
}

const deniedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) deniedV4.addSubnet(address, prefix, "ipv4");
// Azure's WireServer is a platform virtual address despite its public IP form.
deniedV4.addAddress("168.63.129.16", "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20],
] as const) deniedV6.addSubnet(address, prefix, "ipv6");

export function isPublicPushAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !deniedV4.check(address, "ipv4");
  // Excludes mapped/compatible IPv4, NAT64, loopback, ULA, site/link-local,
  // multicast and unallocated space, as well as the special ranges above.
  return family === 6 && !address.includes("%") && globalV6.check(address, "ipv6") && !deniedV6.check(address, "ipv6");
}

export type PushAddressResolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: PushAddressResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

async function publicAddresses(hostname: string, resolve: PushAddressResolver, timeoutMs: number) {
  if (!isPushHostname(hostname)) throw new PushEndpointError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PushEndpointError()), timeoutMs);
      }),
    ]);
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicPushAddress(address) || isIP(address) !== family)) {
      throw new PushEndpointError();
    }
    return addresses;
  } catch {
    throw new PushEndpointError();
  } finally {
    clearTimeout(timer);
  }
}

export async function validatePushEndpointAddress(value: string, resolve = systemResolver, timeoutMs = 5000) {
  await publicAddresses(validatePushEndpoint(value).hostname, resolve, timeoutMs);
}

export function createPushAgent(resolve = systemResolver, timeoutMs = 5000) {
  const safeLookup: NonNullable<ConnectionOptions["lookup"]> = (hostname, options, callback) => {
    void publicAddresses(hostname, resolve, timeoutMs).then(
      (addresses) => {
        const requestedFamily = typeof options === "number" ? options : options.family;
        const family = requestedFamily === "IPv4" ? 4 : requestedFamily === "IPv6" ? 6 : requestedFamily;
        const available = family ? addresses.filter((address) => address.family === family) : addresses;
        if (!available.length) {
          callback(new PushEndpointError(), "", 0);
        } else if (typeof options === "object" && options.all) {
          callback(null, available);
        } else {
          callback(null, available[0].address, available[0].family);
        }
      },
      (error: Error) => callback(error, "", 0),
    );
  };
  // The socket consumes these checked addresses directly: no second DNS lookup.
  // Hostname/SNI and normal certificate validation remain intact. No proxy or
  // redirects are used; web-push 3.6.7 treats 3xx as errors.
  return new Agent({ lookup: safeLookup, keepAlive: false, maxSockets: 10 });
}
