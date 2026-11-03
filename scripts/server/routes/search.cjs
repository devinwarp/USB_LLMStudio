// Web search API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const { comprehensiveWebSearch } = require("../../search/core");
const { readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createSearchRoutes(ctx) {
  const { WEB_SEARCH_CACHE } = ctx;
  const { routes, exact } = createRouteTable();

  exact("GET", "/api/web-search/config", async (req, res) => {
    return json(res, 200, {
      ok: true,
      provider: "duckduckgo",
      providers: [{ key: "duckduckgo", name: "DuckDuckGo", requiresApiKey: false, active: true }],
      cachePath: WEB_SEARCH_CACHE,
      defaults: { resultLimit: 5, fetchLimit: 3, timeFilter: "any" },
    });
  });

  exact("POST", "/api/web-search", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await comprehensiveWebSearch(body.query || body.q || "", {
        timeFilter: body.timeFilter || body.time_filter || "any",
        resultLimit: body.resultLimit || 5,
        fetchLimit: body.fetchLimit || 3,
        cacheDir: WEB_SEARCH_CACHE,
      });
      return json(res, 200, { ok: true, ...result });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  return routes;
};
