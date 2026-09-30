import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Task 4: the Vercel serverless entrypoint and the routing that keeps the SPA
 * and the Express API on one origin.
 *
 * These tests read the real `vercel.json` and the real `api/index.js` rather
 * than duplicating them, because a routing bug that lives only in the config
 * file would be invisible to a test of a copy of the config. The two failures
 * that matter here are mirrored:
 *
 * 1. A rewrite ordering mistake turns `/api/health` into `index.html`, so the
 *    SPA swallows the API and the frontend silently loses every request.
 * 2. Importing the local entrypoint from the function would run `app.listen()`
 *    and the startup database check inside the function, which cannot work on
 *    Vercel and must not touch a database at import time.
 */

/** The repository root, so the paths below do not depend on the current directory. */
const repoRoot = path.resolve(__dirname, "..", "..");

const vercelConfigPath = path.join(repoRoot, "vercel.json");
const vercelEntryPointPath = path.join(repoRoot, "api", "index.js");
const backendDistAppPath = path.join(repoRoot, "backend", "dist", "app.js");
const backendDistIndexPath = path.join(repoRoot, "backend", "dist", "index.js");
const backendSourceEntryPointPath = path.join(repoRoot, "backend", "src", "index.ts");
const viteConfigPath = path.join(repoRoot, "frontend", "vite.config.ts");

interface VercelRewrite {
  source: string;
  destination: string;
}

interface VercelConfig {
  framework?: string | null;
  buildCommand?: string;
  outputDirectory?: string;
  rewrites?: VercelRewrite[];
  env?: Record<string, unknown>;
  build?: Record<string, unknown>;
}

/**
 * API paths that must always reach Express. `/api/health` is first because it
 * is the cheapest way to notice that the SPA fallback has swallowed the API,
 * and because it is the probe the LAN and local checks depend on.
 */
const API_PATHS = [
  "/api/health",
  "/api/auth/me",
  "/api/auth/student/login",
  "/api/student/device",
  "/api/auth/student/device/options",
  "/api/auth/student/device/verify",
  "/api/admin/students",
];

/** Frontend routes that BrowserRouter must be able to load directly. */
const SPA_PATHS = [
  "/",
  "/login",
  "/register",
  "/app/student",
  "/app/lecturer",
  "/app/admin",
];

/** Module names that would represent a startup database operation. */
const STARTUP_MODULE_PATTERN = /^(runMigrations|migrate|.*seed.*|.*reset.*|.*cleanup.*)\.js$/i;

function readVercelConfig(): VercelConfig {
  return JSON.parse(fs.readFileSync(vercelConfigPath, "utf8")) as VercelConfig;
}

/**
 * Vercel evaluates rewrites in declaration order and the first match wins.
 * This compiles the `source` patterns of the shipped `vercel.json` so the tests
 * assert the configuration that will actually be deployed.
 *
 * Only the subset of the pattern syntax this project uses is supported: literal
 * text and `:name(<pattern>)` parameters. An unsupported pattern throws instead
 * of being silently read as a literal, so a future rewrite cannot quietly slip
 * past these tests.
 */
function compileSource(source: string): RegExp {
  let pattern = "";
  let index = 0;

  while (index < source.length) {
    if (source[index] !== ":") {
      pattern += source[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
      continue;
    }

    const parameter = /^:([A-Za-z0-9_]+)\(/.exec(source.slice(index));
    assert.ok(parameter, `Unsupported rewrite source: ${source}`);

    // Scan to the matching closing parenthesis so a pattern that contains its
    // own parentheses, such as a negative lookahead, survives intact.
    const openParenIndex = index + parameter[0].length - 1;
    let depth = 0;
    let closingIndex = openParenIndex;
    for (; closingIndex < source.length; closingIndex += 1) {
      if (source[closingIndex] === "(") {
        depth += 1;
      } else if (source[closingIndex] === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    assert.equal(depth, 0, `Unbalanced parentheses in rewrite source: ${source}`);

    const inner = source.slice(openParenIndex + 1, closingIndex);
    pattern += `(?<${parameter[1]}>${inner})`;
    index = closingIndex + 1;
  }

  return new RegExp(`^${pattern}$`);
}

/**
 * Removes comments so a static assertion cannot match prose. The entrypoint
 * explains in comments why it must not call `listen()`, and that explanation
 * would otherwise trip a naive text search.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/** Resolve a request path the way Vercel would: first matching rewrite wins. */
function resolveDestination(requestPath: string): string | undefined {
  for (const rewrite of readVercelConfig().rewrites ?? []) {
    if (compileSource(rewrite.source).test(requestPath)) {
      return rewrite.destination;
    }
  }
  return undefined;
}

interface NodeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a script in a child Node process so importing a module for real cannot
 * leave a listening socket or an open pool handle inside the test runner.
 */
function runNode(script: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<NodeRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", script],
      {
        cwd: repoRoot,
        env: { ...process.env, ...extraEnv },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number" && !error.killed) {
          reject(error);
          return;
        }
        resolve({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
          timedOut: Boolean(error?.killed),
        });
      }
    );
  });
}

