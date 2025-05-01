import puppeteer, { ElementHandle, LaunchOptions, Page } from 'puppeteer';
import express from 'express';
import cors from 'cors'; // Import the cors middleware
import dotenv from 'dotenv';
import loggers from './utils/logger';

dotenv.config(); // Load environment variables from .env file

const { server: logger } = loggers;

import { scrapeLegacySite } from './lw/client';
import { performCombinedSearch } from './services/searchService';
import {
  SearchParams,
  MediaTypeFilter,
  SortOption,
  ApiVersion
} from './models/unifiedResult';


// ------------------------
// Express API endpoint
// ------------------------

const app = express();
const PORT = process.env.PORT || 7700;

// Enable CORS for all origins
app.use(cors());

// Configuration for services
const getLegacyConfig = () => ({
  legacySiteUrl: process.env.LEGACY_SITE_URL || 'http://example.com'
});

const getYclConfig = ({ librarySlug }: { librarySlug: string }) => process.env.YCL_HOST ? {
  host: process.env.YCL_HOST,
  protocol: (process.env.YCL_PROTOCOL || 'https') as 'https' | 'http',
  librarySlug: process.env.YCL_LIBRARY_SLUG || '',
  authUrl: process.env.YCL_AUTH_URL ? `${process.env.YCL_AUTH_URL}/${librarySlug}/featured` : ''
} : null;

// Legacy endpoint for backward compatibility
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

  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT,
    acceptInsecureCerts: true,
    protocolTimeout: 120000,
  });
  const page = await browser.newPage();

  try {
    const legacyResult = await scrapeLegacySite(searchQuery, username, password, targetPage, page);
    logger.info(`Scraping for ${username} with term "${searchQuery}" on page ${targetPage} completed. Found ${legacyResult.results.length} books.`);
    res.json(legacyResult);
  } catch (error) {
    logger.error('Error scraping legacy site:', error);
    res.status(500).json({ error: 'Scraping failed' });
  } finally {
    await browser.close();
  }
});

