import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc, gte } from "drizzle-orm";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  COHERE_API_KEY: string;
  FACTCHECK_API_KEY?: string;
  NEWS_API_KEY?: string;
};

interface CohereResponse {
  generations: Array<{
    text: string;
  }>;
}

interface FactCheckResult {
  status: "true" | "false" | "mixed" | "unverified";
  confidence: number;
  sources: string[];
  reasoning: string;
}

interface WebpageContent {
  title: string;
  content: string;
  url: string;
}

interface WikipediaResult {
  title: string;
  extract: string;
  content_urls?: {
    desktop: {
      page: string;
    };
  };
}

interface DuckDuckGoResult {
  Abstract: string;
  AbstractText: string;
  AbstractSource: string;
  AbstractURL: string;
  Answer: string;
  AnswerType: string;
  Infobox?: any;
  RelatedTopics: Array<{
    Text: string;
    FirstURL: string;
  }>;
}

interface ExternalFactCheckResult {
  source: string;
  verdict?: string;
  summary: string;
  url: string;
  confidence: number;
}

const app = new Hono<{ Bindings: Bindings }>();

// Helper function to call Cohere AI
async function callCohere(prompt: string, apiKey: string): Promise<string> {
  const response = await fetch("https://api.cohere.ai/v1/generate", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "command",
      prompt: prompt,
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`Cohere API error: ${response.statusText}`);
  }

  const data = await response.json() as CohereResponse;
  return data.generations[0]?.text?.trim() || "";
}

// Helper function to search Wikipedia
async function searchWikipedia(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // Clean the query for Wikipedia search
    const cleanQuery = query.replace(/[^\w\s]/g, '').trim();
    const encodedQuery = encodeURIComponent(cleanQuery);

    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodedQuery}`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as WikipediaResult;

    return {
      source: "Wikipedia",
      summary: data.extract || "No summary available",
      url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodedQuery}`,
      confidence: 0.8, // Wikipedia is generally reliable
    };
  } catch (error) {
    console.error("Wikipedia API error:", error);
    return null;
  }
}

// Helper function to search DuckDuckGo Instant Answer
async function searchDuckDuckGo(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(`https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_redirect=1&no_html=1`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as DuckDuckGoResult;

    // Check for direct answer
    if (data.Answer && data.Answer.trim()) {
      return {
        source: "DuckDuckGo Instant Answer",
        summary: data.Answer,
        url: data.AbstractURL || "https://duckduckgo.com",
        confidence: 0.7,
      };
    }

    // Check for abstract
    if (data.AbstractText && data.AbstractText.trim()) {
      return {
        source: `DuckDuckGo (${data.AbstractSource || "Various Sources"})`,
        summary: data.AbstractText,
        url: data.AbstractURL || "https://duckduckgo.com",
        confidence: 0.6,
      };
    }

    return null;
  } catch (error) {
    console.error("DuckDuckGo API error:", error);
    return null;
  }
}

// Helper function to search Snopes RSS feeds
async function searchSnopes(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // Search recent Snopes articles via RSS
    const response = await fetch("https://www.snopes.com/feed/");

    if (!response.ok) {
      return null;
    }

    const rssText = await response.text();

    // Simple RSS parsing - look for items that might match the query
    const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 3);
    const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || [];

    for (const item of items.slice(0, 10)) { // Check first 10 items
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || "";
      const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

      // Check if any query words appear in title or description
      const content = (title + " " + description).toLowerCase();
      const matchCount = queryWords.filter(word => content.includes(word)).length;

      if (matchCount >= Math.min(2, queryWords.length)) {
        // Extract verdict from description if possible
        let verdict = "";
        if (description.toLowerCase().includes("false") || description.toLowerCase().includes("fake")) {
          verdict = "False";
        } else if (description.toLowerCase().includes("true") || description.toLowerCase().includes("correct")) {
          verdict = "True";
        } else if (description.toLowerCase().includes("mixture") || description.toLowerCase().includes("mixed")) {
          verdict = "Mixed";
        }

        return {
          source: "Snopes",
          verdict: verdict || undefined,
          summary: description.replace(/<[^>]*>/g, '').substring(0, 300) + "...",
          url: link,
          confidence: 0.9, // Snopes is highly reliable
        };
      }
    }

    return null;
  } catch (error) {
    console.error("Snopes RSS error:", error);
    return null;
  }
}

