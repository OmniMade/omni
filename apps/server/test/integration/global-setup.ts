import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";

/**
 * One PostgreSQL container for the whole integration run; each test file
 * gets its own database inside it (see startTestServer).
 *
 * testcontainers v12 ships GenericContainer only — the postgres image is
 * driven via env vars and the classic "ready to accept connections" log wait
 * (second occurrence: post-initdb final start).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const container: StartedTestContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_USER: "omni",
      POSTGRES_PASSWORD: "omni-test",
      POSTGRES_DB: "omni",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const base = `postgres://omni:omni-test@${container.getHost()}:${container.getMappedPort(5432)}`;
  process.env.OMNI_TEST_PG_BASE = base;

  return async () => {
    await container.stop();
  };
}
