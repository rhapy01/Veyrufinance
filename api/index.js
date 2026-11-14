const appModule = require("../artifacts/api-server/dist/app.cjs");
const app = appModule.default || appModule;

module.exports = (req, res) => {
  const incoming = new URL(req.url, "http://localhost");
  const route = incoming.searchParams.get("__veyraroute");
  if (route !== null) {
    incoming.searchParams.delete("__veyraroute");
    const query = incoming.searchParams.toString();
    req.url = `/api${route ? `/${route}` : ""}${query ? `?${query}` : ""}`;
  }
  return app(req, res);
};
