// Route table shared by serve.cjs and the route modules in ./routes.
// A route matches like the original inline checks in serve.cjs:
//   exact:  req.url === path && req.method === method
//   prefix: req.url.startsWith(path) && req.method === method
const ROUTE_MATCH = Object.freeze({ EXACT: "exact", PREFIX: "prefix" });

function createRouteTable() {
  const routes = [];
  const add = (match) => (method, routePath, handler) => {
    routes.push({ method, match, path: routePath, handler });
  };
  return { routes, exact: add(ROUTE_MATCH.EXACT), prefix: add(ROUTE_MATCH.PREFIX) };
}

function routeMatches(route, req) {
  const urlMatches = route.match === ROUTE_MATCH.EXACT ? req.url === route.path : req.url.startsWith(route.path);
  return urlMatches && req.method === route.method;
}

function findRoute(routes, req) {
  return routes.find((route) => routeMatches(route, req)) || null;
}

module.exports = { ROUTE_MATCH, createRouteTable, findRoute };
