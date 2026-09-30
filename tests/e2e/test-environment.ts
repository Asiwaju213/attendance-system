const DEFAULT_TEST_DATABASE_NAME = "oou_attendance_test";
const TEST_DATABASE_NAME_PATTERN = /^oou_attendance_test(?:_[a-z0-9]+)*$/;

const testDatabaseName =
  process.env.TEST_DATABASE_NAME ?? DEFAULT_TEST_DATABASE_NAME;

if (!TEST_DATABASE_NAME_PATTERN.test(testDatabaseName)) {
  throw new Error(`Invalid test database name: "${testDatabaseName}".`);
}

export function testEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return {
    ...environment,
    NODE_ENV: "test",
    TEST_DATABASE_NAME: testDatabaseName,
    DATABASE_NAME: testDatabaseName,
  };
}
