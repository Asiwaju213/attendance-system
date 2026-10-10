// Import order matters: `./app` pulls in `config/env`, which calls `dotenv.config()`.
// Only after that is `.env` loaded does `config/server` read HOST and PORT below.
import type { Server } from "node:http";
import { app } from "./app";
import { describeStudentAccessConfig, studentAccessConfig } from "./config/access";
import {
  describeServerConfig,
  isLoopbackHost,
  serverConfig,
} from "./config/server";
import { pool } from "./db/pool";
import { maybePublishMasterDataOnStartup } from "./services/syncMasterDataBackfill";
import { startSyncWorker, stopSyncWorker } from "./services/syncWorker";

const { host, port } = serverConfig;

const server: Server = app.listen(port, host, () => {
  console.log(describeServerConfig(serverConfig));
  // Which deployment this process is, and therefore whether it serves students. Logged next to
  // the bind address because "students cannot sign in" is otherwise a puzzling symptom.
  console.log(describeStudentAccessConfig(studentAccessConfig));
  if (isLoopbackHost(host)) {
    console.log(
      "Set HOST=0.0.0.0 in backend/.env to make the API reachable from the local network."
    );
  }
});

/**
 * Start the local cloud sync worker, if this deployment is configured as an edge.
 *
 * Called AFTER the listener is up and never awaited, for two reasons: a PC with no
 * Internet must still finish starting up and serve students on the K12 LAN, and
 * the worker must never be able to delay or fail application startup.
 *
 * On the cloud deployment this is a no-op, because the cloud is the provider and
 * does not set SYNC_ENABLED.
 */
startSyncWorker();

/**
 * Publish the provider's current master data into the feed once, if this
 * deployment is a cloud/provider.
 *
 * Also never awaited and never able to fail startup: it is a maintenance step
 * (marker-guarded, exactly-once, idempotent) whose failure is logged and retried
 * on the next startup, exactly as the edge worker's own first tick behaves.
 */
void maybePublishMasterDataOnStartup();

async function checkDatabaseConnection() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connection established.");
  } catch (error) {
    console.error(
      "Unable to connect to the database.",
      (error as Error).message
    );
  }
}

checkDatabaseConnection();

/**
 * Stop the background worker and release resources on SIGINT/SIGTERM.
 *
 * The repository previously had no signal handling and discarded the http.Server,
 * so this adds both: the worker gets a clean stop instead of dying mid-transaction
 * (which the cursor design would recover from anyway, but an orderly stop is
 * cheaper), and the database pool is closed so the process can exit promptly
 * instead of waiting out its idle timeout.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down.`);

  stopSyncWorker();

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  try {
    await pool.end();
  } catch (error) {
    console.error(
      "Error while closing the database pool.",
      (error as Error).message
    );
  }

  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}