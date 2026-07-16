import { BlockList, isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data.ec2.internal",
]);

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
  ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["2002::", 16], ["2001::", 32],
] as const) blockedIpv6.addSubnet(network, prefix, "ipv6");

export class UrlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlSecurityError";
  }
}

function isBlockedIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (blockedIpv6.check(normalized, "ipv6")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedIpv4(mapped);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

export function isPrivateAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

export type PublicAddress = { address: string; family: 4 | 6 };

export function normalizePublicUrl(input: string) {
  const trimmed = input.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new UrlSecurityError("Enter a valid public website URL.");
  }

  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new UrlSecurityError("Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new UrlSecurityError("URLs containing credentials are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) throw new UrlSecurityError("Non-standard ports are not allowed.");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || blockedHostnames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new UrlSecurityError("Local and internal network addresses are not allowed.");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new UrlSecurityError("Private, reserved, and metadata network addresses are not allowed.");

  if (isIP(hostname) !== 6) url.hostname = hostname;
  url.hash = "";
  return url;
}

export async function resolvePublicDestination(
  url: URL,
  resolver: (hostname: string) => Promise<string[]> = async (hostname) => {
    const [v4, v6] = await Promise.all([
      resolve4(hostname).catch(() => []),
      resolve6(hostname).catch(() => []),
    ]);
    return [...v4, ...v6];
  },
) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new UrlSecurityError("Destination resolves to a blocked address.");
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }

  const addresses = await resolver(hostname);
  if (addresses.length === 0) throw new UrlSecurityError("The website hostname could not be resolved.");
  if (addresses.some(isPrivateAddress)) throw new UrlSecurityError("The website resolves to a private or reserved network address.");
  return addresses.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
}

export async function assertPublicDestination(
  url: URL,
  resolver?: (hostname: string) => Promise<string[]>,
) {
  await resolvePublicDestination(url, resolver);
}
