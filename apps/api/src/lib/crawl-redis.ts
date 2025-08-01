import { InternalOptions } from "../scraper/scrapeURL";
import { ScrapeOptions, TeamFlags } from "../controllers/v1/types";
import { WebCrawler } from "../scraper/WebScraper/crawler";
import { redisEvictConnection } from "../services/redis";
import { logger as _logger } from "./logger";
import { getAdjustedMaxDepth } from "../scraper/WebScraper/utils/maxDepthUtils";
import type { Logger } from "winston";

export type StoredCrawl = {
  originUrl?: string;
  crawlerOptions: any;
  scrapeOptions: Omit<ScrapeOptions, "timeout">;
  internalOptions: InternalOptions;
  team_id: string;
  robots?: string;
  cancelled?: boolean;
  createdAt: number;
  maxConcurrency?: number;
  zeroDataRetention?: boolean;
};

export async function saveCrawl(id: string, crawl: StoredCrawl) {
  _logger.debug("Saving crawl " + id + " to Redis...", {
    crawl,
    module: "crawl-redis",
    method: "saveCrawl",
    crawlId: id,
    teamId: crawl.team_id,
    zeroDataRetention: crawl.zeroDataRetention,
  });
  await redisEvictConnection.set("crawl:" + id, JSON.stringify(crawl));
  await redisEvictConnection.expire("crawl:" + id, 24 * 60 * 60);

  await redisEvictConnection.sadd("crawls_by_team_id:" + crawl.team_id, id);
  await redisEvictConnection.expire("crawls_by_team_id:" + crawl.team_id, 24 * 60 * 60);
}

export async function getCrawlsByTeamId(team_id: string): Promise<string[]> {
  return await redisEvictConnection.smembers("crawls_by_team_id:" + team_id);
}

export async function getCrawl(id: string): Promise<StoredCrawl | null> {
  const x = await redisEvictConnection.get("crawl:" + id);

  if (x === null) {
    return null;
  }

  await redisEvictConnection.expire("crawl:" + id, 24 * 60 * 60);
  return JSON.parse(x);
}

export async function getCrawlExpiry(id: string): Promise<Date> {
  const d = new Date();
  const ttl = await redisEvictConnection.pttl("crawl:" + id);
  d.setMilliseconds(d.getMilliseconds() + ttl);
  d.setMilliseconds(0);
  return d;
}

export async function addCrawlJob(id: string, job_id: string, __logger: Logger = _logger) {
  __logger.debug("Adding crawl job " + job_id + " to Redis...", {
    jobId: job_id,
    module: "crawl-redis",
    method: "addCrawlJob",
    crawlId: id,
  });
  await redisEvictConnection.sadd("crawl:" + id + ":jobs", job_id);
  await redisEvictConnection.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
}

export async function addCrawlJobs(id: string, job_ids: string[], __logger: Logger = _logger) {
  if (job_ids.length === 0) return true;

  __logger.debug("Adding crawl jobs to Redis...", {
    jobIds: job_ids,
    module: "crawl-redis",
    method: "addCrawlJobs",
    crawlId: id,
  });
  await redisEvictConnection.sadd("crawl:" + id + ":jobs", ...job_ids);
  await redisEvictConnection.expire("crawl:" + id + ":jobs", 24 * 60 * 60);
}

export async function addCrawlJobDone(
  id: string,
  job_id: string,
  success: boolean,
  __logger: Logger = _logger,
) {
  __logger.debug("Adding done crawl job to Redis...", {
    jobId: job_id,
    module: "crawl-redis",
    method: "addCrawlJobDone",
    crawlId: id,
  });
  await redisEvictConnection.sadd("crawl:" + id + ":jobs_done", job_id);
  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_done",
    24 * 60 * 60,
  );

  if (success) {
    await redisEvictConnection.rpush("crawl:" + id + ":jobs_done_ordered", job_id);
  } else {
    // in case it's already been pushed, make sure it's removed
    await redisEvictConnection.lrem(
      "crawl:" + id + ":jobs_done_ordered",
      -1,
      job_id,
    );
  }

  await redisEvictConnection.expire(
    "crawl:" + id + ":jobs_done_ordered",
    24 * 60 * 60,
  );
}