// New combined search endpoint
app.get('/api/search', async (req, res) => {
  try {
    // Log incoming request for debugging
    logger.info(`Search request received: ${req.url}`);
    logger.debug('Request headers:', req.headers);

    // Extract and validate parameters
    const searchQuery = req.query.search;
    const username = req.query.username || '';
    const password = req.query.password || '';
    const librarySlug = req.query.librarySlug as string;

    // Parse numeric parameters
    const pageParam = req.query.page;
    const pageSizeParam = req.query.pageSize;
    const page = pageParam && typeof pageParam === 'string' && !isNaN(parseInt(pageParam, 10))
      ? parseInt(pageParam, 10)
      : 1;
    const pageSize = pageSizeParam && typeof pageSizeParam === 'string' && !isNaN(parseInt(pageSizeParam, 10))
      ? parseInt(pageSizeParam, 10)
      : 10;

    // Parse enum parameters
    const mediaType = (req.query.mediaType as MediaTypeFilter) || 'combined';
    const sortBy = (req.query.sortBy as SortOption) || 'relevance';
    const version = (req.query.version as ApiVersion) || 'v2';

    logger.info('Search parameters:', {
      search: searchQuery,
      username,
      librarySlug,
      page,
      pageSize,
      mediaType,
      sortBy,
      version
    });

    // Validate required parameters
    if (!searchQuery || typeof searchQuery !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Validate enum parameters
    const validMediaTypes: MediaTypeFilter[] = ['physical', 'digital', 'combined'];
    const validSortOptions: SortOption[] = ['relevance', 'availability', 'title', 'author', 'date'];
    const validVersions: ApiVersion[] = ['v1', 'v2'];

    if (mediaType && !validMediaTypes.includes(mediaType as MediaTypeFilter)) {
      return res.status(400).json({
        error: `Invalid mediaType. Must be one of: ${validMediaTypes.join(', ')}`
      });
    }

    if (sortBy && !validSortOptions.includes(sortBy as SortOption)) {
      return res.status(400).json({
        error: `Invalid sortBy. Must be one of: ${validSortOptions.join(', ')}`
      });
    }

    if (version && !validVersions.includes(version as ApiVersion)) {
      return res.status(400).json({
        error: `Invalid version. Must be one of: ${validVersions.join(', ')}`
      });
    }

    // Connect to browser with error handling
    let browser;
    let puppeteerPage;

    try {
      logger.info('Connecting to browser...');
      browser = await puppeteer.connect({
        browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT,
        acceptInsecureCerts: true,
        protocolTimeout: 120000,
      }).catch(err => {
        logger.error('Failed to connect to browser:', err);
        throw new Error(`Browser connection failed: ${err.message}`);
      });

      puppeteerPage = await browser.newPage().catch(err => {
        logger.error('Failed to create new page:', err);
        throw new Error(`Failed to create browser page: ${err.message}`);
      });

      logger.info('Browser connected successfully');
    } catch (browserError) {
      logger.error('Browser setup error:', browserError);
      return res.status(500).json({
        error: 'Search failed',
        message: 'Failed to set up browser for search',
        details: browserError instanceof Error ? browserError.message : String(browserError)
      });
    }

    try {
      // Prepare search parameters
      const searchParams: SearchParams = {
        search: searchQuery as string,
        username: username as string,
        password: password as string,
        librarySlug,
        page,
        pageSize,
        mediaType: mediaType as MediaTypeFilter,
        sortBy: sortBy as SortOption,
        version: version as ApiVersion
      };

      // Get configurations
      const legacyConfig = getLegacyConfig();
      const yclConfig = getYclConfig({ librarySlug });

      // Set a timeout for the entire search operation
      const searchPromise = performCombinedSearch(
        legacyConfig,
        yclConfig,
        searchParams,
        puppeteerPage
      );

      // Add a timeout to prevent hanging
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Search operation timed out after 60 seconds')), 60000);
      });

      // Race the search against the timeout
      const searchResult = await Promise.race([searchPromise, timeoutPromise])
        .catch(err => {
          logger.error('Search operation failed or timed out:', err);
          // Return a partial result with just legacy results if available
          return {
            meta: {
              currentPage: page,
              pageSize: pageSize,
              totalResults: 0,
              totalPages: 0,
              mediaTypeCounts: {
                physical: 0,
                digital: 0
              }
            },
            results: []
          };
        });

      // Format response based on version
      if (version === 'v1') {
        // For v1, format response to match legacy format
        const legacyFormat = {
          meta: {
            currentPage: searchResult.meta.currentPage,
            pageSize: searchResult.meta.pageSize,
            totalResults: searchResult.meta.totalResults,
            totalPages: searchResult.meta.totalPages
          },
          results: searchResult.results.map(item => {
            if (item.mediaType === 'physical') {
              // Convert to legacy format for physical items
              return {
                bookJacketUrl: item.imageUrl,
                googlePreviewUrl: item.additionalDetails.googlePreviewUrl,
                title: item.title,
                expandedAuthor: item.author,
                author: item.author,
                extraFields: item.additionalDetails.extraFields || {},
                description: item.description,
                availability: item.availability,
                copies: item.copies
              };
            } else {
              // For digital items, include a mediaType field to distinguish them
              return {
                bookJacketUrl: item.imageUrl,
                title: item.title,
                author: item.author,
                extraFields: {},
                description: item.description,
                availability: item.availability,
                copies: item.copies,
                mediaType: 'digital'
              };
            }
          })
        };

        res.json(legacyFormat);
      } else {
        // For v2, return the new format
        res.json(searchResult);
      }
    } catch (error) {
      logger.error('Error performing combined search:', error);

      // Enhanced error logging with more details
      const errorDetails = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        searchQuery,
        username,
        librarySlug,
        mediaType,
        page,
        pageSize
      };
      logger.error('Search error details:', errorDetails);

      // Return a more specific error message if available
      if (error instanceof Error && error.message.includes('Invalid character in header')) {
        res.status(500).json({
          error: 'Search failed due to invalid header characters',
          details: 'This is likely due to special characters in the cookie or other headers'
        });
      } else {
        res.status(500).json({
          error: 'Search failed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      // Safely close the browser
      if (browser) {
        try {
          await browser.close().catch(err => {
            logger.warn(`Error closing browser (non-fatal): ${err.message}`);
          });
        } catch (closeError) {
          logger.warn('Error in browser.close():', closeError);
        }
      }
    }
  } catch (error) {
    logger.error('Unexpected error in search endpoint:', error);
    logger.error('Error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url: req.url,
      query: req.query
    });

    // Send a detailed error response
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      timestamp: new Date().toISOString()
    });
  }
});

// Add global error handler to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Application specific logging, throwing an error, or other logic here
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      legacy: true,
      ycl: !!getYclConfig({ librarySlug: '' }),
    }
  });
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info('BROWSER_WS_ENDPOINT ', process.env.BROWSER_WS_ENDPOINT);
});
