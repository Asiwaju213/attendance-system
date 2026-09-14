import { app } from "./app";
import { pool } from "./db/pool";

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
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