export async function getDoneJobsOrderedLength(id: string): Promise<number> {
  await redisEvictConnection.expire("crawl:" + id + ":jobs_done_ordered", 24 * 60 * 60);
  return await redisEvictConnection.llen("crawl:" + id + ":jobs_done_ordered");
}

export async function getDoneJobsOrdered(
  id: string,
  start = 0,
  end = -1,
): Promise<string[]> {
  await redisEvictConnection.expire("crawl:" + id + ":jobs_done_ordered", 24 * 60 * 60);
  return await redisEvictConnection.lrange(
    "crawl:" + id + ":jobs_done_ordered",
    start,
    end,
  );
}

export async function isCrawlFinished(id: string) {
  await redisEvictConnection.expire("crawl:" + id + ":kickoff:finish", 24 * 60 * 60);
  return (
    (await redisEvictConnection.scard("crawl:" + id + ":jobs_done")) ===
      (await redisEvictConnection.scard("crawl:" + id + ":jobs")) &&
    (await redisEvictConnection.get("crawl:" + id + ":kickoff:finish")) !== null
  );
}

export async function isCrawlKickoffFinished(id: string) {
  await redisEvictConnection.expire("crawl:" + id + ":kickoff:finish", 24 * 60 * 60);
  return (
    (await redisEvictConnection.get("crawl:" + id + ":kickoff:finish")) !== null
  );
}

export async function isCrawlFinishedLocked(id: string) {
  return await redisEvictConnection.exists("crawl:" + id + ":finish");
}

export async function finishCrawlKickoff(id: string) {
  await redisEvictConnection.set(
    "crawl:" + id + ":kickoff:finish",
    "yes",
    "EX",
    24 * 60 * 60,
  );
}

export async function finishCrawlPre(id: string, __logger: Logger = _logger) {
  if (await isCrawlFinished(id)) {
    __logger.debug("Marking crawl as pre-finished.", {
      module: "crawl-redis",
      method: "finishCrawlPre",
      crawlId: id,
    });
    const set = await redisEvictConnection.setnx("crawl:" + id + ":finished_pre", "yes");
    await redisEvictConnection.expire("crawl:" + id + ":finished_pre", 24 * 60 * 60);
    return set === 1;
  }
}

export async function unPreFinishCrawl(id: string) {
  _logger.debug("Un-pre-finishing crawl.", {
    module: "crawl-redis",
    method: "unPreFinishCrawl",
    crawlId: id,
  });
  await redisEvictConnection.del("crawl:" + id + ":finished_pre");
}

export async function finishCrawl(id: string, __logger: Logger = _logger) {
  __logger.debug("Marking crawl as finished.", {
    module: "crawl-redis",
    method: "finishCrawl",
    crawlId: id,
  });
  await redisEvictConnection.set("crawl:" + id + ":finish", "yes");
  await redisEvictConnection.expire("crawl:" + id + ":finish", 24 * 60 * 60);
  
  const crawl = await getCrawl(id);
  if (crawl && crawl.team_id) {
    await redisEvictConnection.srem("crawls_by_team_id:" + crawl.team_id, id);
    await redisEvictConnection.expire("crawls_by_team_id:" + crawl.team_id, 24 * 60 * 60);
  }

  // Clear visited sets to save memory
  await redisEvictConnection.del("crawl:" + id + ":visited");
  await redisEvictConnection.del("crawl:" + id + ":visited_unique");
}

export async function getCrawlJobs(id: string): Promise<string[]> {
  return await redisEvictConnection.smembers("crawl:" + id + ":jobs");
}

export async function getCrawlJobCount(id: string): Promise<number> {
  return await redisEvictConnection.scard("crawl:" + id + ":jobs");
}

