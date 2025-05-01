import { Page } from 'puppeteer';
import { catalogSearch, catalogDetail, CatalogResponse } from '../ycl/client';
import { getRedirectSetCookie } from '../ycl/getRedirectSetCookie';
import { UnifiedResult } from '../models/unifiedResult';
import loggers from '../utils/logger';

const { ycl: logger } = loggers;

/**
 * YCL service configuration
 */
export interface YCLServiceConfig {
  host: string;
  protocol?: 'https' | 'http';
  librarySlug: string;
}

/**
 * State for YCL service
 */
export interface YCLServiceState {
  config: YCLServiceConfig;
  cookie: string | null;
}

// Re-export the getRedirectSetCookie function from the YCL module
export { getRedirectSetCookie } from '../ycl/getRedirectSetCookie';

/**
 * Search for digital assets
 * @param state YCL service state with config and cookie
 * @param searchText Search query
 * @param page Page number (1-based)
 * @param pageSize Number of results per page
 * @returns Array of unified results
 */
export const searchYCL = async (
  state: YCLServiceState,
  searchText: string,
  page: number = 1,
  pageSize: number = 10
): Promise<UnifiedResult[]> => {
  try {
    if (!state.cookie) {
      throw new Error('YCL service requires an authentication cookie');
    }

    logger.info(`Searching YCL for "${searchText}" (page ${page}, size ${pageSize})`);

    // Calculate offset for pagination
    const offset = (page - 1) * pageSize;

    // Perform search using the YCL client
    const response = await catalogSearch<any>({
      host: state.config.host,
      protocol: state.config.protocol || 'https',
      librarySlug: state.config.librarySlug,
      searchText,
      cookie: state.cookie,
      extraParams: {
        offset: offset.toString(),
        limit: pageSize.toString(),
        owned: 'yes'
      }
    });

    // Check if the response is HTML instead of JSON
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      throw new Error('YCL returned HTML instead of JSON. Authentication may have failed.');
    }

    if (response.status === 200 && !response.json?.results?.search?.items) {
      logger.warn('YCL returned 200 status but no search items were found in the response');
      return [];
    }

    if (!response.json?.results?.search?.items) {
      logger.warn(`YCL search returned status ${response.status} with no items`);
      return [];
    }

    // Transform YCL results to unified format
    const results = response.json.results.search.items.map(item =>
      mapYCLItemToUnifiedResult(item, state.config.librarySlug)
    );

    logger.info(`Found ${results.length} digital assets`);
    return results;
  } catch (error) {
    // Enhanced error logging with more details
    logger.error('Error searching YCL:', error);

    // Rethrow with more context to help diagnose the issue
    if (error instanceof Error) {
      throw new Error(`Error searching YCL: ${error.message}`);
    }
    throw new Error(`Error searching YCL: ${String(error)}`);
  }
};

/**
 * Get total count of results for a search
 * @param state YCL service state with config and cookie
 * @param searchText Search query
 * @returns Total count of results
 */
export const getYCLTotalCount = async (
  state: YCLServiceState,
  searchText: string
): Promise<number> => {
  try {
    if (!state.cookie) {
      throw new Error('YCL service requires an authentication cookie');
    }

    const response = await catalogSearch<any>({
      host: state.config.host,
      protocol: state.config.protocol || 'https',
      librarySlug: state.config.librarySlug,
      searchText,
      cookie: state.cookie,
      extraParams: {
        limit: '1', // Just need count, not actual results
        owned: 'yes'
      }
    });

    return response.json?.results?.search?.totalItems || 0;
  } catch (error) {
    // Enhanced error logging
    logger.error('Error getting total count from YCL:', error);
    return 0;
  }
};

/**
 * Map YCL item to unified result format
 * @param item YCL search result item
 * @param librarySlug The library slug to use in the details URL
 * @returns Unified result
 */
export const mapYCLItemToUnifiedResult = (item: any, librarySlug: string): UnifiedResult => {
  // Get the base URL from environment variable
  const baseUrl = process.env.YCL_AUTH_URL?.replace(/\/[^\/]*$/, '') || 'https://example.com';

  // Generate the external details page URL using documentId
  const detailsUrl = `${baseUrl}/library/${librarySlug}/detail/${item.documentId}`;

  return {
    id: `ycl-${item.id}`,
    title: item.title || 'Unknown Title',
    author: item.authors?.[0] || 'Unknown Author',
    description: item.summary || '',
    mediaType: 'digital',
    imageUrl: item.imageLinkThumbnail || null,
    availability: item.currentlyAvailable > 0 ? 'Available' : 'Checked Out',
    copies: item.totalCopies || 0,
    format: item.mediaType || 'eBook',
    source: 'ycl',
    sourceId: item.id,
    additionalDetails: {
      isbn: item.isbn,
      publisher: item.publisherName,
      publishDate: item.datePublished,
      language: item.language,
      subjects: item.subjects,
      seriesTitle: item.seriesTitle,
      detailsUrl: detailsUrl // Add the external details page URL
    }
  };
};