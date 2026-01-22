/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  ACKNOWLEDGE_SW_CONNECTION,
  CONNECT_SW_TO_PROJECT,
  MISSING_FILE_API,
  PlaygroundMessage,
  ServiceWorkerAPI,
  FileAPI,
} from '../shared/worker-api.js';
import { expose } from 'comlink';
import { Deferred } from '../shared/deferred.js';
import { serviceWorkerHash } from '../shared/version.js';
import * as parse5 from 'parse5';

declare var self: ServiceWorkerGlobalScope;

type SessionID = string;

const addLineAnchorsToHtml = (html: string): string => {
  try {
    const doc = parse5.parse(html, {
      sourceCodeLocationInfo: true,
    }) as unknown;

    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;

      const n = node as {
        tagName?: unknown;
        attrs?: unknown;
        childNodes?: unknown;
        content?: { childNodes?: unknown };
        templateContent?: { childNodes?: unknown };
        sourceCodeLocation?: { startLine?: unknown };
      };

      const loc = n.sourceCodeLocation;
      // Default parse5 tree nodes use `tagName` for elements.
      if (
        typeof n.tagName === 'string' &&
        loc &&
        typeof loc.startLine === 'number'
      ) {
        const attrs = ((n.attrs as Array<{ name: string; value: string }>) ??
          []) as Array<{ name: string; value: string }>;
        if (!Array.isArray(n.attrs)) {
          n.attrs = attrs;
        }
        if (!attrs.some((a) => a.name === 'data-playground-line')) {
          attrs.push({ name: 'data-playground-line', value: String(loc.startLine) });
        }
      }

      const children =
        (n.childNodes as unknown[]) ??
        (n.content?.childNodes as unknown[]) ??
        (n.templateContent?.childNodes as unknown[]);
      if (Array.isArray(children)) {
        for (const child of children) {
          visit(child);
        }
      }
    };

    visit(doc);
    return parse5.serialize(doc as unknown as never) as string;
  } catch {
    return html;
  }
};

/**
 * A collection of FileAPI objects registered by playground-project instances,
 * keyed by session ID.
 */
const fileAPIs = new Map<string, Deferred<FileAPI>>();

/**
 * API exposed to the UI thread via Comlink. The static methods on this class
 * become instance methods on SwControllerAPI.
 */
const workerAPI: ServiceWorkerAPI = {
  setFileAPI(fileAPI: FileAPI, sessionID: SessionID) {
    let deferred = fileAPIs.get(sessionID);
    if (deferred === undefined || deferred.settled) {
      deferred = new Deferred();
      fileAPIs.set(sessionID, deferred);
    }
    deferred.resolve(fileAPI);
  },
};

const findSessionProxyClient = async (
  sessionId: string,
): Promise<Client | undefined> => {
  for (const client of await self.clients.matchAll({
    includeUncontrolled: true,
  })) {
    const hash = new URL(client.url).hash;
    const hashParams = new URLSearchParams(hash.slice(1));
    if (hashParams.get('playground-session-id') === sessionId) {
      return client;
    }
  }
  return undefined;
};

const getFileApi = async (sessionId: string): Promise<FileAPI | undefined> => {
  let deferred = fileAPIs.get(sessionId);
  if (deferred !== undefined) {
    return deferred.promise;
  }
  // Find the proxy that manages this session, and tell it to connect us to the
  // session file API. Service Workers can stop and start at any time, clearing
  // global state. This kind of restart does _not_ count as a state change. The
  // only way we can tell this has happened is that a fetch occurs for a session
  // we don't know about.
  const client = await findSessionProxyClient(sessionId);
  if (client === undefined) {
    // This could happen if a user directly opened a playground URL after a
    // proxy iframe has been destroyed.
    return undefined;
  }
  deferred = new Deferred();
  fileAPIs.set(sessionId, deferred);
  const missingMessage: PlaygroundMessage = { type: MISSING_FILE_API };
  client.postMessage(missingMessage);
  return deferred.promise;
};