/**
 * Keeps the child processes away from any real database. The values are not
 * configuration under test, only a guarantee that nothing here can connect,
 * migrate or seed anything. `DATABASE_URL` is blanked so the discrete
 * variables are used, and `NODE_ENV` avoids the test-suite database guard.
 */
const offlineEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "",
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "1",
  DATABASE_NAME: "vercel_entrypoint_offline_probe",
  DATABASE_USER: "vercel_entrypoint_offline_probe",
  DATABASE_PASSWORD: "vercel_entrypoint_offline_probe",
  DATABASE_SSL: "false",
};

test("one project builds both workspaces and serves the existing Vite output directory", () => {
  const config = readVercelConfig();

  assert.equal(config.buildCommand, "npm run build");
  assert.equal(config.outputDirectory, "frontend/dist");
  assert.equal(
    config.framework,
    null,
    "Framework auto-detection would look for a Vite app at the repository root."
  );

  const viteConfig = fs.readFileSync(viteConfigPath, "utf8");
  assert.doesNotMatch(
    viteConfig,
    /outDir/,
    "Vite must keep its default output directory for vercel.json to stay correct."
  );

  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  ) as { scripts: { build: string } };
  assert.match(rootPackage.scripts.build, /backend/);
  assert.match(rootPackage.scripts.build, /frontend/);
});

test("the API rewrite is declared before the SPA fallback", () => {
  const rewrites = readVercelConfig().rewrites ?? [];
  const apiRewriteIndex = rewrites.findIndex((rewrite) => rewrite.destination === "/api");
  const spaRewriteIndex = rewrites.findIndex(
    (rewrite) => rewrite.destination === "/index.html"
  );

  assert.ok(apiRewriteIndex >= 0, "vercel.json must declare a rewrite to the Express function.");
  assert.ok(spaRewriteIndex >= 0, "vercel.json must declare an SPA fallback rewrite.");
  assert.ok(
    apiRewriteIndex < spaRewriteIndex,
    "Rewrites are first-match-wins, so the API rewrite has to come first."
  );
});

for (const apiPath of API_PATHS) {
  test(`routes ${apiPath} to the Express function instead of the SPA entrypoint`, () => {
    assert.equal(resolveDestination(apiPath), "/api");
  });
}

test("/api/health cannot be rewritten to /index.html", () => {
  assert.notEqual(resolveDestination("/api/health"), "/index.html");
});

test("no rewrite sends an /api path to the SPA entrypoint", () => {
  for (const rewrite of readVercelConfig().rewrites ?? []) {
    const pattern = compileSource(rewrite.source);
    for (const apiPath of API_PATHS) {
      if (!pattern.test(apiPath)) {
        continue;
      }
      assert.notEqual(
        rewrite.destination,
        "/index.html",
        `Rewrite "${rewrite.source}" would swallow ${apiPath}.`
      );
    }
  }
});

for (const spaPath of SPA_PATHS) {
  test(`serves the SPA entrypoint for ${spaPath}`, () => {
    assert.equal(resolveDestination(spaPath), "/index.html");
  });
}

test("vercel.json contains no secrets and no production environment values", () => {
  const raw = fs.readFileSync(vercelConfigPath, "utf8");

  for (const forbidden of [
    "postgres://",
    "postgresql://",
    "DATABASE_URL",
    "WEBAUTHN",
    "SECRET",
  ]) {
    assert.ok(
      !raw.includes(forbidden),
      `vercel.json must not contain ${forbidden}; the Vercel environment provides it.`
    );
  }

  const config = readVercelConfig();
  assert.equal(config.env, undefined, "Environment values belong in Vercel, not in vercel.json.");
  assert.equal(config.build, undefined);
});

