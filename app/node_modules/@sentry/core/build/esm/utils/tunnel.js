import { getClient } from '../currentScopes.js';
import { URL_PATH } from '@sentry/conventions/attributes';
import { escapeStringForRegex } from '../vendor/escapeStringForRegex.js';
import { makeDsn, dsnToString } from './dsn.js';
import { parseUrl } from './url.js';

const servedTunnels = /* @__PURE__ */ new WeakMap();
const SERVE_TUNNEL_INTEGRATION_NAME = "ServeTunnel";
function setServedTunnel(client, tunnelOptions, forward) {
  const allowedDsns = resolveAllowedDsns(tunnelOptions.allowedDsns, client.getDsn());
  const servedTunnel = {
    paths: resolveTunnelPaths(tunnelOptions, allowedDsns),
    basePath: tunnelOptions.basePath,
    allowedDsns,
    forward
  };
  servedTunnels.set(client, servedTunnel);
  return servedTunnel;
}
function getServeTunnelForwarder(client) {
  return client.getIntegrationByName?.(SERVE_TUNNEL_INTEGRATION_NAME)?.forward;
}
function getServedTunnel() {
  const client = getClient();
  if (!client) {
    return void 0;
  }
  const servedTunnel = servedTunnels.get(client);
  if (servedTunnel) {
    return servedTunnel;
  }
  const tunnelOptions = client.getOptions()._managedTunnel;
  const forward = getServeTunnelForwarder(client);
  return tunnelOptions && forward ? setServedTunnel(client, tunnelOptions, forward) : void 0;
}
function applyTunnelDefaults(tunnel, defaults) {
  if (!tunnel || typeof tunnel === "string" || tunnel !== true && tunnel.path) {
    return tunnel;
  }
  const { basePath, ...rest } = defaults ?? {};
  const normalizedBasePath = normalizeTunnelBasePath(basePath);
  const resolvedDefaults = normalizedBasePath ? { ...rest, basePath: normalizedBasePath } : rest;
  if (!Object.keys(resolvedDefaults).length) {
    return tunnel;
  }
  return { ...resolvedDefaults, ...tunnel === true ? {} : tunnel };
}
function getTunnelPath(dsn) {
  const components = dsn ? makeDsn(dsn) : getClient()?.getDsn();
  return components ? `/${fnv1a32(dsnToString(components)).toString(36)}` : void 0;
}
function getTunnelPaths() {
  return getServedTunnel()?.paths ?? [];
}
function resolveTunnelPaths(tunnelOptions, allowedDsns) {
  const fixedPath = tunnelOptions.path?.replace(/\/$/, "");
  if (fixedPath) {
    return [fixedPath];
  }
  const paths = allowedDsns.map((dsn) => getTunnelPath(dsn));
  return [...new Set(paths.filter((path) => !!path))];
}
function getTunnelIgnoreSpanFilters(tunnelOptions, paths) {
  if (!paths.length) {
    return [];
  }
  const basePath = escapeStringForRegex(normalizeTunnelBasePath(tunnelOptions.basePath));
  const pathPattern = `${basePath}(?:${paths.map(escapeStringForRegex).join("|")})/?`;
  return [
    // oxlint-disable-next-line sdk/no-regexp-constructor -- built from escaped config values, not end user input
    { attributes: { [URL_PATH]: new RegExp(`^${pathPattern}$`) } },
    // oxlint-disable-next-line sdk/no-regexp-constructor -- built from escaped config values, not end user input
    { attributes: { "http.url": new RegExp(`^[a-z][a-z\\d+.-]*://[^/]+${pathPattern}(?:[?#].*)?$`) } }
  ];
}
function normalizeTunnelBasePath(basePath) {
  const path = (basePath?.startsWith("./") ? basePath.slice(1) : basePath ?? "").replace(/\/$/, "");
  return !path || path.startsWith("/") ? path : `/${path}`;
}
function resolveTunnelMatch(options) {
  const servedTunnel = !options && getServedTunnel();
  if (servedTunnel) {
    return servedTunnel;
  }
  const allowedDsns = resolveAllowedDsns(options?.allowedDsns, getClient()?.getDsn());
  return { paths: resolveTunnelPaths(options ?? {}, allowedDsns), basePath: options?.basePath, allowedDsns };
}
function matchesTunnel(request, tunnel) {
  if (request.method !== "POST" || !request.url) {
    return false;
  }
  const path = stripBasePath(parseUrl(request.url).path || "/", tunnel.basePath);
  return path !== void 0 && tunnel.paths.includes(path.replace(/\/$/, ""));
}
function isTunnelRequest(request, options) {
  return matchesTunnel(request, resolveTunnelMatch(options));
}
function isServedTunnelRequest(request) {
  const servedTunnel = getServedTunnel();
  return !!servedTunnel && matchesTunnel(request, servedTunnel);
}
function handleServedTunnelRequest(request) {
  const servedTunnel = getServedTunnel();
  if (!servedTunnel?.allowedDsns.length || !matchesTunnel(request, servedTunnel)) {
    return void 0;
  }
  return servedTunnel.forward(request, servedTunnel.allowedDsns);
}
function resolveAllowedDsns(allowedDsns, ownDsn) {
  const dsns = /* @__PURE__ */ new Set();
  for (const components of [...(allowedDsns ?? []).map((dsn) => makeDsn(dsn)), ownDsn]) {
    if (components) {
      dsns.add(dsnToString(components));
    }
  }
  return [...dsns];
}
function stripBasePath(pathname, basePath) {
  const base = normalizeTunnelBasePath(basePath);
  if (!base) {
    return pathname;
  }
  return pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : void 0;
}
function fnv1a32(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export { SERVE_TUNNEL_INTEGRATION_NAME, applyTunnelDefaults, getServeTunnelForwarder, getTunnelIgnoreSpanFilters, getTunnelPath, getTunnelPaths, handleServedTunnelRequest, isServedTunnelRequest, isTunnelRequest, matchesTunnel, normalizeTunnelBasePath, resolveAllowedDsns, resolveTunnelMatch, resolveTunnelPaths, setServedTunnel };
//# sourceMappingURL=tunnel.js.map
