import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * One Postgres and one Redis container for the whole integration run.
 *
 * Vitest's `forks` pool gives every spec file its own process, so a `beforeAll` container
 * would be started once PER FILE — minutes of container churn for seconds of assertions.
 * Starting them here and handing the URLs down through the environment keeps it to one each.
 */
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
  ]);
  process.env.COLLAB_TEST_PG_URL = postgres.getConnectionUri();
  process.env.COLLAB_TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
}
