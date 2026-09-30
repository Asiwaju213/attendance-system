export const TEST_DATABASE_NAME = "oou_attendance_test";

const TEST_DATABASE_NAME_PATTERN = /^oou_attendance_test(?:_[a-z0-9]+)*$/;

export function getTestDatabaseName(): string {
  const databaseName = process.env.TEST_DATABASE_NAME ?? TEST_DATABASE_NAME;
  if (!TEST_DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Invalid test database name: "${databaseName}".`);
  }
  return databaseName;
}

export function configureTestDatabase(): void {
  const databaseName = getTestDatabaseName();
  process.env.NODE_ENV = "test";
  process.env.TEST_DATABASE_NAME = databaseName;
  process.env.DATABASE_NAME = databaseName;
}

export function assertTestDatabaseEnvironment(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test database access requires NODE_ENV=test.");
  }

  const databaseName = getTestDatabaseName();
  if (process.env.DATABASE_NAME !== databaseName) {
    throw new Error(
      `Refusing test database access: DATABASE_NAME must be "${databaseName}".`
    );
  }
}
