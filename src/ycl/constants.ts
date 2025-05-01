export const NAVIGATION_OPTIONS = {
  timeout: 60_000,               // give up after 60s
  waitUntil: 'domcontentloaded' as const, // don't wait for images/etc
};