// Helper function to query Wikidata
async function queryWikidata(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // Simple SPARQL query to find entities related to the query
    const sparqlQuery = `
      SELECT ?item ?itemLabel ?description WHERE {
        ?item rdfs:label ?itemLabel .
        ?item schema:description ?description .
        FILTER(LANG(?itemLabel) = "en")
        FILTER(LANG(?description) = "en")
        FILTER(CONTAINS(LCASE(?itemLabel), LCASE("${query.replace(/"/g, '').substring(0, 50)}")))
      }
      LIMIT 3
    `;

    const encodedQuery = encodeURIComponent(sparqlQuery);
    const response = await fetch(`https://query.wikidata.org/sparql?query=${encodedQuery}&format=json`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as any;

    if (data.results?.bindings?.length > 0) {
      const result = data.results.bindings[0];
      const itemLabel = result.itemLabel?.value || "";
      const description = result.description?.value || "";
      const itemUri = result.item?.value || "";

      return {
        source: "Wikidata",
        summary: `${itemLabel}: ${description}`,
        url: itemUri,
        confidence: 0.8,
      };
    }

    return null;
  } catch (error) {
    console.error("Wikidata SPARQL error:", error);
    return null;
  }
}

// Helper function to search Liquipedia for esports results
async function searchLiquipedia(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // Extract tournament and game information from query
    const lowerQuery = query.toLowerCase();
    let game = "";
    let searchTerm = query;

    // Detect game from query
    if (lowerQuery.includes("cs:go") || lowerQuery.includes("counter-strike") || lowerQuery.includes("stockholm major")) {
      game = "counterstrike";
    } else if (lowerQuery.includes("dota") || lowerQuery.includes("international")) {
      game = "dota2";
    } else if (lowerQuery.includes("league") || lowerQuery.includes("worlds") || lowerQuery.includes("lol")) {
      game = "leagueoflegends";
    } else if (lowerQuery.includes("valorant")) {
      game = "valorant";
    }

    if (!game) return null;

    // Search Liquipedia for tournament results
    const searchUrl = `https://${game}.liquipedia.net/api.php?action=opensearch&search=${encodeURIComponent(searchTerm)}&limit=5&format=json`;

    const response = await fetch(searchUrl);
    if (!response.ok) return null;

    const data = await response.json() as [string, string[], string[], string[]];
    const [, titles, descriptions, urls] = data;

    if (titles.length === 0) return null;

    // Look for tournament pages
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i];
      const description = descriptions[i] || "";
      const url = urls[i];

      if (title.toLowerCase().includes("major") ||
        title.toLowerCase().includes("championship") ||
        title.toLowerCase().includes("tournament") ||
        title.toLowerCase().includes("2021")) {

        return {
          source: `Liquipedia (${game})`,
          summary: `${title}: ${description}`,
          url: url,
          confidence: 0.85, // Liquipedia is very reliable for esports
        };
      }
    }

    return null;
  } catch (error) {
    console.error("Liquipedia search error:", error);
    return null;
  }
}

// Helper function to search ESPN for sports results
async function searchESPN(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // ESPN doesn't have a public search API, but we can try their news API
    // This is a simplified approach - in practice you'd need more sophisticated parsing

    // Try ESPN's RSS feeds for sports news
    const response = await fetch(`https://www.espn.com/espn/rss/news`);
    if (!response.ok) return null;

    const rssText = await response.text();

    // Simple RSS parsing to find relevant sports news
    const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 3);
    const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || [];

    for (const item of items.slice(0, 10)) {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        item.match(/<title>(.*?)<\/title>/)?.[1] || "";
      const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] ||
        item.match(/<description>(.*?)<\/description>/)?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

      const content = (title + " " + description).toLowerCase();
      const matchCount = queryWords.filter(word => content.includes(word)).length;

      if (matchCount >= Math.min(2, queryWords.length)) {
        return {
          source: "ESPN Sports News",
          summary: `${title}: ${description.replace(/<[^>]*>/g, '').substring(0, 200)}...`,
          url: link,
          confidence: 0.75,
        };
      }
    }

    return null;
  } catch (error) {
    console.error("ESPN search error:", error);
    return null;
  }
}

// Helper function to search TheSportsDB
async function searchSportsDB(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // TheSportsDB has a free API for sports data
    const searchTerm = encodeURIComponent(query);

    // Try searching for events
    const response = await fetch(`https://www.thesportsdb.com/api/v1/json/1/searchevents.php?e=${searchTerm}`);
    if (!response.ok) return null;

    const data = await response.json() as any;

    if (data.event && data.event.length > 0) {
      const event = data.event[0];
      return {
        source: "TheSportsDB",
        summary: `${event.strEvent}: ${event.strHomeTeam} vs ${event.strAwayTeam} on ${event.dateEvent}`,
        url: `https://www.thesportsdb.com/event/${event.idEvent}`,
        confidence: 0.8,
      };
    }

    return null;
  } catch (error) {
    console.error("TheSportsDB search error:", error);
    return null;
  }
}

