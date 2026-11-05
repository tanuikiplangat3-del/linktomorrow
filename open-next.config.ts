// OpenNext settings for Cloudflare Workers.
//
// Every page that shows data is rendered fresh on each request (they read the
// session and the database), so no data cache is configured. The few static
// pages (terms, refund) are served from the files built at deploy time.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
