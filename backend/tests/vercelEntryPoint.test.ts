import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Vercel deploys the static React frontend only; the Express API runs on Render.
 *
 * The file name is historical: this suite used to guard a Vercel serverless
 * entrypoint at `api/index.js`, which no longer exists. What it guards now is
 * the inverse invariant, so a later change cannot quietly bring the backend
 * back onto Vercel:
 *
 * 1. `api/index.js` must not exist. If it reappears, Vercel deploys an Express
 *    function that has no database environment variables and every `/api/*`
 *    request fails with a 500.
 * 2. The Vercel build must compile only the frontend. Building the backend
 *    there is dead work at best, and a slow or failing backend build breaks a
 *    deployment that has no reason to care about it.
 * 3. `/api/*` must proxy to an external Render origin with the `/api` prefix
 *    and the full sub-path preserved, so the browser keeps talking to the
 *    canonical Vercel origin and needs no CORS.
 * 4. The SPA fallback must never swallow `/api/*` or `/assets/*`.
 *
 * The Render hostname is deliberately a placeholder until the service exists,
 * so these tests assert the *shape* of the destination (https, the
 * `.onrender.com` domain, the preserved `/api` prefix and the matching path
 * parameter) rather than a specific hostname. They therefore stay green both
 * before and after the real hostname is substituted, and they never attempt a
 * network request.
 */

/** The repository root, so the paths below do not depend on the current directory. */
const repoRoot = path.resolve(__dirname, "..", "..");

const vercelConfigPath = path.join(repoRoot, "vercel.json");
const apiDirectoryPath = path.join(repoRoot, "api");
const apiEntryPointPath = path.join(repoRoot, "api", "index.js");
const backendDistIndexPath = path.join(repoRoot, "backend", "dist", "index.js");
const backendSourceEntryPointPath = path.join(repoRoot, "backend", "src", "index.ts");
const frontendClientPath = path.join(repoRoot, "frontend", "src", "api", "client.ts");
const viteConfigPath = path.join(repoRoot, "frontend", "vite.config.ts");
const builtHtmlPath = path.join(repoRoot, "frontend", "dist", "index.html");

interface VercelRewrite {
  source: string;
  destination: string;
}

interface VercelConfig {
  framework?: string | null;
  buildCommand?: string;
  outputDirectory?: string;
  rewrites?: VercelRewrite[];
  functions?: unknown;
  env?: Record<string, unknown>;
  build?: Record<string, unknown>;
}

/**
 * API paths that must always reach the Render backend. `/api/health` is first
 * because it is the cheapest way to notice that the SPA fallback has swallowed
 * the API, and because it is the probe the LAN and local checks depend on.
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

function readVercelConfig(): VercelConfig {
  return JSON.parse(fs.readFileSync(vercelConfigPath, "utf8")) as VercelConfig;
}

/** Every TypeScript source file under a directory, for whole-tree assertions. */
function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * A destination template the test requires for the API proxy. It names no
 * specific service, so swapping in the real Render hostname later does not
 * require touching this suite.
 */
const EXTERNAL_RENDER_DESTINATION = /^https:\/\/[a-z0-9][a-z0-9.-]*\.onrender\.com\/api\/(.*)$/;

function apiRewrite(): VercelRewrite {
  const rewrites = readVercelConfig().rewrites ?? [];
  const rewrite = rewrites.find((candidate) => candidate.source.startsWith("/api"));
  assert.ok(rewrite, "vercel.json must declare a rewrite for /api.");
  return rewrite;
}