// Helper function to search PubMed for medical claims
async function searchPubMed(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // PubMed E-utilities API (free, no key required)
    const searchTerm = encodeURIComponent(query);

    // First, search for relevant articles
    const searchResponse = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${searchTerm}&retmax=5&retmode=json`
    );

    if (!searchResponse.ok) return null;

    const searchData = await searchResponse.json() as any;
    const pmids = searchData.esearchresult?.idlist;

    if (!pmids || pmids.length === 0) return null;

    // Get details for the first relevant article
    const detailResponse = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids[0]}&retmode=json`
    );

    if (!detailResponse.ok) return null;

    const detailData = await detailResponse.json() as any;
    const article = detailData.result?.[pmids[0]];

    if (!article) return null;

    return {
      source: "PubMed/NCBI",
      summary: `${article.title} - ${article.authors?.[0]?.name || 'Unknown author'} et al. (${article.pubdate}) - ${article.source}`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmids[0]}/`,
      confidence: 0.9, // PubMed is highly reliable for medical information
    };
  } catch (error) {
    console.error("PubMed search error:", error);
    return null;
  }
}

// Helper function to search WHO databases
async function searchWHO(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // WHO doesn't have a public API, but we can search their RSS feeds and fact sheets
    const response = await fetch("https://www.who.int/rss-feeds/news-english.xml");

    if (!response.ok) return null;

    const rssText = await response.text();

    // Simple RSS parsing for WHO health information
    const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 3);
    const items = rssText.match(/<item>[\s\S]*?<\/item>/g) || [];

    for (const item of items.slice(0, 10)) {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        item.match(/<title>(.*?)<\/title>/)?.[1] || "";
      const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] ||
        item.match(/<description>(.*?)<\/description>/)?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";

      const content = (title + " " + description).toLowerCase();
      const matchCount = queryWords.filter(word => content.includes(word)).length;

      if (matchCount >= Math.min(2, queryWords.length)) {
        return {
          source: "World Health Organization (WHO)",
          summary: `${title}: ${description.replace(/<[^>]*>/g, '').substring(0, 200)}...`,
          url: link,
          confidence: 0.95, // WHO is extremely reliable for health information
        };
      }
    }

    return null;
  } catch (error) {
    console.error("WHO search error:", error);
    return null;
  }
}

// Helper function to search SEC EDGAR for financial claims
async function searchSEC(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // SEC EDGAR API (free, but rate limited)
    const searchTerm = encodeURIComponent(query);

    // Search for company filings
    const response = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&search=${searchTerm}&output=atom`,
      {
        headers: {
          'User-Agent': 'FactCheckr/1.0 (fact-checking-service@example.com)'
        }
      }
    );

    if (!response.ok) return null;

    const atomText = await response.text();

    // Simple parsing of SEC EDGAR atom feed
    const entries = atomText.match(/<entry>[\s\S]*?<\/entry>/g) || [];

    if (entries.length > 0) {
      const entry = entries[0];
      if (entry) {
        const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const summary = entry.match(/<summary>(.*?)<\/summary>/)?.[1] || "";
        const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*>/)?.[1] || "";

        return {
          source: "SEC EDGAR Database",
          summary: `${title}: ${summary.replace(/<[^>]*>/g, '').substring(0, 200)}...`,
          url: link.startsWith('http') ? link : `https://www.sec.gov${link}`,
          confidence: 0.9, // SEC filings are highly reliable for financial information
        };
      }
    }

    return null;
  } catch (error) {
    console.error("SEC search error:", error);
    return null;
  }
}

// Helper function to search arXiv for scientific papers
async function searchArXiv(query: string): Promise<ExternalFactCheckResult | null> {
  try {
    // arXiv API (free, no authentication required)
    const searchTerm = encodeURIComponent(query);

    const response = await fetch(
      `http://export.arxiv.org/api/query?search_query=all:${searchTerm}&start=0&max_results=5`
    );

    if (!response.ok) return null;

    const xmlText = await response.text();

    // Simple XML parsing for arXiv results
    const entries = xmlText.match(/<entry>[\s\S]*?<\/entry>/g) || [];

    if (entries.length > 0) {
      const entry = entries[0];
      if (entry) {
        const title = entry.match(/<title>(.*?)<\/title>/)?.[1]?.trim() || "";
        const summary = entry.match(/<summary>(.*?)<\/summary>/)?.[1]?.trim() || "";
        const authors = entry.match(/<name>(.*?)<\/name>/g)?.map(match =>
          match.replace(/<\/?name>/g, '')
        ).slice(0, 3) || [];
        const arxivId = entry.match(/<id>http:\/\/arxiv\.org\/abs\/(.*?)<\/id>/)?.[1] || "";

        return {
          source: "arXiv Preprint Server",
          summary: `${title} - ${authors.join(', ')} - ${summary.substring(0, 200)}...`,
          url: `https://arxiv.org/abs/${arxivId}`,
          confidence: 0.8, // arXiv papers are reliable but not peer-reviewed
        };
      }
    }

    return null;
  } catch (error) {
    console.error("arXiv search error:", error);
    return null;
  }
}

