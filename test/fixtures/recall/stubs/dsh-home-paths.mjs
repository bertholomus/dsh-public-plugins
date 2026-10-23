/** DSH's data folder for a test: RECALL_TEST_DSH_HOME. */
import { join } from 'node:path';

export const resolveDshHome = () => process.env.RECALL_TEST_DSH_HOME;
export const dshHomePath = (...parts) => join(process.env.RECALL_TEST_DSH_HOME, ...parts);
