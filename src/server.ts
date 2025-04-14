import puppeteer, { ElementHandle, LaunchOptions, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
dotenv.config(); // Load environment variables from .env file

const COOKIE_PATH = __dirname;
const LEGACY_SITE_URL = process.env.LEGACY_SITE_URL || 'http://example.com'; // Replace with the actual URL of the legacy site
const LOGIN_URL = `${LEGACY_SITE_URL}/index.php`;

// ------------------------
// Helper functions
// ------------------------

// Safely evaluates a function in the page context and returns null on error.
const safePageEvaluate = async <T>(page: Page, fn: () => T): Promise<T | null> => {
  try {
    return await page.evaluate(fn);
  } catch (error) {
    return null;
  }
};

// Safely evaluates a function on an element selected by the given selector and returns null on error.
const safe$eval = async <T>(
  container: ElementHandle,
  selector: string,
  pageFunction: (el: Element) => T
): Promise<T | null> => {
  try {
    return await container.$eval(selector, pageFunction);
  } catch (error) {
    return null;
  }
};

// Safely queries an element within the container by the given selector and returns null if not found.
const safeQuerySelector = async (
  container: ElementHandle,
  selector: string
): Promise<ElementHandle<Element> | null> => {
  try {
    return await container.$(selector);
  } catch (error) {
    return null;
  }
};

// ------------------------
// Cookie management
// ------------------------

// function to hash username and password for cookie file name
const hashCredentials = (username: string, password?: string): string => {
  const hash = require('crypto').createHash('sha256');

  // Update the hash with the username and password
  hash.update(username);
  hash.update(password || ''); // Use empty string if password is not provided

  // Return the hexadecimal digest of the hash
  return hash.digest('hex');
};

// Load cookies from disk if they exist.
const loadCookies = async (page: Page, username: string, password?: string): Promise<void> => {
  const credentialHash = hashCredentials(username, password);
  const cookieFilePath = path.join(COOKIE_PATH, `cookies.${credentialHash}.json`);
  if (fs.existsSync(cookieFilePath)) {
    const cookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
    await page.setCookie(...cookies);
  }
};

// Save current page cookies to disk.
const saveCookies = async (page: Page, username: string, password?: string): Promise<void> => {
  const credentialHash = hashCredentials(username, password);
  const cookieFilePath = path.join(COOKIE_PATH, `cookies.${credentialHash}.json`);
  const cookies = await page.cookies();
  fs.writeFileSync(cookieFilePath, JSON.stringify(cookies, null, 2));
};

// ------------------------
// Login
// ------------------------

// Perform login only if necessary.
const performLoginIfNeeded = async (page: Page, USERNAME: string, PASSWORD?: string): Promise<void> => {
  // Navigate to the site so we can check if we’re already logged in.
  await page.goto(LEGACY_SITE_URL, { waitUntil: 'networkidle2' });

  // Check for an element that indicates the user is logged in (e.g., a logout button)
  const isLoggedIn = await safePageEvaluate(page, () => {
    // look for an h4 with content "Login to the Library" to confirm we are not logged in.
    const loginHeader = document.querySelector('h4')?.textContent?.trim();
    if (loginHeader === 'Login to the Library') {
      console.log('Not logged in, proceeding to login.');
      return false; // Not logged in
    }
    console.log('Already logged in, no need to login again.');
    return true;
  });

  if (!isLoggedIn) {
    // Navigate to login page.
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

    console.log(`Performing login for user: ${USERNAME} with password: ${(PASSWORD && PASSWORD?.length) ? 'provided' : 'not provided'}`);
    // Fill in login credentials.
    await page.type('#libraryname', USERNAME);
    await page.type('#password', PASSWORD || '');

    await page.click('.btn.btn-primary.w-100');

    // Wait for the navigation to complete.
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Save cookies for later reuse.
    await saveCookies(page, USERNAME, PASSWORD);
  }
};

// ------------------------
// BookInfo interface and extraction
// ------------------------

interface BookInfo {
  bookJacketUrl: string | null;
  googlePreviewUrl: string | null;
  title: string;
  expandedAuthor: string;
  author: string | null;
  extraFields: Record<string, string>;
  description: string;
  availability: string;
  copies: number;
}

// Extract book information from the given container.
// Returns null if any required element is missing.
const extractBookInfo = async (container: ElementHandle<Element>): Promise<BookInfo | null> => {
  let stringifyContainer = '';
  try {
    stringifyContainer = await container.evaluate(el => el.outerHTML);
  } catch (error) {
    stringifyContainer = '';
  }
  console.log('Processing container:', stringifyContainer);

  // Check for the book jacket image element.
  const jacketEl = await safeQuerySelector(container, '.col-sm-2 center a:first-of-type img');
  if (!jacketEl) {
    console.error('Book jacket image element not found.', stringifyContainer);
    return null;
  }

  // Extract the book jacket image URL.
  const bookJacketUrl = await safe$eval(
    container,
    '.col-sm-2 center a:first-of-type img',
    (img: Element) => img.getAttribute('src')
  );
  if (!bookJacketUrl) {
    console.error('Book jacket URL not found.', stringifyContainer);
    return null;
  }

  // Extract the Google preview URL.
  const googlePreviewUrl = await safe$eval(
    container,
    '.col-sm-2 center a:nth-of-type(2)',
    (a: Element) => a.getAttribute('href')
  );
  if (!googlePreviewUrl) {
    console.error('Google preview URL not found.', stringifyContainer);
    return null;
  }

  // Extract details from the center block.
  const details = await safe$eval(container, '.col-sm-8', (el: Element) => {
    // Use all <font> elements for structured extraction.
    const fontElements = Array.from(el.querySelectorAll('font'));
    let title = '';
    let expandedAuthor = '';
    let author: string | null = null;
    const extraFields: Record<string, string> = {};
    let description = '';

    if (fontElements.length > 0) {
      // First font element contains the title and expanded author.
      const titleText = fontElements[0].textContent?.trim() || '';
      const [titlePart, expandedAuthorPart] = titleText.split('/').map(s => s.trim());
      title = titlePart || '';
      expandedAuthor = expandedAuthorPart || '';
    }

    // Process subsequent font elements.
    for (let i = 1; i < fontElements.length; i++) {
      const fontEl = fontElements[i];
      if (fontEl.querySelector('b')) {
        // This font element contains dynamic fields.
        const boldElements = Array.from(fontEl.querySelectorAll('b'));
        boldElements.forEach(b => {
          const keyText = b.textContent || '';
          if (keyText.endsWith(':')) {
            const key = keyText.slice(0, -1).trim();
            let value = '';
            let current = b.nextSibling;
            while (current && !(current.nodeType === Node.ELEMENT_NODE && (current as Element).tagName.toLowerCase() === 'b')) {
              value += current.textContent;
              current = current.nextSibling;
            }
            extraFields[key] = value.trim();
          }
        });
      } else {
        // No <b> tag means this font element holds description text.
        const descText = fontEl.textContent?.trim() || '';
        if (descText) {
          if (description) description += "\n\n";
          description += descText;
        }
      }
    }

    // If no author was extracted from a dedicated field, check dynamic fields for an "Author" key.
    if (!author && extraFields['Author']) {
      author = extraFields['Author'];
      delete extraFields['Author'];
    }

    return {
      title,
      expandedAuthor,
      author,
      extraFields,
      description,
    };
  });
  if (!details || !details.title) {
    console.error('Title not found.', stringifyContainer);
    return null;
  }

  // Extract availability and number of copies from the right column.
  const availabilityData = await safe$eval(container, '.col-sm-2:last-child', (el: Element) => {
    const text = (el as HTMLElement).innerText;
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const availability = lines[0] || '';
    const copyLine = lines[1] || '';
    const match = copyLine.match(/(\d+)/);
    const copies = match ? parseInt(match[1], 10) : 0;
    return { availability, copies };
  });
  if (!availabilityData || !availabilityData.availability) {
    console.error('Availability not found.', stringifyContainer);
    return null;
  }

  return {
    bookJacketUrl,
    googlePreviewUrl,
    title: details.title,
    expandedAuthor: details.expandedAuthor,
    author: details.author || null,
    extraFields: details.extraFields,
    description: details.description,
    availability: availabilityData.availability,
    copies: availabilityData.copies,
  };
};

// ------------------------
// Pagination interfaces
// ------------------------

interface PageMeta {
  currentPage: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
}

interface ScrapeResponse {
  meta: PageMeta;
  results: BookInfo[];
}

// ------------------------
// Scraping function with optional pagination
// ------------------------

let additionalLaunchArgs: LaunchOptions = {};
const IS_RPI = process.env.ARCH_TYPE === 'rpi';
if (IS_RPI) {
  console.log('Running on Raspberry Pi. Ensure that Puppeteer is configured correctly.');
  // Additional launch arguments for Raspberry Pi.
  additionalLaunchArgs = {
    executablePath: '/usr/bin/chromium', // Use the system-installed Chromium.
    args: [
      '--no-sandbox', // Disable sandboxing for compatibility.
      // '--disable-gpu', // Disable GPU hardware acceleration.
      // '--disable-dev-shm-usage', // Overcome limited /dev/shm size on Raspberry Pi.
      // '--disable-setuid-sandbox', // Disable setuid sandboxing.
    ],
  };
  console.log('Puppeteer launch arguments for Raspberry Pi:', additionalLaunchArgs);
} else {
  console.log('Running on a non-Raspberry Pi environment. Using default Puppeteer settings.');
}

const scrapeLegacySite = async (search: string, USERNAME, PASSWORD = '', targetPage: number = 1): Promise<ScrapeResponse> => {
  console.log(`Starting scrape for search term: ${search} on page ${targetPage}`);
  const browser = await puppeteer.launch({
    headless: true,
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT,
    ...additionalLaunchArgs, // Include additional launch arguments for Raspberry Pi if applicable.
  });
  const page = await browser.newPage();

  // Load cookies if they exist.
  await loadCookies(page, USERNAME, PASSWORD);

  // Ensure we are logged in.
  await performLoginIfNeeded(page, USERNAME, PASSWORD);

  // Navigate to the home page after login.
  await page.goto(`${LEGACY_SITE_URL}/home.php`, { waitUntil: 'networkidle2' });

  // Perform search.
  await page.waitForSelector('input[id="search\\ term"]');
  await page.type('input[id="search\\ term"]', search);
  await page.click('button[id="search"]');
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
  } catch(e) {
    // If navigation fails, we might be on the same page without a full reload.
    console.warn('Navigation after search failed.');
    console.log('Current URL:', page.url());
    // console out the current page content for debugging.
    const pageContent = await page.content();
    console.log('Current page content:', pageContent.slice(0, 500)); // Print first 500 characters for brevity.
    throw new Error('Failed to navigate after search. This might indicate an issue with the search or the page structure.');
  }

  // Start at page 1.
  let currentPage = 1;
  let meta: PageMeta = { currentPage: 1, pageSize: 0, totalResults: 0, totalPages: 0 };

  // Function to update meta info from the paginator.
  const updateMeta = async () => {
    const paginatorEl = await page.$('td[align="right"][valign="top"]');
    if (paginatorEl) {
      const paginatorText = await page.evaluate(el => el.textContent, paginatorEl);
      // Expect text like "  1-10 of 100" or "  11-20 of 100"
      const match = paginatorText?.match(/(\d+)-(\d+)\s+of\s+(\d+)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        const totalResults = parseInt(match[3], 10);
        const pageSize = end - start + 1;
        const totalPages = pageSize > 0 ? Math.ceil(totalResults / pageSize) : 1;
        meta = { currentPage, pageSize, totalResults, totalPages };
      }
    }
  };

  // Update meta on the first page.
  await updateMeta();

  // If a page beyond the first is requested, paginate until reaching it (or until no next link exists).
  while (currentPage < targetPage) {
    const nextLink = await page.$('td[align="right"][valign="top"] a[href="catalog_next.php"]');
    if (nextLink) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        nextLink.click()
      ]);
      currentPage++;
      await updateMeta();
    } else {
      console.warn(`No next page available. Stopping at page ${currentPage}.`);
      break;
    }
  }

  // Scrape book containers on the current (target) page.
  await page.waitForSelector('.card > .card-body > .row');
  const containers = await page.$$('.card > .card-body > .row');
  console.log(`Found ${containers.length} book containers on page ${currentPage}.`);
  const booksResults = await Promise.all(containers.map(container => extractBookInfo(container)));
  const validBooks = booksResults.filter(book => book !== null) as BookInfo[];

  await browser.close();

  return { meta, results: validBooks };
};

// ------------------------
// Express API endpoint
// ------------------------

const app = express();
const PORT = process.env.PORT || 7700;

app.get('/api/scrape', async (req, res) => {
  const searchQuery = req.query.search;
  // Parse page parameter; default to 1 if not provided or invalid.
  const pageParam = req.query.page;
  const username = req.query.username || '';
  const password = req.query.password || '';
  const targetPage = pageParam && typeof pageParam === 'string' && !isNaN(parseInt(pageParam, 10))
    ? parseInt(pageParam, 10)
    : 1;

  if (!searchQuery || typeof searchQuery !== 'string') {
    return res.status(400).json({ error: 'Search query is required' });
  }
  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'Username is required' });
  }
  try {
    const result = await scrapeLegacySite(searchQuery, username, password, targetPage);
    console.log(`Scraping for ${username} with term "${searchQuery}" on page ${targetPage} completed. Found ${result.results.length} books.`);
    res.json(result);
  } catch (error) {
    console.error('Error scraping legacy site:', error);
    res.status(500).json({ error: 'Scraping failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
