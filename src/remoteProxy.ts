import { RemoteProxySettings } from "./config";

export interface ResolvedRemoteProxy {
  proxyUrl: string;
  localHost: string;
  localPort: number;
  remoteForwardPort: number;
}

const SUPPORTED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]);

export function resolveRemoteProxy(settings: RemoteProxySettings): ResolvedRemoteProxy | undefined {
  if (!settings.enabled) {
    return undefined;
  }

  const proxyUrl = settings.proxyUrl.trim();
  if (!proxyUrl) {
    return undefined;
  }
  const parsed = parseProxyUrl(proxyUrl);
  return {
    proxyUrl: parsed.normalizedUrl,
    localHost: normalizeForwardHost(settings.localForwardHost || "127.0.0.1"),
    localPort: parsed.port,
    remoteForwardPort:
      Number.isInteger(settings.remoteForwardPort) && settings.remoteForwardPort > 0
        ? settings.remoteForwardPort
        : parsed.port,
  };
}

export function remoteProxySettingsPayload(proxy: ResolvedRemoteProxy): Record<string, unknown> {
  return {
    "http.proxy": remoteProxyUrl(proxy),
    "http.proxyStrictSSL": false,
    "http.proxySupport": "on",
  };
}

export function remoteProxyUrl(proxy: ResolvedRemoteProxy): string {
  const protocol = new URL(proxy.proxyUrl).protocol;
  return `${protocol}//127.0.0.1:${proxy.remoteForwardPort}`;
}

function parseProxyUrl(value: string): { normalizedUrl: string; host: string; port: number } {
  const normalizedInput = normalizeProxyUrl(value);
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new Error(`Invalid proxy URL: ${value}`);
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Unsupported proxy protocol: ${url.protocol.replace(/:$/, "")}. Use http, https, socks, socks4, or socks5.`,
    );
  }
  if (!url.hostname || /[\r\n]/.test(url.hostname)) {
    throw new Error("Proxy host is invalid.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Proxy URL must include a valid port.");
  }

  return {
    normalizedUrl: url.toString(),
    host: normalizeLoopbackHost(url.hostname),
    port,
  };
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Proxy URL cannot be empty.");
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function normalizeForwardHost(host: string): string {
  if (!host.trim() || /[\r\n]/.test(host)) {
    throw new Error("RemoteForward local host is invalid.");
  }
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return "127.0.0.1";
  }
  return host.trim();
}

function normalizeLoopbackHost(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return "127.0.0.1";
  }
  return host;
}
