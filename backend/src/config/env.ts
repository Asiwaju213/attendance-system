import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requirePort(name: string): number {
  const value = requireEnv(name);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid value for ${name}: "${value}"`);
  }
  return port;
}

export const dbConfig = {
  host: requireEnv("DATABASE_HOST"),
  port: requirePort("DATABASE_PORT"),
  database: requireEnv("DATABASE_NAME"),
  user: requireEnv("DATABASE_USER"),
  password: requireEnv("DATABASE_PASSWORD"),
};