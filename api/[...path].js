const { app } = require("../dist/app.js");

module.exports = (req, res) => {
  if (typeof req.url === "string") {
    req.url = req.url.replace(/^\/api\/health(?=\/|$)/, "/health");
  }
  return app(req, res);
};