/**
 * Vercel evaluates rewrites in declaration order and the first match wins.
 *
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

/** Names of the `:name(...)` parameters a rewrite source declares. */
function sourceParameters(source: string): string[] {
  return Array.from(source.matchAll(/:([A-Za-z0-9_]+)\(/g)).map((match) => match[1]);
}

/**
 * Substitutes a path parameter into a destination template the way Vercel does
 * at request time, so a test can assert the URL a browser would actually be
 * sent to rather than only the shape of the template.
 */
function resolveDestinationUrl(requestPath: string): URL | undefined {
  for (const rewrite of readVercelConfig().rewrites ?? []) {
    const match = compileSource(rewrite.source).exec(requestPath);
    if (!match) {
      continue;
    }

    const substituted = rewrite.destination.replace(
      /:([A-Za-z0-9_]+)[*+]?/g,
      (_token, name: string) => match.groups?.[name] ?? ""
    );
    return new URL(substituted);
  }

  return undefined;
}

/** The rewrite destination template that a given request path selects. */
function resolveDestination(requestPath: string): string | undefined {
  for (const rewrite of readVercelConfig().rewrites ?? []) {
    if (compileSource(rewrite.source).test(requestPath)) {
      return rewrite.destination;
    }
  }
  return undefined;
}

/**
 * Removes comments so a static assertion cannot match prose in a file that
 * explains why it does *not* use a given setting.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

test("Vercel deploys no serverless function", () => {
  assert.equal(
    fs.existsSync(apiEntryPointPath),
    false,
    "api/index.js must not exist. It would make Vercel deploy an Express function " +
      "that has no database environment variables."
  );

  assert.equal(
    fs.existsSync(apiDirectoryPath),
    false,
    "The api/ directory must not exist. Any file inside it is a Vercel function entrypoint."
  );

  const config = readVercelConfig();
  assert.equal(
    config.functions,
    undefined,
    "vercel.json must not declare a functions map; Vercel hosts static files only."
  );
});

test("the Vercel build compiles the frontend only", () => {
  const config = readVercelConfig();

  assert.equal(config.buildCommand, "npm run build --workspace frontend");
  assert.doesNotMatch(
    config.buildCommand ?? "",
    /\bbackend\b/,
    "The backend is built by Render, not by Vercel."
  );

  // The root build stays as it is: it is what local and LAN development runs,
  // and Render needs both workspaces available in the repository.
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  ) as { scripts: { build: string } };
  assert.match(rootPackage.scripts.build, /backend/);
  assert.match(rootPackage.scripts.build, /frontend/);
});

test("the frontend is served from frontend/dist and no framework is detected", () => {
  const config = readVercelConfig();

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
});

test("/api/* proxies to an external Render origin that preserves the /api prefix", () => {
  const rewrite = apiRewrite();
  const match = EXTERNAL_RENDER_DESTINATION.exec(rewrite.destination);

  assert.ok(
    match,
    `The /api destination must be https://<service>.onrender.com/api/... but was "${rewrite.destination}". ` +
      "Dropping the /api prefix would break every backend route."
  );
  assert.match(
    match[1],
    /:([A-Za-z0-9_]+)\*/,
    "The destination must forward the remaining path with a wildcard parameter."
  );

  const forwarded = sourceParameters(rewrite.source);
  for (const parameter of match[1].matchAll(/:([A-Za-z0-9_]+)\*/g)) {
    assert.ok(
      forwarded.includes(parameter[1]),
      `The destination references ":${parameter[1]}" but the source does not declare it, ` +
        "so the sub-path would be dropped."
    );
  }
});

test("/api/* is not routed back to a Vercel function", () => {
  for (const rewrite of readVercelConfig().rewrites ?? []) {
    assert.notEqual(
      rewrite.destination,
      "/api",
      `The rewrite "${rewrite.source}" targets a Vercel function at /api. ` +
        "The API runs on Render and must be reached by absolute URL."
    );
  }
});

for (const apiPath of API_PATHS) {
  test(`proxies ${apiPath} to Render with its path intact`, () => {
    const destination = resolveDestination(apiPath);
    assert.ok(destination, `No rewrite matches ${apiPath}.`);

    assert.notEqual(
      destination,
      "/index.html",
      `The SPA fallback swallowed ${apiPath}; the frontend would silently lose every request.`
    );
    assert.match(
      destination,
      /^https:\/\//,
      `${apiPath} must reach an external Render origin, not a same-project path.`
    );

    const url = resolveDestinationUrl(apiPath);
    assert.ok(url, `Could not resolve ${apiPath} to a URL.`);
    assert.equal(url.pathname, apiPath, `${apiPath} lost its prefix or sub-path.`);
    assert.match(url.hostname, /\.onrender\.com$/);
  });
}