const getFile = async (_e: FetchEvent, path: string, sessionId: SessionID) => {
  const fileAPI = await getFileApi(sessionId);
  if (fileAPI === undefined) {
    return new Response('Playground project not available', {
      status: /* Service Unavailable */ 503,
    });
  }
  const fileOrError = await fileAPI.getFile(path);
  if ('status' in fileOrError) {
    const { body, status } = fileOrError;
    return new Response(body, { status });
  }
  const { content, contentType } = fileOrError;

  // Preserve preview scroll position across reloads.
  //
  // The preview iframe is typically cross-origin, so the parent page cannot
  // directly read/write the iframe scroll position. Instead, inject a tiny
  // script into HTML documents that stores scroll position in sessionStorage on
  // unload and restores it on the next load.
  let responseBody = content;
  const isHtml =
    contentType?.toLowerCase().includes('text/html') === true ||
    path.toLowerCase().endsWith('.html');
  if (isHtml) {
    responseBody = addLineAnchorsToHtml(responseBody);

    const storageKey = `playground-preview-scroll:${sessionId}:${path}`;
    const injected = `<script data-playground-scroll>
(() => {
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch {}

  const key = ${JSON.stringify(storageKey)};

  const postToParent = (message) => {
    try {
      // Parent may be cross-origin; postMessage is still allowed.
      parent?.postMessage(message, '*');
    } catch {}
  };

  const save = () => {
    const x = window.scrollX || 0;
    const y = window.scrollY || 0;
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({x, y}),
      );
    } catch {}
    postToParent({type: 'playground-preview-scroll', key, x, y});
  };

  // When the preview reloads, the parent component temporarily removes the
  // iframe from the DOM. In some browsers that can prevent unload/pagehide
  // handlers from firing. To make scroll persistence robust, also save
  // continuously on scroll (throttled).
  let saveScheduled = false;
  const onScroll = () => {
    if (saveScheduled) return;
    saveScheduled = true;
    requestAnimationFrame(() => {
      saveScheduled = false;
      save();
    });
  };

  const restore = () => {
    let raw = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const x = typeof data?.x === 'number' ? data.x : 0;
    const y = typeof data?.y === 'number' ? data.y : 0;

    const attempt = () => {
      try {
        window.scrollTo(x, y);
      } catch {}
    };

    // Restore multiple times to handle late layout changes.
    attempt();
    requestAnimationFrame(attempt);
    setTimeout(attempt, 50);
    setTimeout(attempt, 250);
  };

  // Parent-driven restore path (works even if storage is blocked).
  window.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data || data.type !== 'playground-preview-scroll-restore') return;
    if (data.key !== key) return;
    const x = typeof data.x === 'number' ? data.x : 0;
    const y = typeof data.y === 'number' ? data.y : 0;
    try {
      window.scrollTo(x, y);
    } catch {}
  });

  const scrollToElement = (el) => {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const attempt = () => {
      try {
        el.scrollIntoView({block: 'center', inline: 'nearest'});
      } catch {}
    };
    attempt();
    requestAnimationFrame(attempt);
    setTimeout(attempt, 50);
    setTimeout(attempt, 250);
  };

  // Parent-driven "scroll to edited HTML" path.
  window.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data || data.type !== 'playground-preview-scroll-target') return;

    const lineNumber =
      typeof data.lineNumber === 'number' ? data.lineNumber : undefined;
    if (lineNumber !== undefined) {
      const elements = document.querySelectorAll('[data-playground-line]');
      let bestBefore = null;
      let bestBeforeLine = -1;
      let bestAfter = null;
      let bestAfterLine = Infinity;
      for (const el of elements) {
        const raw = el.getAttribute('data-playground-line');
        const l = raw ? Number(raw) : NaN;
        if (!Number.isFinite(l)) continue;
        if (l <= lineNumber && l > bestBeforeLine) {
          bestBeforeLine = l;
          bestBefore = el;
        } else if (l > lineNumber && l < bestAfterLine) {
          bestAfterLine = l;
          bestAfter = el;
        }
      }
      const chosen = bestBefore ?? bestAfter;
      if (chosen) {
        scrollToElement(chosen);
        return;
      }
    }

    const htmlTarget = data.htmlTarget;
    if (!htmlTarget || typeof htmlTarget !== 'object') return;

    const id = typeof htmlTarget.id === 'string' ? htmlTarget.id : undefined;
    if (id) {
      scrollToElement(document.getElementById(id));
      return;
    }

    const className =
      typeof htmlTarget.className === 'string' ? htmlTarget.className : undefined;
    const tagName =
      typeof htmlTarget.tagName === 'string' ? htmlTarget.tagName : undefined;

    if (className && tagName) {
      const safeClass = className.replace(/[^a-zA-Z0-9_-]/g, '');
      scrollToElement(
        document.querySelector(tagName + '.' + safeClass),
      );
      return;
    }
    if (className) {
      const safeClass = className.replace(/[^a-zA-Z0-9_-]/g, '');
      scrollToElement(
        document.querySelector('.' + safeClass),
      );
    }
  });

  window.addEventListener('scroll', onScroll, {passive: true});
  window.addEventListener('beforeunload', save, {capture: true});
  window.addEventListener('pagehide', save, {capture: true});

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore, {once: true});
  } else {
    restore();
  }

  // Ask the parent for the latest scroll position it observed.
  postToParent({type: 'playground-preview-scroll-request', key});
})();
</script>`;

    const bodyCloseRe = /<\/body\s*>/i;
    if (bodyCloseRe.test(responseBody)) {
      responseBody = responseBody.replace(bodyCloseRe, (match) => {
        return `${injected}${match}`;
      });
    } else {
      responseBody = `${responseBody}\n${injected}\n`;
    }
  }
  const headers = new Headers();
  // By default, a browser is only able to allocate a separate process or thread
  // for the Playground preview iframe if it is hosted on a different _site_
  // (protocol + top-level domain) from the parent window. For example, lit.dev
  // and playground.lit.dev are the same site, but different origins. By setting
  // this Origin-Agent-Cluster header, we additionally allow process isolation
  // for different origins even if they are same-site.
  //
  // Note that _all_ responses from the sandbox origin must include this header
  // in order isolation to be possible, because the browser persists the setting
  // based on the first response it gets from that origin, so users will also
  // need to configure their HTTP server's response headers, since this line
  // only affects responses handled by the the service worker, and not e.g. the
  // service worker script itself.
  //
  // See:
  // https://web.dev/origin-agent-cluster/
  // https://html.spec.whatwg.org/multipage/origin.html#origin-keyed-agent-clusters
  headers.set('Origin-Agent-Cluster', '?1');
  if (contentType) {
    headers.set('Content-Type', contentType);
  }
  return new Response(responseBody, { headers });
};

