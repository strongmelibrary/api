/* ================================================================================================
 *  catalog-client.ts
 *
 *  Generic HTTP/2 client for an online e‑book catalogue.
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  Contains **two** helpers:
 *    • catalogSearch  – endpoint that lists items (search/filters)
 *    • catalogDetail  – endpoint that returns metadata for one item
 *
 *  Every header—including HTTP/2 pseudo‑headers—is set explicitly, so nothing relies on `got`
 *  auto‑injection.  All brand/trademark identifiers have been replaced with neutral placeholders.
 *
 *  Dependencies
 *    • Node ≥ 18
 *    • got ^13       →  `pnpm add got@^13`
 * ==============================================================================================*/

import got, { Headers, HTTPError } from 'got';
import { URLSearchParams } from 'node:url';
import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
} from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import util from 'node:util';
import loggers from '../utils/logger';

const { ycl: logger } = loggers;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

const STATIC_HEADERS: Headers = {
  ':method': 'GET', // `:path`, `:authority`, `:scheme` filled per‑request
  accept: '*/*', // Changed to match the curl command
  'accept-encoding': 'gzip, deflate, br, zstd', // Added zstd to match curl
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36', // Updated Chrome version
  'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"', // Updated to match curl
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'priority': 'u=1, i', // Added priority header from curl
} as const;

const DEFAULT_QUERY_PARAMS = {
  format: '',
  available: 'any',
  language: '',
  sort: '',
  orderBy: 'relevence',
  owned: 'yes',
} as const;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  TYPES
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

export interface CatalogClientOptions {
  host: string;
  protocol?: 'https' | 'http';
  librarySlug: string;
  cookie: string;
  headers?: Headers;
}

export interface SearchOptions extends CatalogClientOptions {
  /** Optional plain‑text search term */
  searchText?: string;
  /** Optional additional / overriding query‑string filters */
  extraParams?: Record<string, string>;
}

export interface DetailOptions extends CatalogClientOptions {
  itemId: string;
}

export interface CatalogResponse<T = unknown> {
  rawBody: Buffer;
  json?: T;
  headers: Headers;
  status: number;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  INTERNAL HELPERS
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

/** Encode search term: `+` inside query‑string, `%20` inside Referer */
const encodeSearchText = (txt: string) => {
  const uri = encodeURIComponent(txt);
  return { forQuery: uri.replace(/%20/g, '+'), forReferer: uri };
};

const streamToBuffer = async (s: Readable) => {
  const acc: Buffer[] = [];
  for await (const c of s) acc.push(c as Buffer);
  return Buffer.concat(acc);
};

const decompress = async (buf: Buffer, enc?: string) => {
  const key = enc?.split(',')[0]?.trim();
  const map = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const fn = key && map[key as keyof typeof map];
  if (!fn) return buf;
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from(buf),
    fn(),
    async function* (src) {
      for await (const chunk of src) chunks.push(chunk as Buffer);
    },
  );
  return Buffer.concat(chunks);
};

/**
 * Sanitize cookie string to remove invalid characters
 * that might cause HTTP/2 header validation to fail
 */
const sanitizeCookie = (cookie: string | string[]): string => {
  if (Array.isArray(cookie)) {
    // If it's an array, join with semicolons (standard cookie delimiter)
    return cookie
      .filter(c => typeof c === 'string')
      .map(c => c.replace(/[^\x20-\x7E]/g, ''))
      .join('; ');
  }

  // Handle multi-line cookies by splitting on newlines
  if (cookie.includes('\n')) {
    const cookieLines = cookie.split('\n');

    // Look specifically for the __config_PROD cookie which is known to work
    const configCookieLine = cookieLines.find(line => line.startsWith('__config_PROD='));

    if (configCookieLine) {
      // Extract just the cookie name=value part from the line (ignore attributes)
      const parts = configCookieLine.split(';');
      return parts[0].trim(); // Take just the name=value part
    }

    // If no config cookie found, fall back to filtering
    const validCookieLines = cookieLines.filter(line => !line.startsWith('__session_PROD=;'));
    const cookiePairs = validCookieLines.map(line => {
      const parts = line.split(';');
      return parts[0].trim(); // Take just the name=value part
    });

    return cookiePairs.join('; ').replace(/[^\x20-\x7E]/g, '');
  }

  // If the cookie already starts with __config_PROD=, use it as is
  if (cookie.startsWith('__config_PROD=')) {
    // Extract just the cookie name=value part (ignore attributes)
    const parts = cookie.split(';');
    return parts[0].trim(); // Take just the name=value part
  }

  // Remove control characters, non-ASCII chars, and other problematic characters
  return cookie.replace(/[^\x20-\x7E]/g, '');
};

/**
 * Separate HTTP/2 pseudo-headers from regular headers
 * This helps avoid issues with header ordering and validation
 */
const buildHeaders = (
  overrides: Headers,
  path: string,
  referer: string,
  host: string,
  protocol: string,
  cookie: string,
): Headers => {
  // HTTP/2 pseudo-headers (must start with ':')
  const pseudoHeaders = {
    ':path': path,
    ':authority': host,
    ':scheme': protocol,
    ':method': STATIC_HEADERS[':method'],
  };

  // Regular headers (must not start with ':')
  const regularHeaders = {
    ...Object.fromEntries(
      Object.entries(STATIC_HEADERS).filter(([key]) => !key.startsWith(':'))
    ),
    referer,
    cookie: sanitizeCookie(cookie),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => !key.startsWith(':'))
    ),
  };

  // Pseudo-header overrides (if any)
  const pseudoOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key.startsWith(':'))
  );

  // Combine in the correct order (pseudo-headers must come first in HTTP/2)
  return {
    ...pseudoHeaders,
    ...pseudoOverrides,
    ...regularHeaders,
  };
};