export function normalizeURL(url: string, sc: StoredCrawl): string {
  const urlO = new URL(url);
  if (sc && sc.crawlerOptions && sc.crawlerOptions.ignoreQueryParameters) {
    urlO.search = "";
  }
  urlO.hash = "";
  return urlO.href;
}

export function generateURLPermutations(url: string | URL): URL[] {
  const urlO = new URL(url);

  // Construct two versions, one with www., one without
  const urlWithWWW = new URL(urlO);
  const urlWithoutWWW = new URL(urlO);
  if (urlO.hostname.startsWith("www.")) {
    urlWithoutWWW.hostname = urlWithWWW.hostname.slice(4);
  } else {
    urlWithWWW.hostname = "www." + urlWithoutWWW.hostname;
  }

  let permutations = [urlWithWWW, urlWithoutWWW];

  // Construct more versions for http/https
  permutations = permutations.flatMap((urlO) => {
    if (!["http:", "https:"].includes(urlO.protocol)) {
      return [urlO];
    }

    const urlWithHTTP = new URL(urlO);
    const urlWithHTTPS = new URL(urlO);
    urlWithHTTP.protocol = "http:";
    urlWithHTTPS.protocol = "https:";

    return [urlWithHTTP, urlWithHTTPS];
  });

  // Construct more versions for index.html/index.php
  permutations = permutations.flatMap((urlO) => {
    const urlWithHTML = new URL(urlO);
    const urlWithPHP = new URL(urlO);
    const urlWithBare = new URL(urlO);
    const urlWithSlash = new URL(urlO);

    if (urlO.pathname.endsWith("/")) {
      urlWithBare.pathname = urlWithBare.pathname.length === 1 ? urlWithBare.pathname : urlWithBare.pathname.slice(0, -1);
      urlWithHTML.pathname += "index.html";
      urlWithPHP.pathname += "index.php";
    } else if (urlO.pathname.endsWith("/index.html")) {
      urlWithPHP.pathname = urlWithPHP.pathname.slice(0, -"index.html".length) + "index.php";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(0, -"index.html".length);
      urlWithBare.pathname = urlWithBare.pathname.slice(0, -"/index.html".length);
    } else if (urlO.pathname.endsWith("/index.php")) {
      urlWithHTML.pathname = urlWithHTML.pathname.slice(0, -"index.php".length) + "index.html";
      urlWithSlash.pathname = urlWithSlash.pathname.slice(0, -"index.php".length);
      urlWithBare.pathname = urlWithBare.pathname.slice(0, -"/index.php".length);
    } else {
      urlWithSlash.pathname += "/";
      urlWithHTML.pathname += "/index.html";
      urlWithPHP.pathname += "/index.php";
    }

    return [urlWithHTML, urlWithPHP, urlWithSlash, urlWithBare];
  });

  return [...new Set(permutations.map(x => x.href))].map(x => new URL(x));
}

export async function lockURL(
  id: string,
  sc: StoredCrawl,
  url: string,
): Promise<boolean> {
  url = normalizeURL(url, sc);
  
  if (typeof sc.crawlerOptions?.limit === "number") {
    if (
      (await redisEvictConnection.scard("crawl:" + id + ":visited_unique")) >=
      sc.crawlerOptions.limit
    ) {
      return false;
    }
  }

  let res: boolean;
  if (!sc.crawlerOptions?.deduplicateSimilarURLs) {
    res = (await redisEvictConnection.sadd("crawl:" + id + ":visited", url)) !== 0;
  } else {
    const permutations = generateURLPermutations(url).map((x) => x.href);
    const x = await redisEvictConnection.sadd(
      "crawl:" + id + ":visited",
      ...permutations,
    );
    res = x === permutations.length;
  }

  await redisEvictConnection.expire("crawl:" + id + ":visited", 24 * 60 * 60);

  if (res) {
    await redisEvictConnection.sadd("crawl:" + id + ":visited_unique", url);
    await redisEvictConnection.expire(
      "crawl:" + id + ":visited_unique",
      24 * 60 * 60,
    );
  }

  return res;
}