test("the Vercel entrypoint never calls listen and never loads the local entrypoint", () => {
  const code = stripComments(fs.readFileSync(vercelEntryPointPath, "utf8"));

  assert.doesNotMatch(code, /\.listen\s*\(/);
  assert.doesNotMatch(code, /"index\.js"/);
  assert.doesNotMatch(code, /checkDatabaseConnection/);
});

test("the Vercel function exports the Express app without listening, migrating or seeding", async () => {
  assert.ok(
    fs.existsSync(backendDistAppPath),
    "backend/dist/app.js is missing. Run `npm run build` at the repository root first."
  );

  const script = [
    `const loaded = require(${JSON.stringify(vercelEntryPointPath)});`,
    "const app = loaded && loaded.default ? loaded.default : loaded;",
    "const loadedModules = Object.keys(require.cache).map((p) => p.replace(/\\\\/g, '/'));",
    'const names = loadedModules.map((p) => p.split("/").pop());',
    'console.log("PROBE " + JSON.stringify({',
    "  isFunction: typeof app === 'function',",
    "  hasListen: typeof app === 'function' && typeof app.listen === 'function',",
    // The local entrypoint is identified by its exact compiled path. Comparing
    // basenames alone would match any index.js in the backend tree.
    `  loadedLocalEntrypoint: loadedModules.indexOf(${JSON.stringify(
      backendDistIndexPath.replace(/\\/g, "/")
    )}) !== -1,`,
    `  startupModules: names.filter((n) => ${STARTUP_MODULE_PATTERN.toString()}.test(n)),`,
    "}));",
  ].join("\n");

  const result = await runNode(script, offlineEnv);

  assert.equal(
    result.timedOut,
    false,
    "Importing the Vercel entrypoint kept the process alive, so it opened a socket."
  );
  assert.equal(result.code, 0, `Import failed:\n${result.stderr}`);

  const probeLine = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("PROBE "))
    .pop();
  assert.ok(probeLine, `The probe did not report a result:\n${result.stdout}`);

  const probe = JSON.parse(probeLine.slice("PROBE ".length)) as {
    isFunction: boolean;
    hasListen: boolean;
    loadedLocalEntrypoint: boolean;
    startupModules: string[];
  };

  assert.equal(probe.isFunction, true, "Vercel needs a (req, res) handler.");
  assert.equal(probe.hasListen, true, "The exported app must be the Express application.");
  assert.equal(
    probe.loadedLocalEntrypoint,
    false,
    "Loading backend/dist/index.js would run app.listen() inside the function."
  );
  assert.deepEqual(
    probe.startupModules,
    [],
    "The function must not load migration, seed, reset or cleanup modules."
  );

  assert.doesNotMatch(result.stdout, /API listening on/);
  assert.doesNotMatch(result.stdout + result.stderr, /Database connection (established|Unable)/);
});

test("the local entrypoint still binds with app.listen using HOST and PORT", async () => {
  assert.ok(
    fs.existsSync(backendDistIndexPath),
    "backend/dist/index.js is missing. Run `npm run build` at the repository root first."
  );

  const script = [
    `const { app } = require(${JSON.stringify(backendDistAppPath)});`,
    "let listenCall = null;",
    "app.listen = (port, host, callback) => {",
    "  listenCall = [port, host];",
    "  if (typeof callback === 'function') callback();",
    "  return { close() {}, on() {} };",
    "};",
    `require(${JSON.stringify(backendDistIndexPath)});`,
    'console.log("LISTEN_CALL " + JSON.stringify(listenCall));',
  ].join("\n");

  const result = await runNode(script, { ...offlineEnv, HOST: "127.0.0.1", PORT: "5099" });

  assert.equal(result.code, 0, `Local entrypoint failed:\n${result.stderr}`);
  assert.match(result.stdout, /LISTEN_CALL \[5099,"127\.0\.0\.1"\]/);
  assert.match(
    result.stdout,
    /OOU Attendance System API listening on http:\/\/127\.0\.0\.1:5099 \(loopback only\)\./
  );
});

test("the startup database connectivity check stays with the local entrypoint", () => {
  const localSource = fs.readFileSync(backendSourceEntryPointPath, "utf8");

  assert.match(localSource, /app\.listen\(/);
  assert.match(localSource, /checkDatabaseConnection/);
  assert.match(localSource, /SELECT 1/);
  assert.doesNotMatch(
    stripComments(fs.readFileSync(vercelEntryPointPath, "utf8")),
    /checkDatabaseConnection|SELECT 1/
  );
});
