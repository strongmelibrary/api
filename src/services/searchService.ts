import { Page } from 'puppeteer';
import {
  UnifiedResult,
  SearchResponse,
  PaginationMeta,
  MediaTypeFilter,
  SortOption,
  SearchParams
} from '../models/unifiedResult';
import {
  LegacyServiceState,
  searchLegacy,
  createLegacyServiceState
} from './legacyService';
import {
  YCLServiceConfig,
  searchYCL,
  getYCLTotalCount,
  getRedirectSetCookie
} from './yclService';
import loggers from '../utils/logger';

const { search: logger } = loggers;

/**
 * Perform a combined search across both physical and digital media
 * @param legacyConfig Legacy service configuration
 * @param yclConfig YCL service configuration (optional)
 * @param params Search parameters
 * @param puppeteerPage Puppeteer page instance
 * @returns Search response
 */
export const performCombinedSearch = async (
  legacyConfig: { legacySiteUrl: string },
  yclConfig: YCLServiceConfig & { authUrl: string } | null,
  params: SearchParams,
  puppeteerPage: Page
): Promise<SearchResponse> => {
  const {
    search,
    username,
    password = '',
    librarySlug,
    page = 1,
    pageSize = 10,
    mediaType = 'combined',
    sortBy = 'relevance'
  } = params;

  // Create legacy state
  const legacyState = createLegacyServiceState(legacyConfig.legacySiteUrl);

  // Determine which services to query based on mediaType filter
  const queryLegacy = mediaType === 'physical' || mediaType === 'combined';
  const queryYcl = mediaType === 'digital' || mediaType === 'combined' && !!yclConfig && !!librarySlug;

  // Initialize promises array
  const promises: Promise<any>[] = [];

  // Add legacy search promise if needed
  let legacyPromise;
  if (queryLegacy) {
    legacyPromise = searchLegacy(
      legacyState,
      search,
      username,
      password,
      page,
      pageSize,
      puppeteerPage
    );
    promises.push(legacyPromise);
  }

  // Add YCL search promise if needed and available
  let yclPromise;
  let yclCookie: string | null = null;

  if (queryYcl && yclConfig) {
    try {
      // Create a new page for YCL authentication to isolate any issues
      const yclPage = await puppeteerPage.browser().newPage();

      try {
        // Get authentication cookie for this request
        logger.info(`Getting YCL authentication cookie for ${yclConfig.authUrl}`);
        yclCookie = await getRedirectSetCookie(yclPage, yclConfig.authUrl);

        // Close the YCL page after getting the cookie
        await yclPage.close().catch(err => {
          logger.warn(`Error closing YCL page (non-fatal): ${err.message}`);
        });

        if (yclCookie) {
          logger.info(`Successfully obtained YCL cookie`);

          // Create YCL service state
          const yclState = {
            config: {
              host: yclConfig.host,
              protocol: yclConfig.protocol || 'https',
              librarySlug: yclConfig.librarySlug
            },
            cookie: yclCookie
          };

          // Use the cookie directly for this request
          try {
            // Add YCL search promise with a timeout
            const yclSearchPromise = Promise.race([
              searchYCL(yclState, search, page, pageSize),
              new Promise<any[]>((_, reject) =>
                setTimeout(() => reject(new Error('YCL search timeout')), 15000)
              )
            ]).catch(err => {
              logger.error(`YCL search failed: ${err.message}`);
              return []; // Return empty array on error
            });

            promises.push(yclSearchPromise);

            // Also get total count for pagination with a timeout
            const yclCountPromise = Promise.race([
              getYCLTotalCount(yclState, search),
              new Promise<number>((_, reject) =>
                setTimeout(() => reject(new Error('YCL count timeout')), 15000)
              )
            ]).catch(err => {
              logger.error(`YCL count failed: ${err.message}`);
              return 0; // Return 0 on error
            });

            promises.push(yclCountPromise);
          } catch (searchError) {
            logger.error('Error setting up YCL search:', searchError);
          }
        } else {
          logger.warn('Failed to get YCL authentication cookie - cookie is null');
        }
      } catch (error) {
        logger.error('Failed to get YCL authentication cookie:', error);

        // Try to close the YCL page if there was an error
        await yclPage.close().catch(() => {
          // Ignore errors when closing the page
        });
      }
    } catch (browserError) {
      logger.error('Error creating browser page for YCL:', browserError);
      // Continue without YCL results - graceful degradation
    }
  }

  // Execute all promises in parallel
  let results;
  try {
    logger.info(`Executing ${promises.length} search promises in parallel`);
    results = await Promise.all(promises);
    logger.info('All search promises completed successfully');
  } catch (error) {
    logger.error('Error executing search promises:', error);
    // Create an empty results array to allow graceful degradation
    results = [];
    for (let i = 0; i < promises.length; i++) {
      results.push(null);
    }
  }

  // Extract results based on which services were queried
  let legacyResults: UnifiedResult[] = [];
  let legacyMeta = {
    totalResults: 0,
    totalPages: 0,
    currentPage: page,
    pageSize: pageSize
  };

  let yclResults: UnifiedResult[] = [];
  let yclTotalCount = 0;

  let resultIndex = 0;

  if (queryLegacy && results[resultIndex]) {
    const legacyResponse = results[resultIndex++];
    if (legacyResponse) {
      legacyResults = legacyResponse.results || [];
      legacyMeta = {
        totalResults: legacyResponse.totalResults || 0,
        totalPages: legacyResponse.totalPages || 0,
        currentPage: legacyResponse.currentPage || page,
        pageSize: legacyResponse.pageSize || pageSize
      };
    }
  } else if (queryLegacy) {
    // Skip the null result
    resultIndex++;
  }

  if (queryYcl && yclCookie && resultIndex < results.length) {
    yclResults = results[resultIndex++] || [];
    if (resultIndex < results.length) {
      yclTotalCount = results[resultIndex++] || 0;
    }
  }

  // Combine results based on mediaType filter
  let combinedResults: UnifiedResult[] = [];

  if (mediaType === 'physical') {
    combinedResults = legacyResults;
  } else if (mediaType === 'digital') {
    combinedResults = yclResults;
  } else {
    // For combined results, we need to merge and sort
    combinedResults = mergeAndSortResults(legacyResults, yclResults, sortBy);

    // Apply unified pagination to combined results
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    combinedResults = combinedResults.slice(startIndex, endIndex);
  }

  // Create pagination metadata
  const meta: PaginationMeta = {
    currentPage: page,
    pageSize: pageSize,
    totalResults: legacyMeta.totalResults + yclTotalCount,
    totalPages: Math.ceil((legacyMeta.totalResults + yclTotalCount) / pageSize),
    mediaTypeCounts: {
      physical: legacyMeta.totalResults,
      digital: yclTotalCount
    }
  };

  return {
    meta,
    results: combinedResults
  };
};