// Helper function to search Google Scholar (placeholder - needs SerpAPI)
// async function searchGoogleScholar(query: string): Promise<ExternalFactCheckResult | null> {
//   // This would need SerpAPI or similar service
//   return null;
// }

// Helper function to search legal databases (placeholder - needs API keys)
// async function searchLegalDB(query: string): Promise<ExternalFactCheckResult | null> {
//   // This would need CourtListener API key or similar
//   return null;
// }

// Helper function to scrape webpage content
async function scrapeWebpage(url: string): Promise<WebpageContent> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FactCheckr/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch webpage: ${response.statusText}`);
    }

    const html = await response.text();

    // Simple HTML parsing without external dependencies
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "Unknown Title";

    // Remove script and style tags, then extract text content
    const cleanHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      title,
      content: cleanHtml.substring(0, 5000), // Limit content length
      url,
    };
  } catch (error) {
    throw new Error(`Failed to scrape webpage: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// Helper function to verify a claim using external APIs + Cohere with enhanced sports/esports support
async function verifyClaim(claim: string, context: string | undefined, apiKey: string): Promise<FactCheckResult> {
  const externalResults: ExternalFactCheckResult[] = [];

  // Detect claim type for better source selection
  const lowerClaim = claim.toLowerCase();
  const isEsports = lowerClaim.includes("major") || lowerClaim.includes("tournament") ||
    lowerClaim.includes("cs:go") || lowerClaim.includes("dota") ||
    lowerClaim.includes("league") || lowerClaim.includes("valorant") ||
    lowerClaim.includes("esports") || lowerClaim.includes("gaming");

  const isSports = lowerClaim.includes("championship") || lowerClaim.includes("world cup") ||
    lowerClaim.includes("olympics") || lowerClaim.includes("nfl") ||
    lowerClaim.includes("nba") || lowerClaim.includes("football") ||
    lowerClaim.includes("soccer") || lowerClaim.includes("baseball");

  const isMedical = lowerClaim.includes("health") || lowerClaim.includes("medicine") ||
    lowerClaim.includes("disease") || lowerClaim.includes("vaccine") ||
    lowerClaim.includes("drug") || lowerClaim.includes("treatment") ||
    lowerClaim.includes("vitamin") || lowerClaim.includes("cancer") ||
    lowerClaim.includes("covid") || lowerClaim.includes("medical");

  const isFinancial = lowerClaim.includes("stock") || lowerClaim.includes("market") ||
    lowerClaim.includes("sec") || lowerClaim.includes("earnings") ||
    lowerClaim.includes("revenue") || lowerClaim.includes("profit") ||
    lowerClaim.includes("company") || lowerClaim.includes("financial");

  const isScientific = lowerClaim.includes("research") || lowerClaim.includes("study") ||
    lowerClaim.includes("science") || lowerClaim.includes("experiment") ||
    lowerClaim.includes("theory") || lowerClaim.includes("discovery") ||
    lowerClaim.includes("climate") || lowerClaim.includes("physics");

  // Try external APIs first
  try {
    // Always try general sources
    const wikiResult = await searchWikipedia(claim);
    if (wikiResult) {
      externalResults.push(wikiResult);
    }

    const ddgResult = await searchDuckDuckGo(claim);
    if (ddgResult) {
      externalResults.push(ddgResult);
    }

    const snopesResult = await searchSnopes(claim);
    if (snopesResult) {
      externalResults.push(snopesResult);
    }

    // Try specialized sources based on claim type
    if (isEsports) {
      const liquipediaResult = await searchLiquipedia(claim);
      if (liquipediaResult) {
        externalResults.push(liquipediaResult);
      }
    }

    if (isSports) {
      const espnResult = await searchESPN(claim);
      if (espnResult) {
        externalResults.push(espnResult);
      }

      const sportsDBResult = await searchSportsDB(claim);
      if (sportsDBResult) {
        externalResults.push(sportsDBResult);
      }
    }

    if (isMedical) {
      const pubmedResult = await searchPubMed(claim);
      if (pubmedResult) {
        externalResults.push(pubmedResult);
      }

      const whoResult = await searchWHO(claim);
      if (whoResult) {
        externalResults.push(whoResult);
      }
    }

    if (isFinancial) {
      const secResult = await searchSEC(claim);
      if (secResult) {
        externalResults.push(secResult);
      }
    }

    if (isScientific) {
      const arxivResult = await searchArXiv(claim);
      if (arxivResult) {
        externalResults.push(arxivResult);
      }
    }

    // Always try Wikidata for structured data
    const wikidataResult = await queryWikidata(claim);
    if (wikidataResult) {
      externalResults.push(wikidataResult);
    }
  } catch (error) {
    console.error("Error fetching external sources:", error);
  }

  // Cross-validation: Check for conflicting information
  const conflictAnalysis = analyzeSourceConflicts(externalResults);

  // Prepare context for AI analysis
  let enhancedContext = context || "";
  if (externalResults.length > 0) {
    enhancedContext += "\n\nExternal Sources Found:\n";
    externalResults.forEach((result, index) => {
      enhancedContext += `${index + 1}. ${result.source}: ${result.summary}`;
      if (result.verdict) {
        enhancedContext += ` (Verdict: ${result.verdict})`;
      }
      enhancedContext += `\n   Source: ${result.url}\n`;
    });

    if (conflictAnalysis.hasConflicts) {
      enhancedContext += `\n⚠️ CONFLICTING INFORMATION DETECTED:\n${conflictAnalysis.conflictSummary}\n`;
    }
  }

  const prompt = `Analyze the following claim for factual accuracy using the provided external sources:

Claim: "${claim}"
${enhancedContext ? `Context and External Sources: "${enhancedContext}"` : ""}

${isEsports ? "IMPORTANT: This appears to be an esports-related claim. Pay special attention to Liquipedia sources as they are highly authoritative for esports tournaments." : ""}
${isSports ? "IMPORTANT: This appears to be a sports-related claim. Pay special attention to ESPN and TheSportsDB sources for sports events." : ""}
${isMedical ? "IMPORTANT: This appears to be a medical/health claim. Pay special attention to PubMed and WHO sources as they are highly authoritative for medical information." : ""}
${isFinancial ? "IMPORTANT: This appears to be a financial claim. Pay special attention to SEC EDGAR sources for official financial information." : ""}
${isScientific ? "IMPORTANT: This appears to be a scientific claim. Pay special attention to arXiv and academic sources for scientific research." : ""}

Based on the external sources provided (if any) and your knowledge, please provide:
1. A verification status (true/false/mixed/unverified)
2. A confidence score from 0.0 to 1.0
3. Key sources or evidence that support or refute the claim
4. Clear reasoning for your assessment

${conflictAnalysis.hasConflicts ? "CRITICAL: There are conflicting sources. Please analyze carefully and explain the discrepancies." : ""}
${externalResults.length > 0 ? "IMPORTANT: Give higher weight to the external sources provided, especially specialized sources like Liquipedia for esports, ESPN for sports, PubMed/WHO for medical claims, SEC for financial data, or arXiv for scientific research." : ""}

Format your response as JSON with the following structure:
{
  "status": "true|false|mixed|unverified",
  "confidence": 0.0-1.0,
  "sources": ["source1", "source2"],
  "reasoning": "detailed explanation"
}`;

  try {
    const response = await callCohere(prompt, apiKey);

    // Try to parse JSON response
    try {
      const parsed = JSON.parse(response) as FactCheckResult;

      // Enhance sources with external results
      const allSources = [...(Array.isArray(parsed.sources) ? parsed.sources : [])];
      externalResults.forEach(result => {
        if (!allSources.includes(result.url)) {
          allSources.push(result.url);
        }
      });

      // Adjust confidence based on external sources and conflicts
      let adjustedConfidence = parsed.confidence || 0;
      if (externalResults.length > 0) {
        const avgExternalConfidence = externalResults.reduce((sum, r) => sum + r.confidence, 0) / externalResults.length;
        adjustedConfidence = Math.max(adjustedConfidence, avgExternalConfidence * 0.8);
      }

      // Reduce confidence if there are conflicts
      if (conflictAnalysis.hasConflicts) {
        adjustedConfidence = Math.max(0.3, adjustedConfidence * 0.7);
      }

      // Boost confidence for specialized sources
      const hasSpecializedSource = externalResults.some(r =>
        r.source.includes("Liquipedia") || r.source.includes("ESPN") || r.source.includes("TheSportsDB") ||
        r.source.includes("PubMed") || r.source.includes("WHO") || r.source.includes("SEC EDGAR") ||
        r.source.includes("arXiv")
      );
      if (hasSpecializedSource && !conflictAnalysis.hasConflicts) {
        adjustedConfidence = Math.max(adjustedConfidence, 0.85);
      }

      // If Snopes has a clear verdict, use it (but consider conflicts)
      const snopesResult = externalResults.find(r => r.source === "Snopes" && r.verdict);
      if (snopesResult && snopesResult.verdict && !conflictAnalysis.hasConflicts) {
        adjustedConfidence = Math.max(adjustedConfidence, 0.9);
      }

      return {
        status: parsed.status || "unverified",
        confidence: Math.max(0, Math.min(1, adjustedConfidence)),
        sources: allSources,
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    } catch {
      // Fallback if JSON parsing fails
      const sources = externalResults.map(r => r.url);
      return {
        status: "unverified",
        confidence: externalResults.length > 0 ? 0.6 : 0.3,
        sources: sources,
        reasoning: response || "Unable to verify claim",
      };
    }
  } catch (error) {
    const sources = externalResults.map(r => r.url);
    return {
      status: "unverified",
      confidence: externalResults.length > 0 ? 0.4 : 0,
      sources: sources,
      reasoning: `Error during verification: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// Helper function to analyze conflicts between sources
function analyzeSourceConflicts(results: ExternalFactCheckResult[]): { hasConflicts: boolean; conflictSummary: string } {
  if (results.length < 2) {
    return { hasConflicts: false, conflictSummary: "" };
  }

  // Look for contradictory information in summaries
  const summaries = results.map(r => r.summary.toLowerCase());
  const verdicts = results.filter(r => r.verdict).map(r => r.verdict!.toLowerCase());

  // Check for conflicting verdicts
  const hasTrue = verdicts.some(v => v.includes("true"));
  const hasFalse = verdicts.some(v => v.includes("false"));

  if (hasTrue && hasFalse) {
    return {
      hasConflicts: true,
      conflictSummary: "Sources provide conflicting verdicts (some say true, others say false)"
    };
  }

  // Check for contradictory keywords in summaries
  let conflicts: string[] = [];

  // Simple conflict detection - this could be enhanced
  for (let i = 0; i < summaries.length; i++) {
    for (let j = i + 1; j < summaries.length; j++) {
      const summary1 = summaries[i];
      const summary2 = summaries[j];

      // Look for opposite statements
      if ((summary1.includes("won") && summary2.includes("lost")) ||
        (summary1.includes("true") && summary2.includes("false")) ||
        (summary1.includes("yes") && summary2.includes("no"))) {
        conflicts.push(`${results[i].source} vs ${results[j].source}`);
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflictSummary: conflicts.length > 0 ? `Conflicting information between: ${conflicts.join(", ")}` : ""
  };
}

// Create MCP server
function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "factcheckr-mcp-server",
    version: "1.0.0",
    description: "MCP server for fact-checking claims and analyzing web content",
  });

  const db = drizzle(env.DB);

  // Tool 1: Verify Claim
  server.tool(
    "verify_claim",
    {
      claim: z.string().min(1).describe("The claim to verify"),
      context: z.string().optional().describe("Additional context for the claim"),
    },
    async ({ claim, context }) => {
      try {
        // Check if claim was recently verified
        const existingCheck = await db
          .select()
          .from(schema.factChecks)
          .where(eq(schema.factChecks.claimText, claim))
          .orderBy(desc(schema.factChecks.createdAt))
          .limit(1);

        if (existingCheck.length > 0) {
          const existing = existingCheck[0];
          return {
            content: [
              {
                type: "text",
                text: `Cached Result:\nStatus: ${existing.verificationStatus}\nConfidence: ${existing.confidenceScore}\nSources: ${JSON.stringify(existing.sources)}\nReasoning: ${existing.reasoning}`,
              },
            ],
          };
        }

        // Verify the claim
        const result = await verifyClaim(claim, context, env.COHERE_API_KEY);

        // Store result in database
        await db
          .insert(schema.factChecks)
          .values({
            claimText: claim,
            verificationStatus: result.status,
            confidenceScore: result.confidence,
            sources: result.sources,
            reasoning: result.reasoning,
          });

        return {
          content: [
            {
              type: "text",
              text: `Verification Complete:\nStatus: ${result.status}\nConfidence: ${result.confidence}\nSources: ${JSON.stringify(result.sources)}\nReasoning: ${result.reasoning}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error verifying claim: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 2: Analyze Webpage
  server.tool(
    "analyze_webpage",
    {
      url: z.string().url().describe("URL of the webpage to analyze"),
      focus_areas: z.array(z.string()).optional().describe("Specific topics to focus on"),
    },
    async ({ url, focus_areas }) => {
      try {
        // Check if URL was recently analyzed
        const existingAnalysis = await db
          .select()
          .from(schema.webpageAnalyses)
          .where(eq(schema.webpageAnalyses.url, url))
          .limit(1);

        if (existingAnalysis.length > 0) {
          const existing = existingAnalysis[0];
          return {
            content: [
              {
                type: "text",
                text: `Cached Analysis:\nTitle: ${existing.title}\nSummary: ${existing.summary}\nCredibility: ${existing.overallCredibility}\nClaims: ${JSON.stringify(existing.claimsExtracted)}`,
              },
            ],
          };
        }

        // Scrape webpage content
        const webContent = await scrapeWebpage(url);

        // Extract claims using Cohere
        const extractPrompt = `Analyze the following webpage content and extract factual claims that can be verified:

Title: ${webContent.title}
Content: ${webContent.content}
${focus_areas ? `Focus Areas: ${focus_areas.join(", ")}` : ""}

Please identify 3-5 key factual claims from this content that are specific and verifiable. Return them as a JSON array of strings.`;

        const claimsResponse = await callCohere(extractPrompt, env.COHERE_API_KEY);

        let extractedClaims: string[] = [];
        try {
          extractedClaims = JSON.parse(claimsResponse) as string[];
          if (!Array.isArray(extractedClaims)) {
            extractedClaims = [claimsResponse];
          }
        } catch {
          extractedClaims = [claimsResponse];
        }

        // Verify each extracted claim
        const factCheckResults = [];
        for (const claim of extractedClaims.slice(0, 3)) { // Limit to 3 claims
          const result = await verifyClaim(claim, `From webpage: ${webContent.title}`, env.COHERE_API_KEY);
          factCheckResults.push({ claim, ...result });
        }

        // Determine overall credibility
        const avgConfidence = factCheckResults.reduce((sum, r) => sum + r.confidence, 0) / factCheckResults.length;
        let overallCredibility: "high" | "medium" | "low" | "unknown" = "unknown";

        if (avgConfidence >= 0.8) {
          overallCredibility = "high";
        } else if (avgConfidence >= 0.6) {
          overallCredibility = "medium";
        } else if (avgConfidence >= 0.3) {
          overallCredibility = "low";
        }

        // Generate summary
        const summaryPrompt = `Summarize the credibility and key findings from this webpage analysis:

Title: ${webContent.title}
Claims analyzed: ${extractedClaims.length}
Overall credibility: ${overallCredibility}
Average confidence: ${avgConfidence.toFixed(2)}

Provide a brief 2-3 sentence summary of the webpage's factual reliability.`;

        const summary = await callCohere(summaryPrompt, env.COHERE_API_KEY);

        // Store analysis in database
        await db
          .insert(schema.webpageAnalyses)
          .values({
            url,
            title: webContent.title,
            summary,
            claimsExtracted: extractedClaims,
            overallCredibility,
            factCheckResults,
          });

        return {
          content: [
            {
              type: "text",
              text: `Webpage Analysis Complete:\nTitle: ${webContent.title}\nSummary: ${summary}\nCredibility: ${overallCredibility}\nClaims Analyzed: ${extractedClaims.length}\nFact-Check Results: ${JSON.stringify(factCheckResults, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing webpage: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Generate Daily Digest
  server.tool(
    "generate_daily_digest",
    {
      date: z.string().optional().describe("Date for digest (YYYY-MM-DD format, defaults to today)"),
      include_trending: z.boolean().optional().default(true).describe("Include trending claims analysis"),
    },
    async ({ date, include_trending }) => {
      try {
        const targetDate = date || new Date().toISOString().split("T")[0];

        // Check if digest already exists for this date
        const existingDigest = await db
          .select()
          .from(schema.dailyDigests)
          .where(eq(schema.dailyDigests.digestDate, targetDate))
          .limit(1);

        if (existingDigest.length > 0) {
          const existing = existingDigest[0];
          return {
            content: [
              {
                type: "text",
                text: `Daily Digest for ${targetDate}:\n\n${existing.summary}\n\nTrending Claims: ${JSON.stringify(existing.trendingClaims, null, 2)}`,
              },
            ],
          };
        }

        // Get recent fact-checks and analyses
        const recentChecks = await db
          .select()
          .from(schema.factChecks)
          .where(gte(schema.factChecks.createdAt, targetDate))
          .orderBy(desc(schema.factChecks.createdAt))
          .limit(20);

        const recentAnalyses = await db
          .select()
          .from(schema.webpageAnalyses)
          .where(gte(schema.webpageAnalyses.analyzedAt, targetDate))
          .orderBy(desc(schema.webpageAnalyses.analyzedAt))
          .limit(10);

        // Generate trending claims analysis
        let trendingClaims: any[] = [];
        if (include_trending && recentChecks.length > 0) {
          const trendingPrompt = `Analyze these recent fact-checks and identify trending topics or patterns:

Recent Fact-Checks:
${recentChecks.map(check => `- ${check.claimText} (${check.verificationStatus})`).join("\n")}

Identify 3-5 trending topics or notable patterns. Return as JSON array with objects containing "topic" and "description" fields.`;

          try {
            const trendingResponse = await callCohere(trendingPrompt, env.COHERE_API_KEY);
            trendingClaims = JSON.parse(trendingResponse) as any[];
          } catch {
            trendingClaims = [{ topic: "Analysis Error", description: "Unable to identify trending topics" }];
          }
        }

        // Generate daily summary
        const summaryPrompt = `Create a daily digest summary based on this fact-checking activity:

Date: ${targetDate}
Fact-checks performed: ${recentChecks.length}
Webpage analyses: ${recentAnalyses.length}
True claims: ${recentChecks.filter(c => c.verificationStatus === "true").length}
False claims: ${recentChecks.filter(c => c.verificationStatus === "false").length}
Mixed/Unverified: ${recentChecks.filter(c => ["mixed", "unverified"].includes(c.verificationStatus)).length}

Write a 3-4 sentence summary of the day's fact-checking activity and key insights.`;

        const summary = await callCohere(summaryPrompt, env.COHERE_API_KEY);

        // Store digest in database
        await db
          .insert(schema.dailyDigests)
          .values({
            digestDate: targetDate,
            trendingClaims,
            summary,
          });

        return {
          content: [
            {
              type: "text",
              text: `Daily Digest Generated for ${targetDate}:\n\n${summary}\n\nTrending Claims: ${JSON.stringify(trendingClaims, null, 2)}\n\nStats:\n- Fact-checks: ${recentChecks.length}\n- Webpage analyses: ${recentAnalyses.length}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating daily digest: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// MCP endpoint
app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();

  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

// Public endpoint for daily digest
app.get("/daily-digest", async (c) => {
  const db = drizzle(c.env.DB);
  const date = c.req.query("date") || new Date().toISOString().split("T")[0];
  const format = c.req.query("format") || "json";

  try {
    const digest = await db
      .select()
      .from(schema.dailyDigests)
      .where(eq(schema.dailyDigests.digestDate, date))
      .limit(1);

    if (digest.length === 0) {
      return c.json({ error: "No digest found for this date" }, 404);
    }

    const digestData = digest[0];

    if (format === "markdown") {
      const markdown = `# Daily Fact-Check Digest - ${date}

${digestData.summary}

## Trending Claims

${digestData.trendingClaims?.map((claim: any) => `### ${claim.topic}\n${claim.description}`).join("\n\n") || "No trending claims identified"}

*Generated at: ${digestData.generatedAt}*`;

      return c.text(markdown, 200, {
        "Content-Type": "text/markdown",
      });
    }

    return c.json({
      date: digestData.digestDate,
      summary: digestData.summary,
      trendingClaims: digestData.trendingClaims,
      generatedAt: digestData.generatedAt,
    });
  } catch (error) {
    return c.json({
      error: "Failed to retrieve daily digest",
      details: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});

// Get digest for specific date
app.get("/daily-digest/:date", async (c) => {
  const db = drizzle(c.env.DB);
  const date = c.req.param("date");

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "Invalid date format. Use YYYY-MM-DD" }, 400);
  }

  try {
    const digest = await db
      .select()
      .from(schema.dailyDigests)
      .where(eq(schema.dailyDigests.digestDate, date))
      .limit(1);

    if (digest.length === 0) {
      return c.json({ error: "No digest found for this date" }, 404);
    }

    const digestData = digest[0];

    return c.json({
      date: digestData.digestDate,
      summary: digestData.summary,
      trendingClaims: digestData.trendingClaims,
      generatedAt: digestData.generatedAt,
    });
  } catch (error) {
    return c.json({
      error: "Failed to retrieve daily digest",
      details: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
});

// Health check endpoint
app.get("/", (c) => {
  return c.json({
    name: "FactCheckr MCP Server",
    version: "1.0.0",
    description: "MCP server for fact-checking claims and analyzing web content",
    endpoints: {
      mcp: "/mcp",
      dailyDigest: "/daily-digest",
      specificDigest: "/daily-digest/:date",
    },
  });
});

// OpenAPI specification
app.get("/openapi.json", (c) => {
  return c.json(createOpenAPISpec(app, {
    info: {
      title: "FactCheckr MCP Server",
      version: "1.0.0",
      description: "MCP server for fact-checking claims and analyzing web content",
    },
  }));
});

// Fiberplane API explorer
app.use("/fp/*", createFiberplane({
  app,
  openapi: { url: "/openapi.json" },
}));

export default app;