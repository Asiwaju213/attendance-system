import { Pool } from "pg";
import { databaseSource, dbConfig, dbPoolSettings } from "../config/env";

console.log(
  `PostgreSQL pool initialised from ${databaseSource} configuration (max ${dbPoolSettings.max} per instance).`
);

export const pool = new Pool({ ...dbConfig, ...dbPoolSettings });

pool.on("error", (error) => {
  console.error("Unexpected error on idle database client.", error.message);
});