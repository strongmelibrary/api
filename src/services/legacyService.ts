import { Page } from 'puppeteer';
import { scrapeLegacySite } from '../lw/client';
import { UnifiedResult } from '../models/unifiedResult';
import loggers from '../utils/logger';

const { lw: logger } = loggers;

/**
 * Legacy service state
 */
export interface LegacyServiceState {
  legacySiteUrl: string;
}

/**
 * Create a new Legacy service state
 */
export const createLegacyServiceState = (
  legacySiteUrl: string = process.env.LEGACY_SITE_URL || 'http://example.com'
): LegacyServiceState => ({
  legacySiteUrl
});

/**
 * Search for physical media
 * @param state Legacy service state
 * @param searchText Search query
 * @param username Legacy system username
 * @param password Legacy system password
 * @param page Page number (1-based)
 * @param pageSize Number of results per page (not directly controllable in legacy system)
 * @param puppeteerPage Puppeteer page instance
 * @returns Search results and pagination metadata
 */
export const searchLegacy = async (
  state: LegacyServiceState,
  searchText: string,
  username: string,
  password: string = '',
  page: number = 1,
  pageSize: number = 10,
  puppeteerPage: Page
): Promise<{
  results: UnifiedResult[];
  totalResults: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
}> => {
  try {
    logger.info(`Searching legacy system for "${searchText}" (page ${page})`);

    // Use the existing scrape function
    const scrapeResponse = await scrapeLegacySite(searchText, username, password, page, puppeteerPage);

    // Transform legacy results to unified format
    const results = scrapeResponse.results.map(mapLegacyBookToUnifiedResult);

    logger.info(`Found ${results.length} physical media items`);

    return {
      results,
      totalResults: scrapeResponse.meta.totalResults,
      totalPages: scrapeResponse.meta.totalPages,
      currentPage: scrapeResponse.meta.currentPage,
      pageSize: scrapeResponse.meta.pageSize
    };
  } catch (error) {
    logger.error('Error searching legacy system:', error);
    // Return empty results on error to allow graceful degradation
    return {
      results: [],
      totalResults: 0,
      totalPages: 0,
      currentPage: page,
      pageSize: pageSize
    };
  }
};

/**
 * Map legacy book info to unified result format
 * @param book Legacy book info
 * @returns Unified result
 */
export const mapLegacyBookToUnifiedResult = (book: any): UnifiedResult => {
  return {
    id: `legacy-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    title: book.title || 'Unknown Title',
    author: book.author || book.expandedAuthor || 'Unknown Author',
    description: book.description || '',
    mediaType: 'physical',
    imageUrl: book.bookJacketUrl || null,
    availability: book.availability || 'Unknown',
    copies: book.copies || 0,
    format: 'Book',
    source: 'legacy',
    sourceId: book.title, // Legacy system doesn't have unique IDs, use title as fallback
    additionalDetails: {
      googlePreviewUrl: book.googlePreviewUrl,
      extraFields: book.extraFields || {}
    }
  };
};