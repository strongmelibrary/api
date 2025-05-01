# Library Media Search API

A unified API for searching both physical and digital media from library sources. This service combines results from a legacy library system (physical media) and the YCL digital assets service (ebooks, etc.).

## Features

- **Combined Search**: Search across both physical and digital media in a single API call
- **Filtering**: Filter results by media type (physical/digital/combined)
- **Sorting**: Sort results by relevance, availability, title, or author
- **Unified Pagination**: Consistent pagination across combined results
- **Backward Compatibility**: Maintains the legacy API endpoint for existing clients
- **Graceful Degradation**: Falls back to available services if one is unavailable

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- Puppeteer-compatible browser (for scraping)
- Access credentials for the legacy library system
- Access to the YCL digital assets service (optional)

### Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd api
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create a `.env` file based on `.env.sample`:
   ```
   cp .env.sample .env
   ```

4. Update the `.env` file with your configuration:
   ```
   # Legacy system configuration
   LEGACY_SITE_URL=<legacy-site-url>
   LEGACY_SITE_USERNAME=<username>
   LEGACY_SITE_PASSWORD=<password>

   # YCL (digital assets) configuration
   YCL_HOST=ebook.yourcloudlibrary.com
   YCL_PROTOCOL=https
   YCL_LIBRARY_SLUG=<your-library-slug>
   YCL_AUTH_URL=https://ebook.yourcloudlibrary.com/auth/login

   # Puppeteer browser configuration
   BROWSER_WS_ENDPOINT=<browser-ws-endpoint>
   PORT=7700
   ```

### Running the Server

Start the server:
```
npm start
```

The server will be available at http://localhost:7700 (or the port specified in your .env file).

## API Endpoints

### Health Check

```
GET /health
```

Returns the operational status of the server and its services.

### Legacy Search (Backward Compatibility)

```
GET /api/scrape
```

Parameters:
- `search` (required): The search term
- `username` (required): Legacy system username
- `password` (optional): Legacy system password
- `page` (optional, default: 1): Page number

Returns search results from the legacy system only (physical media).

### Combined Search

```
GET /api/search
```

Parameters:
- `search` (required): The search term
- `username` (required): Legacy system username
- `password` (optional): Legacy system password
- `librarySlug` (optional): YCL library identifier, if omitted digital search will be skipped
- `page` (optional, default: 1): Page number for unified pagination
- `pageSize` (optional, default: 10): Number of results per page
- `mediaType` (optional, default: "combined"): Filter type - "physical", "digital", or "combined"
- `sortBy` (optional, default: "relevance"): Sort order - "relevance", "availability", "title", "author", "date"
- `version` (optional, default: "v2"): API response version - "v1" for legacy format, "v2" for new format

Returns combined search results from both physical and digital sources.

## Response Format

### v1 Format (Legacy)

```json
{
  "meta": {
    "currentPage": 1,
    "pageSize": 10,
    "totalResults": 100,
    "totalPages": 10
  },
  "results": [
    {
      "bookJacketUrl": "https://example.com/image.jpg",
      "googlePreviewUrl": "https://books.google.com/...",
      "title": "Book Title",
      "expandedAuthor": "Author Name",
      "author": "Author Name",
      "extraFields": {
        "Publisher": "Example Publisher",
        "ISBN": "1234567890"
      },
      "description": "Book description...",
      "availability": "Available",
      "copies": 2,
      "mediaType": "digital" // Only present for digital items
    }
  ]
}
```

### v2 Format (New)

```json
{
  "meta": {
    "currentPage": 1,
    "pageSize": 10,
    "totalResults": 100,
    "totalPages": 10,
    "mediaTypeCounts": {
      "physical": 40,
      "digital": 60
    }
  },
  "results": [
    {
      "id": "unique-id",
      "title": "Book Title",
      "author": "Author Name",
      "description": "Book description...",
      "mediaType": "physical|digital",
      "imageUrl": "https://example.com/image.jpg",
      "availability": "Available",
      "copies": 2,
      "format": "Book|eBook|Audiobook",
      "source": "legacy|ycl",
      "sourceId": "original-id-in-source-system",
      "additionalDetails": {
        "isbn": "1234567890",
        "publisher": "Example Publisher"
      }
    }
  ]
}
```

## Development

### Project Structure

```
src/
├── server.ts                 # Main server file
├── lw/                       # Legacy system client
│   └── client.ts             # Legacy scraping implementation
├── ycl/                      # YCL digital assets client
│   ├── client.ts             # YCL API client
│   ├── constants.ts          # YCL constants
│   ├── enums.ts              # YCL enums
│   └── getRedirectSetCookie.ts # YCL authentication helper
├── models/
│   └── unifiedResult.ts      # Unified result model
├── services/
│   ├── legacyService.ts      # Legacy service
│   ├── yclService.ts         # YCL service
│   └── searchService.ts      # Combined search service
```

### API Documentation

The API is documented using the OpenAPI specification. You can view the full API documentation by:

1. Opening the `openapi.json` file in a Swagger UI viewer
2. Using a tool like [Swagger Editor](https://editor.swagger.io/)

## License

This project is licensed under the ISC License - see the LICENSE file for details.