/**
 * Merge and sort results from both sources
 * @param legacyResults Results from legacy system
 * @param yclResults Results from YCL system
 * @param sortBy Sort option
 * @returns Sorted combined results
 */
export const mergeAndSortResults = (
  legacyResults: UnifiedResult[],
  yclResults: UnifiedResult[],
  sortBy: SortOption
): UnifiedResult[] => {
  // Combine all results
  const combined = [...legacyResults, ...yclResults];

  // Sort based on the specified option
  switch (sortBy) {
    case 'title':
      return combined.sort((a, b) => a.title.localeCompare(b.title));

    case 'author':
      return combined.sort((a, b) => a.author.localeCompare(b.author));

    case 'availability':
      // Sort available items first
      return combined.sort((a, b) => {
        const aAvailable = a.availability.toLowerCase().includes('available') ? 0 : 1;
        const bAvailable = b.availability.toLowerCase().includes('available') ? 0 : 1;
        return aAvailable - bAvailable;
      });

    case 'relevance':
    default:
      // For relevance, we'll prioritize physical items that are available,
      // then digital items that are available, then the rest
      return combined.sort((a, b) => {
        const aScore = calculateRelevanceScore(a);
        const bScore = calculateRelevanceScore(b);
        return bScore - aScore; // Higher score first
      });
  }
};

/**
 * Calculate a relevance score for sorting
 * @param result Unified result
 * @returns Relevance score
 */
export const calculateRelevanceScore = (result: UnifiedResult): number => {
  let score = 0;

  // Prioritize available items
  if (result.availability.toLowerCase().includes('available')) {
    score += 100;
  }

  // Slight boost for physical items that are available
  if (result.mediaType === 'physical' && result.availability.toLowerCase().includes('available')) {
    score += 10;
  }

  // Boost items with more copies
  score += Math.min(result.copies, 10);

  return score;
};