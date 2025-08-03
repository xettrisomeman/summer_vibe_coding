import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, real } from "drizzle-orm/sqlite-core";

export const factChecks = sqliteTable("fact_checks", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  claimText: text("claim_text").notNull(),
  verificationStatus: text("verification_status", { 
    enum: ["true", "false", "mixed", "unverified"] 
  }).notNull(),
  confidenceScore: real("confidence_score"),
  sources: text("sources", { mode: "json" }).$type<string[]>(),
  reasoning: text("reasoning"),
  createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const webpageAnalyses = sqliteTable("webpage_analyses", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  title: text("title"),
  summary: text("summary"),
  claimsExtracted: text("claims_extracted", { mode: "json" }).$type<string[]>(),
  overallCredibility: text("overall_credibility", { 
    enum: ["high", "medium", "low", "unknown"] 
  }),
  factCheckResults: text("fact_check_results", { mode: "json" }).$type<any[]>(),
  analyzedAt: text("analyzed_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});

export const dailyDigests = sqliteTable("daily_digests", {
  id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
  digestDate: text("digest_date").notNull().unique(),
  trendingClaims: text("trending_claims", { mode: "json" }).$type<any[]>(),
  summary: text("summary"),
  generatedAt: text("generated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});