/// NOTE: does not check limit. only use if limit is checked beforehand e.g. with sitemap
export async function lockURLs(
  id: string,
  sc: StoredCrawl,
  urls: string[],
  __logger: Logger = _logger,
): Promise<boolean> {
  if (urls.length === 0) return true;

  urls = urls.map((url) => normalizeURL(url, sc));
  const logger = __logger.child({
    crawlId: id,
    module: "crawl-redis",
    method: "lockURLs",
    teamId: sc.team_id,
  });

  // Add to visited_unique set
  logger.debug("Locking " + urls.length + " URLs...");
  await redisEvictConnection.sadd("crawl:" + id + ":visited_unique", ...urls);
  await redisEvictConnection.expire(
    "crawl:" + id + ":visited_unique",
    24 * 60 * 60,
  );

  let res: boolean;
  if (!sc.crawlerOptions?.deduplicateSimilarURLs) {
    const x = await redisEvictConnection.sadd("crawl:" + id + ":visited", ...urls);
    res = x === urls.length;
  } else {
    const allPermutations = urls.flatMap((url) =>
      generateURLPermutations(url).map((x) => x.href),
    );
    logger.debug("Adding " + allPermutations.length + " URL permutations...");
    const x = await redisEvictConnection.sadd(
      "crawl:" + id + ":visited",
      ...allPermutations,
    );
    res = x === allPermutations.length;
  }

  await redisEvictConnection.expire("crawl:" + id + ":visited", 24 * 60 * 60);

  logger.debug("lockURLs final result: " + res, { res });
  return res;
}

export async function lockURLsIndividually(
  id: string,
  sc: StoredCrawl,
  jobs: { id: string; url: string }[],
) {
  const out: typeof jobs = [];

  for (const job of jobs) {
    if (await lockURL(id, sc, job.url)) {
      out.push(job);
    }
  }

  return out;
}

export function crawlToCrawler(
  id: string,
  sc: StoredCrawl,
  teamFlags: TeamFlags,
  newBase?: string,
  crawlerOptions?: any,
): WebCrawler {
  const crawler = new WebCrawler({
    jobId: id,
    initialUrl: sc.originUrl!,
    baseUrl: newBase ? new URL(newBase).origin : undefined,
    includes: (sc.crawlerOptions?.includes ?? []).filter(x => x.trim().length > 0),
    excludes: (sc.crawlerOptions?.excludes ?? []).filter(x => x.trim().length > 0),
    maxCrawledLinks: sc.crawlerOptions?.maxCrawledLinks ?? 1000,
    maxCrawledDepth: getAdjustedMaxDepth(
      sc.originUrl!,
      sc.crawlerOptions?.maxDepth ?? 10,
    ),
    limit: sc.crawlerOptions?.limit ?? 10000,
    generateImgAltText: sc.crawlerOptions?.generateImgAltText ?? false,
    allowBackwardCrawling: sc.crawlerOptions?.allowBackwardCrawling ?? false,
    allowExternalContentLinks:
      sc.crawlerOptions?.allowExternalContentLinks ?? false,
    allowSubdomains: sc.crawlerOptions?.allowSubdomains ?? false,
    ignoreRobotsTxt: teamFlags?.ignoreRobots ?? sc.crawlerOptions?.ignoreRobotsTxt ?? false,
    regexOnFullURL: sc.crawlerOptions?.regexOnFullURL ?? false,
    maxDiscoveryDepth: sc.crawlerOptions?.maxDiscoveryDepth,
    currentDiscoveryDepth: crawlerOptions?.currentDiscoveryDepth ?? 0,
    zeroDataRetention: (teamFlags?.forceZDR || sc.zeroDataRetention) ?? false,
  });

  if (sc.robots !== undefined) {
    try {
      crawler.importRobotsTxt(sc.robots);
    } catch (_) {}
  }

  return crawler;
}