const onFetch = (e: FetchEvent) => {
  const url = e.request.url;
  if (url.startsWith(self.registration.scope)) {
    const { filePath, sessionId } = parseScopedUrl(url);
    if (sessionId !== undefined) {
      e.respondWith(getFile(e, filePath!, sessionId));
    }
  }
};

const parseScopedUrl = (url: string) => {
  const scope = self.registration.scope;
  // URLs in scope will be of the form: {scope}{sessionId}/{filePath}. Scope is
  // always a full URL prefix, including a trailing slash. Strip query params or
  // else the filename won't match.
  const sessionAndPath = url.substring(scope.length).split('?')[0];
  const slashIndex = sessionAndPath.indexOf('/');
  let sessionId, filePath: string | undefined;
  if (slashIndex === -1) {
    console.warn(`Invalid sample file URL: ${url}`);
  } else {
    sessionId = sessionAndPath.slice(0, slashIndex);
    filePath = sessionAndPath.slice(slashIndex + 1);
  }
  return {
    sessionId,
    filePath,
  };
};

const onInstall = () => {
  // Force this service worker to become the active service worker, in case
  // it's an updated worker and waiting.
  /* eslint-disable @typescript-eslint/no-floating-promises */
  self.skipWaiting();
  /* eslint-enable @typescript-eslint/no-floating-promises */
};

const onActivate = (event: ExtendableEvent) => {
  // Make sure active clients use this service worker instance without being
  // reloaded.
  event.waitUntil(self.clients.claim());
};

const onMessage = (
  e: Omit<ExtendableMessageEvent, 'data'> & { data: PlaygroundMessage },
) => {
  // Receive a handshake message from a page and setup Comlink.
  if (e.data.type === CONNECT_SW_TO_PROJECT) {
    const ack: PlaygroundMessage = {
      type: ACKNOWLEDGE_SW_CONNECTION,
      version: serviceWorkerHash,
    };
    e.data.port.postMessage(ack);
    expose(workerAPI, e.data.port);
  }
};

self.addEventListener('fetch', onFetch);
self.addEventListener('activate', onActivate);
self.addEventListener('install', onInstall);
self.addEventListener('message', onMessage);