test("the API rewrite is declared before the SPA fallback", () => {
  const rewrites = readVercelConfig().rewrites ?? [];
  const apiRewriteIndex = rewrites.findIndex((rewrite) =>
    EXTERNAL_RENDER_DESTINATION.test(rewrite.destination)
  );
  const spaRewriteIndex = rewrites.findIndex(
    (rewrite) => rewrite.destination === "/index.html"
  );

  assert.ok(apiRewriteIndex >= 0, "vercel.json must declare the external Render API rewrite.");
  assert.ok(spaRewriteIndex >= 0, "vercel.json must declare an SPA fallback rewrite.");
  assert.ok(
    apiRewriteIndex < spaRewriteIndex,
    "Rewrites are first-match-wins, so the API rewrite has to come first."
  );
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

test("built frontend assets are excluded from the SPA fallback", () => {
  assert.ok(
    fs.existsSync(builtHtmlPath),
    "frontend/dist/index.html is missing. Run `npm run build --workspace frontend` first."
  );

  // The real asset names are read out of the generated HTML rather than
  // hardcoded, so a Vite hash change cannot leave this test asserting a path
  // that no longer exists.
  const html = fs.readFileSync(builtHtmlPath, "utf8");
  const assetPaths = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)).map(
    (match) => match[1]
  );

  assert.ok(assetPaths.length > 0, "Expected the built HTML to reference hashed /assets/ files.");

  for (const assetPath of assetPaths) {
    assert.equal(
      resolveDestination(assetPath),
      undefined,
      `${assetPath} must be served from the build output, not rewritten to index.html.`
    );
  }
});

for (const spaPath of SPA_PATHS) {
  test(`serves the SPA entrypoint for ${spaPath}`, () => {
    assert.equal(resolveDestination(spaPath), "/index.html");
  });
}

test("the frontend keeps calling the API on its own origin", () => {
  const client = stripComments(fs.readFileSync(frontendClientPath, "utf8"));

  assert.match(
    client,
    /fetch\(\s*`\/api\$\{/,
    "The frontend must request relative /api paths so the browser stays on the Vercel origin."
  );
  assert.match(
    client,
    /credentials:\s*"include"/,
    "Session cookies must still be sent with every API request."
  );
  assert.doesNotMatch(
    client,
    /https?:\/\//,
    "The frontend must not hard-code the Render origin; the proxy hides it."
  );
  assert.doesNotMatch(
    client,
    /VITE_API_(URL|BASE)/,
    "A production API base URL is not needed while requests stay same-origin."
  );
});

test("the project adds no CORS to work around the proxy", () => {
  const backendSources = collectFiles(path.join(repoRoot, "backend", "src"));
  const offending = backendSources.filter((file) =>
    /\bfrom\s+["']cors["']|Access-Control-Allow-Origin/.test(
      stripComments(fs.readFileSync(file, "utf8"))
    )
  );

  assert.deepEqual(
    offending,
    [],
    "Requests are same-origin through the Vercel rewrite, so CORS must not be enabled."
  );
});

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
      `vercel.json must not contain ${forbidden}; the backend environment provides it.`
    );
  }

  const config = readVercelConfig();
  assert.equal(
    config.env,
    undefined,
    "Environment values belong in Render and in Vercel's own settings, not in vercel.json."
  );
  assert.equal(config.build, undefined);
});

interface NodeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a script in a child Node process so requiring a module for real cannot
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
 * Keeps the child process away from any real database. These values are not
 * configuration under test, only a guarantee that nothing here can connect,
 * migrate or seed anything.
 */
const offlineEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "",
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "1",
  DATABASE_NAME: "vercel_static_frontend_offline_probe",
  DATABASE_USER: "vercel_static_frontend_offline_probe",
  DATABASE_PASSWORD: "vercel_static_frontend_offline_probe",
  DATABASE_SSL: "false",
};

test("the backend entrypoint still binds a socket for Render", async () => {
  assert.ok(
    fs.existsSync(backendDistIndexPath),
    "backend/dist/index.js is missing. Run `npm run build --workspace backend` first."
  );

  const script = [
    `const { app } = require(${JSON.stringify(
      path.join(repoRoot, "backend", "dist", "app.js")
    )});`,
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

  assert.equal(result.code, 0, `Backend entrypoint failed:\n${result.stderr}`);
  assert.match(result.stdout, /LISTEN_CALL \[5099,"127\.0\.0\.1"\]/);
});

test("the startup database check stays a non-destructive SELECT 1 on the backend entrypoint", () => {
  const localSource = fs.readFileSync(backendSourceEntryPointPath, "utf8");

  assert.match(localSource, /app\.listen\(/);
  assert.match(localSource, /checkDatabaseConnection/);
  assert.match(localSource, /SELECT 1/);
});
