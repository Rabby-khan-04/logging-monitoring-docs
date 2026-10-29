import { getEnvelopeEndpointWithUrlEncodedAuth } from '../api.js';
import { getClient } from '../currentScopes.js';
import { suppressTracing } from '../tracing/trace.js';
import { debug } from './debug-logger.js';
import { makeDsn } from './dsn.js';
import { resolveTunnelMatch, matchesTunnel, resolveAllowedDsns } from './tunnel.js';

function handleTunnelRequest(requestOrOptions, responseOrOptions, nodeOptions) {
  if (isNodeTunnelResponse(responseOrOptions)) {
    const nodeResponse = responseOrOptions;
    return forwardTunnelRequest(
      toFetchRequest(requestOrOptions),
      getAllowedDsns(nodeOptions)
    ).then((fetchResponse) => writeNodeResponse(nodeResponse, fetchResponse));
  }
  const isLegacyCall = "request" in requestOrOptions && !("method" in requestOrOptions);
  const request = isLegacyCall ? requestOrOptions.request : requestOrOptions;
  const options = isLegacyCall ? requestOrOptions : responseOrOptions;
  return forwardTunnelRequest(request, getAllowedDsns(options));
}
function handleTunnelRequestIfMatched(request, responseOrOptions, nodeOptions) {
  const response = isNodeTunnelResponse(responseOrOptions) ? responseOrOptions : void 0;
  const tunnel = resolveTunnelMatch(response ? nodeOptions : responseOrOptions);
  if (!tunnel.allowedDsns.length || !matchesTunnel(request, tunnel)) {
    return void 0;
  }
  if (!response) {
    return forwardTunnelRequest(request, tunnel.allowedDsns);
  }
  return forwardTunnelRequest(toFetchRequest(request), tunnel.allowedDsns).then(
    (fetchResponse) => writeNodeResponse(response, fetchResponse)
  );
}
function getAllowedDsns(options) {
  return options?.allowedDsns ? resolveAllowedDsns(options.allowedDsns, getClient()?.getDsn()) : resolveTunnelMatch().allowedDsns;
}
const FORWARDED_RESPONSE_HEADERS = ["content-type", "retry-after", "x-sentry-rate-limits"];
function isNodeTunnelResponse(value) {
  return typeof value?.writeHead === "function";
}
function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== void 0 && !name.startsWith(":")) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const iterator = request[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
    },
    // Node only reads the rest of a body nobody started reading, and unread bytes stall a keep-alive connection.
    async cancel() {
      while (!(await iterator.next()).done) {
      }
    }
  });
  return new Request("http://localhost/", {
    method: "POST",
    headers,
    body,
    duplex: "half"
  });
}
async function writeNodeResponse(response, fetchResponse) {
  const body = await fetchResponse.arrayBuffer().catch(() => void 0);
  if (!body) {
    response.writeHead(500);
    response.end(new Uint8Array());
    return;
  }
  const responseHeaders = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = fetchResponse.headers.get(name);
    if (value) {
      responseHeaders[name] = value;
    }
  }
  response.writeHead(fetchResponse.status, responseHeaders);
  response.end(new Uint8Array(body));
}
function withDecodedBodyHeaders(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
async function forwardTunnelRequest(request, allowedDsns) {
  return withDecodedBodyHeaders(await forwardEnvelope(request, allowedDsns));
}
async function forwardEnvelope(request, allowedDsns) {
  if (allowedDsns.length === 0) {
    return new Response("Tunnel not configured", { status: 500 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (!contentLength) {
    return new Response("Length required", { status: 411 });
  }
  const reader = request.body?.getReader();
  const head = reader && await readEnvelopeHeaderLine(reader).catch(() => void 0);
  if (!reader || !head) {
    return new Response("Invalid envelope", { status: 400 });
  }
  const sentryIngestUrl = resolveIngestUrl(head.line, allowedDsns);
  if (typeof sentryIngestUrl !== "string") {
    reader.cancel().catch(() => void 0);
    return sentryIngestUrl;
  }
  try {
    return await suppressTracing(
      () => fetch(sentryIngestUrl, {
        method: "POST",
        headers: forwardHeaders(request),
        body: prependToStream(head.read, reader),
        duplex: "half"
      })
    );
  } catch (error) {
    debug.error("Sentry tunnel: failed to forward envelope", error);
    return new Response("Failed to forward envelope to Sentry", { status: 500 });
  }
}
function resolveIngestUrl(headerLine, allowedDsns) {
  let envelopeHeader;
  try {
    envelopeHeader = JSON.parse(new TextDecoder().decode(headerLine));
  } catch {
    return new Response("Invalid envelope", { status: 400 });
  }
  if (!envelopeHeader) {
    return new Response("Invalid envelope: missing header", { status: 400 });
  }
  const dsn = envelopeHeader.dsn;
  if (!dsn || typeof dsn !== "string") {
    return new Response("Invalid envelope: missing DSN", { status: 400 });
  }
  const isAllowed = allowedDsns.some((allowed) => allowed === dsn);
  if (!isAllowed) {
    debug.warn(`Sentry tunnel: rejected request with unauthorized DSN (${dsn})`);
    return new Response("DSN not allowed", { status: 403 });
  }
  const dsnComponents = makeDsn(dsn);
  if (!dsnComponents) {
    debug.warn(`Could not extract DSN Components from: ${dsn}`);
    return new Response("Invalid DSN", { status: 403 });
  }
  return getEnvelopeEndpointWithUrlEncodedAuth(dsnComponents);
}
const MAX_ENVELOPE_HEADER_BYTES = 64 * 1024;
const FORWARDED_CLIENT_HEADERS = [
  "user-agent",
  "sec-ch-ua",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "origin",
  "referer"
];
async function readEnvelopeHeaderLine(reader) {
  let read = new Uint8Array(0);
  while (read.length <= MAX_ENVELOPE_HEADER_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      return read.length ? { line: read, read } : void 0;
    }
    const searchFrom = read.length;
    read = concatBytes(read, value);
    const newline = read.indexOf(10, searchFrom);
    if (newline !== -1) {
      return { line: read.subarray(0, newline), read };
    }
  }
  await reader.cancel();
  return void 0;
}
function concatBytes(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}
function prependToStream(prefix, reader) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}
function forwardHeaders(request) {
  const headers = { "Content-Type": "application/x-sentry-envelope" };
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-forwarded-for");
  if (clientIp) {
    headers["X-Sentry-Forwarded-For"] = clientIp;
  }
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

export { forwardTunnelRequest, handleTunnelRequest, handleTunnelRequestIfMatched };
//# sourceMappingURL=tunnelForward.js.map
