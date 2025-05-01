import { HTTPResponse, Page } from 'puppeteer'
import { NAVIGATION_OPTIONS } from './constants'
import loggers from '../utils/logger'

const { ycl: logger } = loggers;

/**
 * Navigates to `url`, intercepts the 302 redirect response, and returns its raw Set‑Cookie header.
 *
 * @param page - The Puppeteer page instance.
 * @param url  - The URL to navigate to (which issues the redirect).
 * @returns    - The full Set‑Cookie header string, or null if none was found.
 */
export const getRedirectSetCookie = async (
  page: Page,
  url: string,
): Promise<string | null> => {
  logger.info(`Getting redirect cookie from: ${url}`);

  try {
    // DO NOT use request interception as it's causing issues
    // Instead, just set up response monitoring

    // Set up a listener for responses to capture cookies
    const cookies: string[] = [];
    const responseListener = async (response: HTTPResponse) => {
      logger.debug(`Response: ${response.status()} ${response.url()}`);

      const headers = response.headers();
      if (headers['set-cookie']) {
        logger.debug('Found Set-Cookie header in response');
        cookies.push(headers['set-cookie']);
      }
    };

    page.on('response', responseListener);

    // Start listening for any redirect response, not just 302
    const redirectPromise = page.waitForResponse(
      (res: HTTPResponse) => {
        const isRedirect = res.status() >= 300 && res.status() < 400;
        const matchesUrl = res.url().startsWith(url);
        return isRedirect && matchesUrl;
      },
      { timeout: 30000 }
    ).catch(err => {
      logger.warn(`Redirect promise error (non-fatal): ${err.message}`);
      return null; // Return null so we can continue with fallbacks
    });

    // Kick off the navigation
    logger.info(`Navigating to ${url}`);
    await page.goto(url, NAVIGATION_OPTIONS).catch(err => {
      logger.warn(`Navigation error (non-fatal): ${err.message}`);
      // Continue execution even if navigation fails
    });

    // Try to get the redirect response
    let setCookie: string | null = null;
    const redirectResponse = await redirectPromise;

    if (redirectResponse) {
      logger.info(`Got redirect response: ${redirectResponse.status()} ${redirectResponse.url()}`);
      setCookie = redirectResponse.headers()['set-cookie'] || null;
    }

    // Clean up the response listener
    page.off('response', responseListener);

    // If we got a Set-Cookie from the redirect, use it
    if (setCookie) {
      logger.info('Successfully extracted Set-Cookie header from redirect');

      // Filter out empty session cookies that would delete the session
      let filteredCookie = setCookie;
      if (setCookie.includes('__session_PROD=;')) {
        // Split the cookie string by newlines and filter out the line with the empty session cookie
        const cookieLines = setCookie.split('\n');
        const validCookieLines = cookieLines.filter(line => !line.startsWith('__session_PROD=;'));

        if (validCookieLines.length > 0) {
          filteredCookie = validCookieLines.join('\n');
        }
      }

      return filteredCookie;
    }

    // If we collected cookies from other responses, use those
    if (cookies.length > 0) {
      logger.info('Using cookies collected from responses');
      return cookies.join('; ');
    }

    // As a last resort, try to get cookies from the page
    logger.info('Trying to get cookies from page');
    const pageCookies = await page.cookies();

    if (pageCookies && pageCookies.length > 0) {
      logger.info(`Found ${pageCookies.length} cookies from page`);
      // Convert page cookies to a string format
      const cookieStrings = pageCookies.map(cookie =>
        `${cookie.name}=${cookie.value}`
      );
      return cookieStrings.join('; ');
    }

    logger.warn('No cookies found');
    return null;
  } catch (error) {
    logger.error('Error getting redirect cookie:', error);

    // Try to get any cookies that might be available despite the error
    try {
      const cookies = await page.cookies();
      if (cookies && cookies.length > 0) {
        logger.info('Found cookies despite error, using these instead');
        const cookieStrings = cookies.map(cookie =>
          `${cookie.name}=${cookie.value}`
        );
        return cookieStrings.join('; ');
      }
    } catch (cookieError) {
      logger.error('Failed to get cookies after error:', cookieError);
    }

    // Re-throw the original error
    throw error;
  }
}