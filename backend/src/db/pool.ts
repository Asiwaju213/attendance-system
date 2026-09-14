import { Pool } from "pg";
import { dbConfig } from "../config/env";

export const pool = new Pool(dbConfig);

pool.on("error", (error) => {
  console.error("Unexpected error on idle database client.", error.message);
});