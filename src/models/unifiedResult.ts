/**
 * Unified result model for combined physical and digital media search
 */

export interface UnifiedResult {
  id: string;
  title: string;
  author: string;
  description: string;
  mediaType: 'physical' | 'digital';
  imageUrl: string | null;
  availability: string;
  copies: number;
  format: string;
  source: 'legacy' | 'ycl';
  sourceId: string;
  additionalDetails: Record<string, any>;
}

/**
 * Pagination metadata for search results
 */
export interface PaginationMeta {
  currentPage: number;
  pageSize: number;
  totalResults: number;
  totalPages: number;
  mediaTypeCounts: {
    physical: number;
    digital: number;
  };
}

/**
 * Combined search response structure
 */
export interface SearchResponse {
  meta: PaginationMeta;
  results: UnifiedResult[];
}

/**
 * Filter options for media type
 */
export type MediaTypeFilter = 'physical' | 'digital' | 'combined';

/**
 * Sort options for search results
 */
export type SortOption = 'relevance' | 'availability' | 'title' | 'author' | 'date';

/**
 * API version options
 */
export type ApiVersion = 'v1' | 'v2';

/**
 * Search request parameters
 */
export interface SearchParams {
  search: string;
  username: string;
  password?: string;
  librarySlug?: string;
  page?: number;
  pageSize?: number;
  mediaType?: MediaTypeFilter;
  sortBy?: SortOption;
  version?: ApiVersion;
}