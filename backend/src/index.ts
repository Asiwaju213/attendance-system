// Import order matters: `./app` pulls in `config/env`, which calls `dotenv.config()`.
// Only after that is `.env` loaded does `config/server` read HOST and PORT below.
import { app } from "./app";
import {
  describeServerConfig,
  isLoopbackHost,
  serverConfig,
} from "./config/server";
import { pool } from "./db/pool";

const { host, port } = serverConfig;

app.listen(port, host, () => {
  console.log(describeServerConfig(serverConfig));
  if (isLoopbackHost(host)) {
    console.log(
      "Set HOST=0.0.0.0 in backend/.env to make the API reachable from the local network."
    );
  }
});

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
