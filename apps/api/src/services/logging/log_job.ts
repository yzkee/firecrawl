import { supabase_service } from "../supabase";
import { FirecrawlJob } from "../../types";
import { posthog } from "../posthog";
import "dotenv/config";
import { logger } from "../../lib/logger";
import { configDotenv } from "dotenv";
import { saveJobToGCS } from "../../lib/gcs-jobs";
configDotenv();

function cleanOfNull<T>(x: T): T {
  if (Array.isArray(x)) {
    return x.map((x) => cleanOfNull(x)) as T;
  } else if (typeof x === "object" && x !== null) {
    return Object.fromEntries(
      Object.entries(x).map(([k, v]) => [k, cleanOfNull(v)]),
    ) as T;
  } else if (typeof x === "string") {
    return x.replaceAll("\u0000", "") as T;
  } else {
    return x;
  }
}

async function indexJob(job: FirecrawlJob): Promise<void> {
  try {
    if (job.mode !== "single_urls" && job.mode !== "scrape") {
      return;
    }

    const response = await fetch(`${process.env.FIRE_INDEX_SERVER_URL}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: job.url,
        mode: job.mode || "scrape",
        docs: job.docs,
        origin: job.origin,
        success: job.success,
        time_taken: job.time_taken,
        num_tokens: job.num_tokens,
        page_options: job.scrapeOptions,
        date_added: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error(`Failed to send job to external server: ${response.status} ${response.statusText}`, {
        error: errorData,
        scrapeId: job.job_id,
      });
    } else {
      logger.debug("Job sent to external server successfully!", { scrapeId: job.job_id });
    }
  } catch (error) {
    logger.error(`Error sending job to external server: ${error.message}`, {
      error,
      scrapeId: job.job_id,
    });
  }
}

export async function logJob(job: FirecrawlJob, force: boolean = false) {
  try {
    const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
    if (!useDbAuthentication) {
      return;
    }

    // Redact any pages that have an authorization header
    // actually, Don't. we use the db to retrieve results now. this breaks authed crawls - mogery
    // if (
    //   job.scrapeOptions &&
    //   job.scrapeOptions.headers &&
    //   job.scrapeOptions.headers["Authorization"]
    // ) {
    //   job.scrapeOptions.headers["Authorization"] = "REDACTED";
    //   job.docs = [
    //     {
    //       content: "REDACTED DUE TO AUTHORIZATION HEADER",
    //       html: "REDACTED DUE TO AUTHORIZATION HEADER",
    //     },
    //   ];
    // }
    const jobColumn = {
      job_id: job.job_id ? job.job_id : null,
      success: job.success,
      message: job.message,
      num_docs: job.num_docs,
      docs: ((job.mode === "single_urls" || job.mode === "scrape") && process.env.GCS_BUCKET_NAME) ? null : cleanOfNull(job.docs),
      time_taken: job.time_taken,
      team_id: (job.team_id === "preview" || job.team_id?.startsWith("preview_"))? null : job.team_id,
      mode: job.mode,
      url: job.url,
      crawler_options: job.crawlerOptions,
      page_options: job.scrapeOptions,
      origin: job.origin,
      num_tokens: job.num_tokens,
      retry: !!job.retry,
      crawl_id: job.crawl_id,
      tokens_billed: job.tokens_billed,
      is_migrated: true,
    };

    // Send job to external server
    if (process.env.FIRE_INDEX_SERVER_URL) {
      indexJob(job);
    }

    if (process.env.GCS_BUCKET_NAME) {
      await saveJobToGCS(job);
    }

    if (force) {
      let i = 0,
        done = false;
      while (i++ <= 10) {
        try {
          const { error } = await supabase_service
            .from("firecrawl_jobs")
            .insert([jobColumn]);
          if (error) {
            logger.error(
              "Failed to log job due to Supabase error -- trying again",
              { error, scrapeId: job.job_id },
            );
            await new Promise<void>((resolve) =>
              setTimeout(() => resolve(), 75),
            );
          } else {
            done = true;
            break;
          }
        } catch (error) {
          logger.error(
            "Failed to log job due to thrown error -- trying again",
            { error, scrapeId: job.job_id },
          );
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 75));
        }
      }
      if (done) {
        logger.debug("Job logged successfully!", { scrapeId: job.job_id });
      } else {
        logger.error("Failed to log job!", { scrapeId: job.job_id });
      }
    } else {
      const { error } = await supabase_service
        .from("firecrawl_jobs")
        .insert([jobColumn]);
      if (error) {
        logger.error(`Error logging job: ${error.message}`, {
          error,
          scrapeId: job.job_id,
        });
      } else {
        logger.debug("Job logged successfully!", { scrapeId: job.job_id });
      }
    }

    if (process.env.POSTHOG_API_KEY && !job.crawl_id) {
      let phLog = {
        distinctId: "from-api", //* To identify this on the group level, setting distinctid to a static string per posthog docs: https://posthog.com/docs/product-analytics/group-analytics#advanced-server-side-only-capturing-group-events-without-a-user
        ...((job.team_id !== "preview" && !job.team_id?.startsWith("preview_")) && {
          groups: { team: job.team_id },
        }), //* Identifying event on this team
        event: "job-logged",
        properties: {
          success: job.success,
          message: job.message,
          num_docs: job.num_docs,
          time_taken: job.time_taken,
          team_id: (job.team_id === "preview" || job.team_id?.startsWith("preview_"))? null : job.team_id,
          mode: job.mode,
          url: job.url,
          crawler_options: job.crawlerOptions,
          page_options: job.scrapeOptions,
          origin: job.origin,
          num_tokens: job.num_tokens,
          retry: job.retry,
          tokens_billed: job.tokens_billed,
        },
      };
      if (job.mode !== "single_urls") {
        posthog.capture(phLog);
      }
    }
  } catch (error) {
    logger.error(`Error logging job: ${error.message}`);
  }
}
