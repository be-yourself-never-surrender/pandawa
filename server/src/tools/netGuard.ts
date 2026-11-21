import dns from "node:dns/promises";
import net from "node:net";
import { getSetting } from "../db/database.js";

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
]);

function isCloudMetadataIp(ip: string): boolean {
  const low = ip.toLowerCase().replace(/^::ffff:/, "");
  // AWS/GCP/Azure/DigitalOcean/Alibaba cloud metadata endpoints (IPv4, IPv6 & IPv4-mapped hex)
  if (
    low === "169.254.169.254" ||
    low === "169.254.170.2" ||
    low === "100.100.100.200" ||
    low === "a9fe:a9fe" ||
    low === "a9fe:aa02" ||
    low === "6464:64c8"
  ) {
    return true;
  }
  if (low === "fd00:ec2::254") return true;
  return false;
}

function isPrivateLanIp(ip: string): boolean {
  const low = ip.toLowerCase().replace(/^::ffff:/, "");
  if (low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80:")) return true;
  if (net.isIPv4(low)) {
    const parts = low.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  return false;
}

/**
 * Smart SSRF guard that ALWAYS blocks cloud instance metadata endpoints
 * (169.254.169.254, metadata.google.internal, etc.) while keeping localhost
 * available by default for dev/testing unless user enables `ssrf_block_private=1`.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new Error("URL hostname is empty.");

  if (BLOCKED_METADATA_HOSTS.has(host) || isCloudMetadataIp(host)) {
    throw new Error(`Blocked SSRF target: cloud metadata endpoint (${host}) is not allowed.`);
  }

  const blockPrivate = getSetting("ssrf_block_private") === "1";

  if (net.isIP(host)) {
    if (blockPrivate && isPrivateLanIp(host)) {
      throw new Error(`Blocked SSRF target: private/loopback IP (${host}) is disabled by ssrf_block_private policy.`);
    }
    return parsed;
  }

  try {
    const resolved = await dns.lookup(host, { all: true });
    for (const r of resolved) {
      if (isCloudMetadataIp(r.address)) {
        throw new Error(`Blocked SSRF target: ${host} resolves to cloud metadata IP (${r.address}).`);
      }
      if (blockPrivate && isPrivateLanIp(r.address)) {
        throw new Error(`Blocked SSRF target: ${host} resolves to private IP (${r.address}).`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Blocked SSRF")) throw err;
    // Allow DNS errors to surface naturally at fetch time
  }

  return parsed;
}