const doRequest = async <T = unknown>(url: string, headers: Headers): Promise<CatalogResponse<T>> => {
  try {
    // Log headers for debugging (but redact cookie value for security)
    const debugHeaders = { ...headers };
    if (debugHeaders.cookie) {
      // Handle both string and string[] types for cookie
      if (typeof debugHeaders.cookie === 'string') {
        debugHeaders.cookie = debugHeaders.cookie.substring(0, 15) + '...';
      } else if (Array.isArray(debugHeaders.cookie)) {
        debugHeaders.cookie = debugHeaders.cookie.map(c =>
          typeof c === 'string' ? c.substring(0, 15) + '...' : c
        );
      }
    }
    logger.debug(`Request: ${url}`);

    // Try with HTTP/2 first
    try {
      const rsp = await got(url, {
        http2: true,
        headers,
        decompress: false,
        throwHttpErrors: false,
        timeout: {
          request: 30000 // 30 seconds timeout
        },
        retry: {
          limit: 2,
          methods: ['GET']
        }
      });

      logger.debug(`Response status (HTTP/2): ${rsp.statusCode}`);
      return await processResponse<T>(rsp);
    } catch (http2Error) {
      // If HTTP/2 fails, fall back to HTTP/1.1
      logger.warn(`HTTP/2 request failed, falling back to HTTP/1.1: ${http2Error}`);

      // For HTTP/1.1, we need to remove HTTP/2 pseudo-headers
      const http1Headers = { ...headers };
      Object.keys(http1Headers).forEach(key => {
        if (key.startsWith(':')) {
          delete http1Headers[key];
        }
      });

      // Add host header for HTTP/1.1
      if (headers[':authority']) {
        http1Headers.host = headers[':authority'];
      }

      const rsp = await got(url, {
        http2: false,
        headers: http1Headers,
        decompress: false,
        throwHttpErrors: false,
        timeout: {
          request: 30000 // 30 seconds timeout
        },
        retry: {
          limit: 2,
          methods: ['GET']
        }
      });

      logger.debug(`Response status (HTTP/1.1 fallback): ${rsp.statusCode}`);
      return await processResponse<T>(rsp);
    }
  } catch (err) {
    if (err instanceof HTTPError) throw err;

    // Enhanced error logging
    logger.error('Request failed:', {
      url,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    throw new Error(`catalog-client error: ${String(err)}`);
  }
};

// Helper function to process response
const processResponse = async <T = unknown>(rsp: any): Promise<CatalogResponse<T>> => {
  const raw = await decompress(
    await streamToBuffer(Readable.from(rsp.rawBody)),
    rsp.headers['content-encoding'],
  );

  let json: T | undefined;
  if ((rsp.headers['content-type'] ?? '').startsWith('application/json')) {
    try {
      json = JSON.parse(raw.toString('utf-8'));
    } catch (jsonError) {
      logger.error('Error parsing JSON response:', jsonError);
      logger.debug('Raw response preview:', raw.toString('utf-8').substring(0, 200) + '...');
    }
  }

  return { rawBody: raw, json, headers: rsp.headers, status: rsp.statusCode };
};

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  SEARCH
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

/**
 * Perform a search or browse request.
 *
 * `searchText` *and* `extraParams.query` are optional: you may call this with
 * category filters (e.g. `author`, `subject`, etc.) only, which mimics how the
 * site behaves when you browse without a free‑text query.
 */
export const catalogSearch = async <T = unknown>({
  host,
  protocol = 'https',
  librarySlug,
  searchText,
  extraParams,
  cookie,
  headers = {},
}: SearchOptions): Promise<CatalogResponse<T>> => {
  const enc = searchText?.trim() ? encodeSearchText(searchText) : null;

  // Create params object
  const paramsObj = {
    ...DEFAULT_QUERY_PARAMS,
    ...extraParams,
    ...(enc ? { query: enc.forQuery } : {})
  };

  // Add the _data parameter directly to the query string to avoid double-encoding
  const params = new URLSearchParams(paramsObj).toString();
  const dataParam = '_data=routes%2Flibrary.%24name.search';
  const fullParams = params ? `${params}&${dataParam}` : dataParam;

  const PATH = `/library/${librarySlug}/search?${fullParams}`;
  // Referer mirrors the visible URL the user would have in the address bar
  const REFERER =
    enc
      ? `${protocol}://${host}/library/${librarySlug}/search?query=${enc.forReferer}`
      : `${protocol}://${host}/library/${librarySlug}/search${params ? `?${params}` : ''}`;

  const URL_FULL = `${protocol}://${host}${PATH}`;
  const hdrs = buildHeaders(headers, PATH, REFERER, host, protocol, cookie);
  return doRequest(URL_FULL, hdrs);
};

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  DETAIL
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

export const catalogDetail = async <T = unknown>({
  host,
  protocol = 'https',
  librarySlug,
  itemId,
  cookie,
  headers = {},
}: DetailOptions): Promise<CatalogResponse<T>> => {
  const DATA_PARAM = '_data=routes%2Flibrary.%24name.detail.%24id';
  const PATH = `/library/${librarySlug}/detail/${itemId}?${DATA_PARAM}`;
  const REFERER = `${protocol}://${host}/library/${librarySlug}/detail/${itemId}`;
  const URL_FULL = `${protocol}://${host}${PATH}`;

  const hdrs = buildHeaders(headers, PATH, REFERER, host, protocol, cookie);
  return doRequest(URL_FULL, hdrs);
};
