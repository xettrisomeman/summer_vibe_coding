# FactCheckr MCP Server Specification

This document outlines the design and implementation plan for FactCheckr, an MCP server that provides fact-checking capabilities through natural language processing and web analysis.

The server will support claim verification using reputable APIs, webpage analysis with claim extraction, and daily fact digest generation. Users can verify individual claims, analyze web content for factual accuracy, and receive curated fact-check summaries.

The system will be built using Cloudflare Workers with Hono as the API framework, Cohere AI for natural language processing, and external fact-checking APIs for verification.

## 1. Technology Stack

- **Edge Runtime:** Cloudflare Workers
- **API Framework:** Hono.js (TypeScript-based API framework)
- **MCP Framework:** @modelcontextprotocol/sdk and @hono/mcp
- **AI Provider:** Cohere AI (free tier)
- **External APIs:** NewsAPI, FactCheck.org API, Snopes API, or similar reputable fact-checking services
- **Web Scraping:** Cheerio or similar for HTML parsing

## 2. Database Schema Design

The system will use Cloudflare D1 to store fact-check results, sources, and daily digests for caching and historical reference.

### 2.1. fact_checks Table

- id (INTEGER, Primary Key, Auto Increment)
- claim_text (TEXT, NOT NULL)
- verification_status (TEXT, NOT NULL) // "true", "false", "mixed", "unverified"
- confidence_score (REAL) // 0.0 to 1.0
- sources (TEXT) // JSON array of source URLs and descriptions
- reasoning (TEXT) // AI-generated explanation
- created_at (TEXT, NOT NULL)
- updated_at (TEXT, NOT NULL)

### 2.2. webpage_analyses Table

- id (INTEGER, Primary Key, Auto Increment)
- url (TEXT, NOT NULL, UNIQUE)
- title (TEXT)
- summary (TEXT)
- claims_extracted (TEXT) // JSON array of extracted claims
- overall_credibility (TEXT) // "high", "medium", "low", "unknown"
- fact_check_results (TEXT) // JSON array of fact-check results for each claim
- analyzed_at (TEXT, NOT NULL)

### 2.3. daily_digests Table

- id (INTEGER, Primary Key, Auto Increment)
- digest_date (TEXT, NOT NULL, UNIQUE) // YYYY-MM-DD format
- trending_claims (TEXT) // JSON array of trending fact-checks
- summary (TEXT) // Daily summary of fact-checking activity
- generated_at (TEXT, NOT NULL)

## 3. API Endpoints

The API will be structured around MCP tools and a public endpoint for daily digests.

### 3.1. MCP Server Endpoint

- **ALL /mcp**
  - Description: Main MCP server endpoint handling JSON-RPC requests
  - Supports three tools: verify_claim, analyze_webpage, generate_daily_digest

### 3.2. Public Endpoints

- **GET /daily-digest**
  - Description: Retrieve the latest daily fact-check digest
  - Query Params: 
    - date (optional): specific date in YYYY-MM-DD format
    - format (optional): "json" or "markdown"
  - Response: Daily digest with trending claims and summaries

- **GET /daily-digest/:date**
  - Description: Retrieve digest for a specific date
  - Path Params: date in YYYY-MM-DD format

## 4. MCP Tools Implementation

### 4.1. verify_claim Tool

- **Purpose:** Verify factual claims using natural language processing and external APIs
- **Input Schema:**
  ```json
  {
    "claim": "string (required) - The claim to verify",
    "context": "string (optional) - Additional context for the claim"
  }
  ```
- **Process:**
  1. Use Cohere AI to analyze and categorize the claim
  2. Query external fact-checking APIs for similar claims
  3. Cross-reference multiple sources
  4. Generate confidence score and reasoning
  5. Store result in database
- **Output:** Verification status, confidence score, sources, and detailed reasoning

### 4.2. analyze_webpage Tool

- **Purpose:** Extract and verify claims from web pages
- **Input Schema:**
  ```json
  {
    "url": "string (required) - URL of the webpage to analyze",
    "focus_areas": "array (optional) - Specific topics to focus on"
  }
  ```
- **Process:**
  1. Scrape webpage content using Cheerio
  2. Use Cohere AI to extract factual claims from content
  3. Verify each extracted claim using verify_claim logic
  4. Generate overall credibility assessment
  5. Store analysis in database
- **Output:** Page summary, extracted claims, fact-check results, and credibility score

### 4.3. generate_daily_digest Tool

- **Purpose:** Create daily summaries of fact-checking activity and trending claims
- **Input Schema:**
  ```json
  {
    "date": "string (optional) - Date for digest (defaults to today)",
    "include_trending": "boolean (optional) - Include trending claims analysis"
  }
  ```
- **Process:**
  1. Query database for recent fact-checks and analyses
  2. Use Cohere AI to identify trending topics and patterns
  3. Generate summary of daily fact-checking activity
  4. Create digest with key findings and notable claims
  5. Store digest in database
- **Output:** Formatted daily digest with trending claims and insights

## 5. Integrations

- **Cohere AI:** For natural language processing, claim extraction, and content analysis
- **External Fact-Checking APIs:** Integration with services like FactCheck.org, Snopes, or PolitiFact APIs
- **NewsAPI:** For cross-referencing claims with recent news
- **Web Scraping Libraries:** For extracting content from URLs

## 6. Additional Notes

### 6.1. Environment Variables

The following environment variables should be configured:
- `COHERE_API_KEY`: API key for Cohere AI service
- `FACTCHECK_API_KEY`: API key for fact-checking service
- `NEWS_API_KEY`: API key for NewsAPI (if used)

### 6.2. Rate Limiting and Caching

- Implement caching for repeated claims and webpage analyses
- Use database to avoid re-processing identical content
- Respect rate limits of external APIs

### 6.3. MCP Inspector Support

- Ensure proper tool schemas for MCP Inspector compatibility
- Include comprehensive examples in tool descriptions
- Provide clear error messages and validation

### 6.4. Deployment Configuration

- Configure Cloudflare Workers with appropriate memory and CPU limits
- Set up D1 database bindings
- Configure environment variables for API keys

## 7. Further Reading

Take inspiration from the project template here: https://github.com/fiberplane/create-honc-app/tree/main/templates/d1

For MCP server implementation patterns, reference the MCP SDK documentation and examples.