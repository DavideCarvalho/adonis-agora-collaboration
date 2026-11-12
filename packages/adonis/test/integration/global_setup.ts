import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * One Postgres, one MySQL and one Redis container for the whole integration run.
 *
 * Vitest's `forks` pool gives every spec file its own process, so a `beforeAll` container
 * would be started once PER FILE — minutes of container churn for seconds of assertions.
 * Starting them here and handing the URLs down through the environment keeps it to one each.
 */
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;
let mysql: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  [postgres, redis, mysql] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start(),
    // MySQL logs "ready for connections" once for its init server and again when it is up for good.
    new GenericContainer('mysql:8.4')
      .withEnvironment({ MYSQL_ROOT_PASSWORD: 'collab', MYSQL_DATABASE: 'app' })
      .withExposedPorts(3306)
      .withWaitStrategy(Wait.forLogMessage(/ready for connections.*port: 3306/))
      .withStartupTimeout(180_000)
      .start(),
  ]);
  process.env.COLLAB_TEST_PG_URL = postgres.getConnectionUri();
  process.env.COLLAB_TEST_MYSQL_URL = `mysql://root:collab@${mysql.getHost()}:${mysql.getMappedPort(3306)}/app`;
  process.env.COLLAB_TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop(), mysql?.stop()]);
}
