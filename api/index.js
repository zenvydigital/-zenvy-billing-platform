'use strict';

/**
 * Vercel serverless entry (Hobby, no card) — api/index.js.
 *
 * Vercel's Node runtime treats a file under api/ as a Serverless Function:
 * it calls the exported function with (req, res). An Express app IS a
 * function, so it can be exported directly — but this wrapper normalises
 * the URL first: if Vercel ever hands the function its own path
 * (/api/index...) instead of the original request path, the prefix is
 * stripped so Express routes match exactly as they do on Render.
 *
 * Routing (vercel.json): /api/* and /health rewrite here; everything in
 * public/ (index.html, app.js, style.css) is served statically by Vercel
 * before rewrites are applied, so the UI works unchanged.
 *
 * No listen(), no startup migrations here: a serverless function lives
 * only for one request. Migrations are applied once in the Supabase SQL
 * Editor from db/all-migrations.sql (see DEPLOY.md). The Postgres pool
 * (src/db.js) is a module-level singleton, so warm invocations reuse it;
 * cold starts create it fresh — that is normal on serverless.
 */

const app = require('../src/app');

module.exports = (req, res) => {
  if (req.url && req.url.startsWith('/api/index')) {
    req.url = req.url.slice('/api/index'.length) || '/';
  }
  return app(req, res);
};
